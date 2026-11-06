/**
 * 任务点视图（`SyncEngine.listTaskPointProgress`）。
 *
 * 这组测试守的是「界面拿到的数据形状」—— 2026-11-02 真机出现过
 * 「任务点页签整个消失」，而不是显示错误。页签的显示条件是
 * `supported === true`，所以要么适配器能力没被认出来，要么这个端点抛了异常
 * （前端把异常吞掉了，页签就保持隐藏）。
 *
 * 所以这里断言两件事：
 *   1. 形状正确（含 nextWindow 透传）
 *   2. 任何情况下都不抛 —— UI 拿到的是状态，不是异常
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry,
  EncryptedVault,
  MemoryStore,
  StaticKeyProvider,
  SyncEngine,
  createSilentLogger,
  systemClock,
} from '../src/index.ts';
import { ChaoxingAdapter } from '../../adapters/chaoxing/src/index.ts';
import type { HttpClient } from '../src/index.ts';
import type { UnifiedCourse } from '../src/domain/course.ts';

const noHttp: HttpClient = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error('本测试不起 HTTP');
  },
};

async function makeEngine(store: MemoryStore, http: HttpClient = noHttp) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-tp-'));
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const registry = new AdapterRegistry();
  registry.register(new ChaoxingAdapter());
  const engine = new SyncEngine({
    registry,
    store,
    vault,
    http,
    clock: systemClock,
    logger: createSilentLogger(),
  });
  return { dir, engine, vault };
}

function course(id: string, taskPoints?: UnifiedCourse['taskPoints']): UnifiedCourse {
  return {
    id: `chaoxing:abc:${id}`,
    platformId: 'chaoxing',
    accountId: 'chaoxing::u1',
    platformCourseId: id,
    name: `课程 ${id}`,
    lastSeenAt: new Date().toISOString(),
    // 真实的课程记录一定带 raw（classId/cpi/enc 是拼任务点请求的参数）。
    // 缺了它适配器会静默跳过 —— 测试里不补这个字段，就等于在测一个不存在的场景。
    raw: { classId: `cls-${id}`, cpi: '487116507', enc: `enc-${id}` },
    ...(taskPoints ? { taskPoints } : {}),
  };
}

const ACCOUNT = {
  id: 'chaoxing::u1',
  platformId: 'chaoxing',
  label: '超星账号',
  username: 'u1',
  enabled: true,
  createdAt: new Date().toISOString(),
};

describe('任务点视图：形状与不崩', () => {
  it('账号不存在时返回 supported=false，不抛', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      const view = await engine.listTaskPointProgress('chaoxing::nobody');
      assert.equal(view.supported, false);
      assert.deepEqual(view.courses, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('超星适配器在列 → supported=true（页签靠它决定显示）', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      const view = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.equal(view.supported, true, '不支持的话整个任务点页签会被隐藏');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('课程的 taskPoints 原样透传，nextWindow 不能丢', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      await store.upsertCourses([
        course('c1', {
          total: 26,
          done: 0,
          fetchedAt: '2026-11-02T15:00:00.000Z',
          availableNow: 6,
          nextWindow: {
            chapter: '2.1 什么是真理？',
            opensAt: '2026-11-08T15:00:00.000Z',
            closesAt: '2026-11-29T15:00:00.000Z',
          },
        }),
        course('c2', { total: 6, done: 4, fetchedAt: '2026-11-02T15:00:00.000Z' }),
      ]);

      const view = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.equal(view.courses.length, 2);
      const c1 = view.courses.find((c) => c.platformCourseId === 'c1')!;
      assert.equal(c1.total, 26);
      assert.equal(c1.done, 0);
      assert.equal(c1.nextWindow?.chapter, '2.1 什么是真理？');
      assert.equal(c1.availableNow, 6, '「现在可做」的条数要透传到界面');
      assert.match(c1.courseUrl ?? '', /courseid=c1/, '任务点卡片要能点进这门课的课程页');
      // 没有窗口的课不能凭空多出一个 nextWindow 键
      const c2 = view.courses.find((c) => c.platformCourseId === 'c2')!;
      assert.equal('nextWindow' in c2, false);
      assert.equal('availableNow' in c2, false, '没有这个数据就不要造一个键');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没抓过任务点的课程不进列表（而不是给个 0/0）', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      await store.upsertCourses([course('c3')]);
      const view = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.deepEqual(view.courses, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshCourseProgress 对不支持该能力的平台直接返回 unsupported', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      // 用 mock 平台（没有 fetchCourseProgress）
      await store.upsertAccount({ ...ACCOUNT, id: 'mock::u1', platformId: 'mock' });
      const r = await engine.refreshCourseProgress('mock::u1');
      assert.equal(r.status, 'unsupported');
      assert.equal(r.updated, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 归零保护（2026-11-03 真机事故：同步一次之后任务点栏整页空白）。
 *
 * 触发路径：平台这一轮返回的页面**有目录骨架、但没有"已完成任务点"那句**
 * （半加载 / 需要重新登录 / 限流返回空壳）→ 适配器判定"这门课没有任务点"
 * → 写入 total=0 → 覆盖掉上一轮的好数据 → 界面上整页空白，且下一次还是 0。
 *
 * 判据：**"这一轮没读到"不等于"平台说没有"**。宁可信上一轮，
 * 也不要显示一个假的零 —— 假零会让人以为这门课做完了。
 */
const SKELETON_ONLY = '<div class="fanyaChapterWhite"><div class="chapter_head"></div></div>';

function htmlHttp(body: string, calls: string[] = []): HttpClient {
  return {
    async request(req) {
      calls.push(req.url);
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        url: req.url,
        setCookies: [],
        async text() {
          return body;
        },
        async json<T>() {
          return JSON.parse(body) as T;
        },
        async bytes() {
          return new TextEncoder().encode(body);
        },
      };
    },
  };
}

describe('任务点：归零保护', () => {
  it('本轮读不到任务点，但上一轮有数据 → 保留旧值，不写 0', async () => {
    const store = new MemoryStore();
    await store.init();
    const calls: string[] = [];
    const { dir, engine, vault } = await makeEngine(store, htmlHttp(SKELETON_ONLY, calls));
    try {
      await store.upsertAccount(ACCOUNT);
      await vault.save({
        platformId: 'chaoxing',
        accountId: ACCOUNT.id,
        origin: 'imported',
        cookies: {},
        headers: {},
        issuedAt: new Date().toISOString(),
      } as never);
      await store.upsertCourses([
        course('c1', { schema: 3, total: 26, done: 4, fetchedAt: '2026-11-02T15:00:00.000Z' }),
      ]);

      const r = await engine.refreshCourseProgress(ACCOUNT.id);
      assert.equal(r.status, 'ok');
      assert.equal(calls.length, 1, '真的去抓了一次');
      assert.match(r.detail ?? '', /已保留旧值/, '要在日志里说明为什么没写进去');

      const after = await store.listCourses([ACCOUNT.id]);
      assert.equal(after[0]!.taskPoints?.total, 26, '总任务点数不能被 0 覆盖');
      assert.equal(after[0]!.taskPoints?.done, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('首次抓取读到 0 是正常结果（没有旧数据可保护）', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine, vault } = await makeEngine(store, htmlHttp(SKELETON_ONLY));
    try {
      await store.upsertAccount(ACCOUNT);
      await vault.save({
        platformId: 'chaoxing',
        accountId: ACCOUNT.id,
        origin: 'imported',
        cookies: {},
        headers: {},
        issuedAt: new Date().toISOString(),
      } as never);
      await store.upsertCourses([course('c1')]);

      const r = await engine.refreshCourseProgress(ACCOUNT.id);
      assert.equal(r.updated, 1, '第一次读到 0 也要写，否则永远没有基线');

      const after = await store.listCourses([ACCOUNT.id]);
      assert.equal(after[0]!.taskPoints?.total, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('视图里带诊断计数 —— 列表为空时要能说清为什么空', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      await store.upsertCourses([
        course('a', { schema: 3, total: 26, done: 4, fetchedAt: 'x' }),
        course('b'),
      ]);
      const view = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.equal(view.stats.courses, 2);
      assert.equal(view.stats.withData, 1, '只有一门有数据');
      assert.equal(view.stats.zeroed, 0);
      assert.equal(view.stats.hidden, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('任务点：手动隐藏某门课', () => {
  it('隐藏后不出现在视图里，但数据仍在（不用重抓就能恢复）', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      await store.upsertCourses([
        course('a', { schema: 3, total: 26, done: 4, fetchedAt: 'x' }),
        course('b', { schema: 3, total: 10, done: 0, fetchedAt: 'x' }),
      ]);

      const before = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.equal(before.courses.length, 2);

      assert.equal(await engine.setTaskPointHidden(ACCOUNT.id, 'chaoxing:abc:b', true), true);

      const after = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.deepEqual(after.courses.map((c) => c.platformCourseId), ['a']);
      assert.equal(after.stats.hiddenPoints, 1, '诊断里要说清有几门被手动隐藏');

      // 数据没被删：恢复显示时立刻回来（不需要等一轮抓取）
      const raw = await store.listCourses([ACCOUNT.id]);
      assert.ok(raw.find((c) => c.id === 'chaoxing:abc:b')?.taskPoints, '隐藏不等于丢数据');

      await engine.setTaskPointHidden(ACCOUNT.id, 'chaoxing:abc:b', false);
      const back = await engine.listTaskPointProgress(ACCOUNT.id);
      assert.equal(back.courses.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('隐藏与「不再同步」是两个维度：静音名单不会被它影响', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertAccount(ACCOUNT);
      await store.upsertCourses([course('a', { schema: 3, total: 5, done: 0, fetchedAt: 'x' })]);

      await engine.setTaskPointHidden(ACCOUNT.id, 'chaoxing:abc:a', true);
      const states = await engine.listCoursesWithState(ACCOUNT.id);
      assert.equal(states[0]!.taskPointHidden, true);
      assert.equal(states[0]!.muted, false, '隐藏任务点不能让这门课变成"不再同步"');
      assert.equal(states[0]!.hasTaskPoints, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 任务点的刷新节奏：跟着同步走，但**只在天级**。
 *
 * 作业是分钟级（新发布、临近截止），任务点是天级（老师改章节设置）。
 * 跟着每次同步抓 = 把分钟级的动作塞进天级成本（一天同步 8 次 = 256 个请求）。
 * 所以同步之后只做一件事：**看看过期没**，过期才真的抓。
 */
describe('任务点：过期才抓 + 并发锁', () => {
  const OK_HTML = `<h2 class="xs_head_name"><i class="catalog_points_yi fl"></i> 已完成任务点: <span>4</span>/26 </h2>`;

  async function seeded(fetchedAt: string) {
    const store = new MemoryStore();
    await store.init();
    const calls: string[] = [];
    const { dir, engine, vault } = await makeEngine(store, htmlHttp(OK_HTML, calls));
    await store.upsertAccount(ACCOUNT);
    await vault.save({
      platformId: 'chaoxing',
      accountId: ACCOUNT.id,
      origin: 'imported',
      cookies: {},
      headers: {},
      issuedAt: new Date().toISOString(),
    } as never);
    await store.upsertCourses([course('c1', { schema: 5, total: 26, done: 4, fetchedAt })]);
    await store.setCursor({
      accountId: ACCOUNT.id,
      kind: 'course-progress',
      cursor: fetchedAt,
      updatedAt: fetchedAt,
    });
    return { store, engine, calls, dir };
  }

  it('12 小时前刚抓过 → 不同步时再抓（省下 32 个请求）', async () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 3600_000).toISOString();
    const { engine, calls, dir } = await seeded(twelveHoursAgo);
    try {
      const r = await engine.refreshCourseProgressIfStale(ACCOUNT.id);
      assert.equal(r, undefined, '没过期就不该有报告（也没发请求）');
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('30 小时前抓过 → 过期，真的抓一次', async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const { engine, calls, dir } = await seeded(old);
    try {
      const r = await engine.refreshCourseProgressIfStale(ACCOUNT.id);
      assert.equal(r?.status, 'ok');
      assert.equal(calls.length, 1, '一门课一个请求');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('同一账号同时只跑一份：第二份直接返回 busy，不发请求', async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const { engine, calls, dir } = await seeded(old);
    try {
      const [a, b] = await Promise.all([
        engine.refreshCourseProgress(ACCOUNT.id),
        engine.refreshCourseProgress(ACCOUNT.id),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, ['busy', 'ok'], '一个是真跑，另一个被挡住');
      assert.equal(calls.length, 1, '并发不能翻倍请求量');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
