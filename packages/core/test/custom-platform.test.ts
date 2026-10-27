/**
 * 自定义平台（配置驱动的适配器）与内置平台的**等价性**。
 *
 * 这个文件守的是一条承诺：用户点「启用为平台」之后，这个平台在 App 里的表现
 * 必须和超星 / iSmart 一模一样 —— 课程页、待办、按课程筛选、改名、提醒，
 * 全都走同一条链路，不能有"能用一半"的形态。
 *
 * 真机故障（2026-10-27 报的）：加了自定义平台后，**课程页显示"这个账号下还没有课程"，
 * 但待办里已经有作业了**。这两个界面读的是同一份库的两个表 —— 只有一种可能：
 * 任务写进去了、课程没写进去。原因见 declarative-adapter.ts 的 capabilities：
 * `courses: false` 是写死的，而引擎只在 `capabilities.courses` 为真时才调用
 * fetchCourses（sync-engine.ts 的 shouldRefreshCourses）—— 于是 fetchCourses
 * 这段**已经写好**的代码从来没被执行过，课程表永远是空的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry,
  SyncEngine,
  MemoryStore,
  EncryptedVault,
  StaticKeyProvider,
  createSilentLogger,
  systemClock,
  DeclarativeAdapter,
  canMarkCompleted,
} from '../src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/index.ts';

const ORIGIN = 'https://demo.example.com';

/** 一个只认路由的假平台：课程 2 门、作业 2 条（分属两门课）。 */
function fakePlatform(now: number): HttpClient {
  const routes: Record<string, unknown> = {
    [`${ORIGIN}/api/courses`]: {
      data: [
        { id: 'c1', name: '高等数学' },
        { id: 'c2', name: '线性代数' },
      ],
    },
    [`${ORIGIN}/api/tasks`]: {
      data: [
        { id: 't1', title: '第一章习题', courseId: 'c1', courseName: '高等数学', endAt: now + 86_400_000, status: '未完成' },
        { id: 't2', title: '矩阵作业', courseId: 'c2', courseName: '线性代数', endAt: now + 172_800_000, status: '未完成' },
      ],
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async request(req: HttpRequest): Promise<HttpResponse> {
      const key = req.url.split('?')[0]!;
      const body = routes[key];
      if (body === undefined) {
        return {
          status: 404,
          headers: { 'content-type': 'text/plain' },
          url: req.url,
          setCookies: [],
          text: async () => `no route: ${key}`,
          json: async <T,>() => ({}) as T,
          bytes: async () => new Uint8Array(),
        };
      }
      const text = JSON.stringify(body);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        url: req.url,
        setCookies: [],
        text: async () => text,
        json: async <T,>() => JSON.parse(text) as T,
        bytes: async () => new TextEncoder().encode(text),
      };
    },
  };
}

const CONFIG = {
  key: 'demo',
  name: '演示平台',
  origin: ORIGIN,
  courses: { url: '/api/courses', listPath: '$.data', idField: 'id', nameField: 'name' },
  tasks: { url: '/api/tasks', listPath: '$.data' },
  fields: {
    id: { path: 'id' },
    title: { path: 'title' },
    deadline: { path: 'endAt', format: 'epoch_ms' },
    course: { path: 'courseName' },
    status: { path: 'status' },
  },
};

async function setup(config: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-custom-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const adapter = new DeclarativeAdapter(config as never);
  const registry = new AdapterRegistry().register(adapter);
  const engine = new SyncEngine({
    registry,
    store,
    vault,
    http: fakePlatform(Date.now()),
    clock: systemClock,
    logger: createSilentLogger(),
  });
  await engine.registerOfflineAccount(adapter.id, 'web', {
    label: adapter.displayName,
    freshLogin: true,
    explicit: true,
  });
  const account = (await engine.listAccounts())[0]!;
  return { dir, engine, account, adapter };
}

describe('自定义平台：课程维度必须和内置平台等价', () => {
  it('配了课程接口 → 课程要真的落库，且作业按课程分开', async () => {
    const { dir, engine, account, adapter } = await setup(CONFIG);
    try {
      assert.equal(adapter.capabilities.courses, true, '配了课程接口就必须声明能拉课程，否则引擎根本不调用 fetchCourses');

      const report = await engine.syncAll({});
      assert.equal(report.totals.ok, 1, `同步应成功：${JSON.stringify(report.accounts.map((a) => a.message))}`);

      const courses = await engine.listCoursesWithState(account.id);
      assert.equal(courses.length, 2, `课程页应看到 2 门课，实际 ${courses.length} 门（用户报的就是这一条）`);
      assert.deepEqual(
        courses.map((c) => c.name).sort(),
        ['线性代数', '高等数学'],
      );

      const tasks = await engine.upcoming({ withinDays: 365 });
      assert.equal(tasks.length, 2);
      // 按课程筛选用的是 courseId —— 两条作业必须落在不同课程上，
      // 否则「点课程名只看这门课」会把所有作业混成一锅。
      assert.notEqual(tasks[0]!.courseId, tasks[1]!.courseId, '不同课程的作业不能共用一个 courseId');
      const idSet = new Set(courses.map((c) => c.id));
      for (const t of tasks) assert.ok(idSet.has(t.courseId), `作业 ${t.title} 的 courseId 在课程表里找不到`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('完全没配课程接口、任务行也没有课程名 → 也要有一条"这个平台"的课程记录，不能是空的课程页', async () => {
    // 最差的情况：平台没有课程接口，作业行里也看不出课程。
    // 这时不能留空 —— 课程页空白 + 待办有货 = 用户眼里的"数据不一致"，正是这次报的故障形态。
    const { dir, engine, account } = await setup({
      ...CONFIG,
      courses: undefined,
      fields: { ...CONFIG.fields, course: undefined },
    });
    try {
      await engine.syncAll({});
      const courses = await engine.listCoursesWithState(account.id);
      assert.equal(courses.length, 1, '至少要有一条兜底课程');
      assert.equal(courses[0]!.taskCount, 2, '兜底课程要把作业收进去，否则按课程筛选时它们是孤儿');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没有课程接口、但任务行带课程名 → 课程由任务投影出来', async () => {
    // 绝大多数平台属于这一档：没有干净的课程接口，但每条作业上都写着课程名。
    // 这是"通用"最重要的一条 —— 不需要额外交互，也能得到和内置平台一样的课程维度。
    const { dir, engine, account } = await setup({ ...CONFIG, courses: undefined });
    try {
      await engine.syncAll({});
      const courses = await engine.listCoursesWithState(account.id);
      assert.equal(courses.length, 2, `应按课程名投影出 2 门课，实际 ${courses.length}`);
      assert.ok(courses.every((c) => c.taskCount === 1), '每门课各收自己的那条作业');

      const tasks = await engine.upcoming({ withinDays: 365 });
      const idSet = new Set(courses.map((c) => c.id));
      for (const t of tasks) assert.ok(idSet.has(t.courseId), `作业 ${t.title} 挂到了一门不存在的课下`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没配状态字段 → 必须标成「平台沉默」，否则用户永远标不了已完成', async () => {
    // 「和内置平台等价」里最容易漏的一条：不配 status 时 mapStatus 一律返回 pending，
    // 若同时把 statusSource 当成 'platform'，「平台优先」规则就会认为平台明确说未完成，
    // 于是 canMarkCompleted=false —— 作业做完了点不动，永远留在待办里催。
    const { dir, engine } = await setup({
      ...CONFIG,
      courses: undefined,
      fields: { ...CONFIG.fields, status: undefined },
    });
    try {
      const report = await engine.syncAll({});
      assert.equal(report.totals.ok, 1);
      const tasks = await engine.upcoming({ withinDays: 365 });
      assert.equal(tasks.length, 2);
      for (const t of tasks) {
        assert.equal(t.statusSource, 'inferred', '没配状态字段就必须标成推断，不能替平台断言');
        assert.equal(canMarkCompleted(t), true, '标不动就等于这条作业永远清不掉');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
