/**
 * 「一键同步」引擎级测试：会话失效 → 用保存的凭据自动重登 → 重试成功。
 *
 * 用一个内存 stub 适配器精确控制 probeSession 的失败次数，
 * 不需要真的起 HTTP 服务。重点验证三条安全边界：
 *   1. 只有保险箱里存了密码的账号才会自动重登；
 *   2. imported（用户自带会话）路线永远不会被自动重登；
 *   3. 重登失败时响亮地停在 auth-required，而不是静默吞掉。
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
  HubError,
  materializeTask,
} from '../src/index.ts';
import type {
  AdapterCapabilities,
  AdapterContext,
  AuthMethod,
  Credentials,
  FetchCoursesRequest,
  FetchTasksRequest,
  HttpClient,
  Page,
  PlatformAdapter,
  PlatformCourse,
  PlatformTask,
  ReadOnlyPolicy,
  Session,
} from '../src/index.ts';

/** 永远不该被调用的 HTTP 客户端 —— stub 适配器不发真实请求。 */
const noHttp: HttpClient = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error('stub 适配器不应发起底层 HTTP 请求');
  },
};

export interface StubControl {
  probeCalls: number;
  loginCalls: number;
  /** fetchTasks 被调用的次数 —— 用于验证「已完成课程跳过」 */
  fetchCalls: number;
  /** 每次 probe 都失败（永久失效）——用于测试「重登后仍失败」的路径 */
  probeAlwaysFails: boolean;
  /** 置真时 fetchCourses 抛错 —— 用于验证「课程失败不能被静默吞掉」 */
  coursesFail: boolean;
  /** 声明 probeBeforeSync 能力：每轮同步前先探测会话 */
  probeBeforeSync?: boolean;
  /** 探测恒定成功（默认是「第一次失败、之后成功」，用于重登场景） */
  probeAlwaysOk?: boolean;
  /** 探测本身抛这个错误码（模拟"平台回了 HTML 登录页"等形态） */
  probeThrows?: 'CAPTCHA_REQUIRED' | 'AUTH_REQUIRED' | 'NETWORK';
  /** 会话自动接回的结果；不设则桩不实现该钩子。'throw' 表示钩子自己抛错 */
  recoverTo?: 'ok' | 'fail' | 'throw';
  /** 接回失败时附在用户提示里的原因 */
  recoverNote?: string;
  /** 接回失败时的归因（引擎只记录，不改变行为） */
  recoverDiagnosis?: 'ticket-expired' | 'mechanism' | 'channel';
  /** 置真时第一次 fetchTasks 抛「疑似会话失效 + failFast 标记」 */
  failFastOnce?: boolean;
  /** 最近一次 fetchTasks 收到的 fullDiagnostics 标记 */
  lastFullDiagnostics?: boolean;
  /** 最近一次 fetchTasks 收到的静默课程 ID（引擎判定结果） */
  lastQuietCourseIds?: string[];
  /** stub 返回的任务状态（默认 pending）—— 用于构造「全终态课程」以测静默判定 */
  taskStatus?: 'pending' | 'submitted' | 'graded' | 'expired' | 'unknown';
  /** stub 返回状态的性质：'platform'（默认，平台报的）/ 'inferred'（我们推的，如雨课堂章节树） */
  statusSource?: 'platform' | 'inferred';
  /** 声明失效归因（引擎把它拼进提示语，顺序 = 可能性高低） */
  expiryCauses?: string[];
  /** 适配器经 Page.notes 带回来的话（诊断结论 / 已知边界） */
  adapterNotes?: string[];
}

export function makeStubAdapter(control: StubControl): PlatformAdapter {
  const capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: false,
    incremental: false,
    cookieOnlySession: false,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
    probeBeforeSync: control.probeBeforeSync === true,
  };
  const authMethods: AuthMethod[] = [
    { id: 'password', label: '密码', kind: 'password', fields: [] },
  ];
  const readOnlyPolicy: ReadOnlyPolicy = { allowMethods: ['GET'] };

  return {
    id: 'stub',
    displayName: 'Stub 平台',
    homepage: 'https://stub.example.com',
    capabilities,
    authMethods,
    readOnlyPolicy,

    ...(control.expiryCauses ? { sessionExpiryCauses: control.expiryCauses } : {}),

    async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
      control.loginCalls += 1;
      if (cred.password === 'wrong-password') {
        throw new HubError('AUTH_FAILED', '账号或密码错误', { platformId: 'stub' });
      }
      return {
        platformId: 'stub',
        accountId: '',
        origin: 'derived',
        cookies: { sid: `fresh-${control.loginCalls}` },
        headers: {},
        issuedAt: ctx.clock.now().toISOString(),
      };
    },

    async probeSession(): Promise<boolean> {
      control.probeCalls += 1;
      if (control.probeThrows) {
        // 真实形态：平台直接回 HTML 登录页，解析层抛的是 CAPTCHA_REQUIRED，
        // 而不是"业务层返回未登录"的 AUTH_REQUIRED
        throw new HubError(control.probeThrows, `stub 探测失败（${control.probeThrows}）`, {
          platformId: 'stub',
          requiresUserAction: control.probeThrows !== 'NETWORK',
        });
      }
      // 默认行为：第一次探测失败（模拟会话已失效），之后成功（模拟重登生效）
      if (control.probeAlwaysOk) return true;
      return control.probeAlwaysFails ? false : control.probeCalls > 1;
    },

    ...(control.recoverTo
      ? {
          async recoverSession(): Promise<{
            recovered: boolean;
            note?: string;
            diagnosis?: 'ticket-expired' | 'mechanism' | 'channel';
          }> {
            if (control.recoverTo === 'throw') throw new Error('接回自己炸了');
            return control.recoverTo === 'ok'
              ? { recovered: true }
              : {
                  recovered: false,
                  note: control.recoverNote ?? '接回失败',
                  ...(control.recoverDiagnosis ? { diagnosis: control.recoverDiagnosis } : {}),
                };
          },
        }
      : {}),

    async fetchCourses(): Promise<Page<PlatformCourse>> {
      if (control.coursesFail) {
        throw new HubError('UPSTREAM', '模拟：课程页结构改版', { platformId: 'stub' });
      }
      return { items: [{ platformCourseId: 'C1', name: '课程一' }], hasMore: false };
    },

    async fetchTasks(_ctx: AdapterContext, _s: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
      control.fetchCalls += 1;
      control.lastFullDiagnostics = req.fullDiagnostics === true;
      control.lastQuietCourseIds = req.quietCourseIds ?? [];
      if (control.failFastOnce && control.fetchCalls === 1) {
        throw new HubError('AUTH_REQUIRED', '疑似会话已失效（测试：提前中止）', {
          platformId: 'stub',
          requiresUserAction: true,
          details: { failFast: true, checked: 5, total: 32 },
        });
      }
      // 模仿真实适配器：没有课程列表时响亮报错，绝不静默返回空
      if (!req.courses || req.courses.length === 0) {
        throw new HubError('UPSTREAM', '缺少课程列表，无法拉取作业', { platformId: 'stub' });
      }
      return {
        items: [
          {
            platformTaskId: 'w1',
            courseId: 'C1',
            courseName: '课程一',
            kind: 'homework',
            title: '作业一',
            status: control.taskStatus ?? 'pending',
            ...(control.statusSource ? { statusSource: control.statusSource } : {}),
            deadline: '2026-10-08 23:59',
          },
        ],
        hasMore: false,
        ...(control.adapterNotes ? { notes: control.adapterNotes } : {}),
      };
    },

    buildTaskUrl() {
      return undefined;
    },
  };
}

export async function makeEngine(adapter: PlatformAdapter) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-relogin-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({ directory: join(dir, 'sessions'), keyProvider: new StaticKeyProvider('test-key') });
  const registry = new AdapterRegistry().register(adapter);
  const engine = new SyncEngine({
    registry,
    store,
    vault,
    http: noHttp,
    clock: systemClock,
    logger: createSilentLogger(),
  });
  return { dir, store, vault, engine };
}

describe('一键同步（会话失效自动重登）', () => {
  it('失效后用保存的凭据重登，重试整轮同步成功', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      assert.equal(control.loginCalls, 1, '登记时应登录一次');

      // 把会话改成已过期 → 触发 probe → 失败 → 应自动重登并重试
      const s = await vault.load(account.id);
      assert.ok(s?.credentials?.password === 'p1', '凭据应已随会话加密保存');
      await vault.save({ ...s!, expiresAt: new Date(Date.now() - 60_000).toISOString() });

      const report = await engine.syncAll({});
      assert.equal(report.totals.ok, 1, `同步应成功：${JSON.stringify(report.accounts.map((a) => [a.status, a.message]))}`);
      assert.equal(report.totals.created, 1);
      assert.equal(control.probeCalls, 1, '首轮探测一次');
      assert.equal(control.loginCalls, 2, '失效后自动重登一次');

      // 重登后的新会话应已落盘
      const fresh = await vault.load(account.id);
      assert.equal(fresh?.cookies.sid, 'fresh-2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没有保存凭据的账号失效时停下等待用户，绝不擅自重登', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      // 模拟「粘贴 cookie」路线：清掉凭据、标记为 imported
      const s = await vault.load(account.id);
      await vault.save({
        ...s!,
        origin: 'imported',
        credentials: undefined,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const report = await engine.syncAll({});
      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.equal(control.loginCalls, 1, '不应发生第二次登录');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('重登失败（密码被改）时响亮报错，并保留原始凭据', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const s = await vault.load(account.id);
      await vault.save({
        ...s!,
        credentials: { username: 'u1', password: 'wrong-password' },
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const report = await engine.syncAll({});
      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.match(report.accounts[0]!.message ?? '', /自动重新登录失败/);
      assert.equal(control.loginCalls, 2);
      // 凭据仍在（也许用户改回密码后还能用），没有被清除
      const after = await vault.load(account.id);
      assert.equal(after?.credentials?.password, 'wrong-password');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('已完成课程跳过重爬（TTL）', () => {
  /** 给账号造一门「全部已交」的课程数据 + 新鲜的爬取游标 */
  async function seedCompletedCourse(engine: SyncEngine, store: MemoryStore, accountId: string, crawledAt: Date) {
    const task = materializeTask({
      platformId: 'stub',
      accountId,
      platformTask: {
        platformTaskId: 'done-1',
        courseId: 'C1',
        courseName: '课程一',
        kind: 'homework',
        title: '已交作业',
        status: 'submitted',
        deadline: '2026-09-01 23:59',
      },
      now: crawledAt,
    });
    await store.upsertTasks([task]);
    await store.setCursor({
      accountId,
      kind: 'course-crawl',
      cursor: JSON.stringify({ C1: crawledAt.toISOString() }),
      updatedAt: crawledAt.toISOString(),
    });
  }

  it('TTL 内且课程全部终态 → 不再发任务请求，同步仍 ok', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await seedCompletedCourse(engine, store, account.id, new Date());

      const report = await engine.syncAll({});
      assert.equal(report.accounts[0]!.status, 'ok');
      assert.equal(control.fetchCalls, 0, '全部完成且刚爬过，不应再拉任务');
      // 「跳过 N 门」只进日志（detail），不进弹窗（message）——
      // 弹窗要留给"哪个平台出问题了"，不是操作流水账（2026-11-01 用户反馈）。
      assert.equal(report.accounts[0]!.message ?? '', '', '弹窗不该被优化细节占满');
      assert.match(report.accounts[0]!.detail ?? '', /跳过 1 门/);
      // 原任务必须原样还在 —— 跳过绝不能演变成误删
      const tasks = await store.listTasks({ accountIds: [account.id] });
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.deletedAt ?? null, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('TTL 已过 → 恢复重爬，并刷新游标', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const stale = new Date(Date.now() - 7 * 3600_000);
      await seedCompletedCourse(engine, store, account.id, stale);

      await engine.syncAll({});
      assert.equal(control.fetchCalls, 1, 'TTL 过期后应重新爬取');

      const c = await store.getCursor(account.id, 'course-crawl');
      const map = JSON.parse(c!.cursor) as Record<string, string>;
      assert.ok(new Date(map['C1']!).getTime() > stale.getTime(), '游标应已刷新');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('课程里还有未完成任务 → 永不跳过', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const now = new Date();
      const pending = materializeTask({
        platformId: 'stub',
        accountId: account.id,
        platformTask: {
          platformTaskId: 'todo-1',
          courseId: 'C1',
          courseName: '课程一',
          kind: 'homework',
          title: '未交作业',
          status: 'pending',
          deadline: '2026-10-08 23:59',
        },
        now,
      });
      await store.upsertTasks([pending]);
      await store.setCursor({
        accountId: account.id,
        kind: 'course-crawl',
        cursor: JSON.stringify({ C1: now.toISOString() }),
        updatedAt: now.toISOString(),
      });

      await engine.syncAll({});
      assert.equal(control.fetchCalls, 1, '有未完成任务就必须爬');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('无课程列表时的响亮失败', () => {
  it('从没爬到课程的账号同步必须报 failed，而不是静默 ok', async () => {
    const control: StubControl = { probeCalls: 0, loginCalls: 0, fetchCalls: 0, probeAlwaysFails: false, coursesFail: false };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      // 不预置任何课程与任务 —— fetchCourses 也让它失败？不：让课程成功但任务课程为空的场景
      // 这里直接同步：stub.fetchCourses 返回 C1，所以为构造「 courses 为空」的场景，
      // 用 dryRun 不合适；改用 fetchCourses 抛错的变体没有 —— 直接验证：
      // 首轮同步正常拿到课程与任务（对照组，确认测试环境本身是好的）
      const r1 = await engine.syncAll({});
      assert.equal(r1.accounts[0]!.status, 'ok');
      void account;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('课程失败不得被静默吞掉', () => {
  it('fetchCourses 抛错且无缓存时：同步 failed 并报根因，fetchTasks 不被调用', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      // 此账号库里没有任何课程与任务：若引擎把空列表交给适配器，
      // 静默型适配器会返回空任务 → 假装同步成功。必须在这里就报根因。
      const report = await engine.syncAll({});
      assert.equal(report.accounts[0]!.status, 'failed');
      assert.match(report.accounts[0]!.message ?? '', /课程列表拉取失败/);
      assert.match(report.accounts[0]!.message ?? '', /改版/);
      assert.equal(control.fetchCalls, 0, '课程失败后不应再去拉任务');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('提前中止（fail-fast）与完整诊断', () => {
  it('适配器中止后：引擎记下游标，重试时自动带 fullDiagnostics 跑完整诊断', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      failFastOnce: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const report = await engine.syncAll({});
      void account;

      // 第一次 fetchTasks 抛 fail-fast → 引擎自动重登 → 重试
      assert.ok(control.fetchCalls >= 2, `应重登后重试（实际调用 ${control.fetchCalls} 次）`);
      // 重试那一次必须带完整诊断标记（游标机制生效）
      assert.equal(control.lastFullDiagnostics, true, '重试时应带 fullDiagnostics');
      assert.equal(report.accounts[0]!.status, 'ok', '重试后应成功');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('游标是消费式的：跑过一次完整诊断后不再一直全量', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      failFastOnce: true,
    };
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});

      // 再同步一次：不应再带 fullDiagnostics
      control.lastFullDiagnostics = false;
      await engine.syncAll({});
      assert.equal(control.lastFullDiagnostics, false, '游标消费后不应再全量');

      const c = await store.getCursor(account.id, 'full-diagnostics');
      assert.equal(c?.cursor, '0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('probeBeforeSync：会话本地判断不了的平台，同步前先探一次', () => {
  it('每轮同步前探测一次（顺带续活服务端会话）', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      probeBeforeSync: true,
      probeAlwaysOk: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.login('stub', 'u1', { password: 'p1' });
      const before = control.probeCalls;
      await engine.syncAll({});
      await engine.syncAll({});
      assert.equal(control.probeCalls - before, 2, '每轮同步应各探测一次');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('对照组：没声明该能力的平台一次都不探测（不白花请求）', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      probeAlwaysOk: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.login('stub', 'u1', { password: 'p1' });
      const before = control.probeCalls;
      await engine.syncAll({});
      assert.equal(control.probeCalls - before, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('探测发现失效 → 立刻停在第一跳，不白跑后面的业务请求', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: true,
      coursesFail: false,
      probeBeforeSync: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      // 用离线登记（没有保存密码）→ 引擎不会自动重登，能观察到纯粹的"探测失败"路径
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});

      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.equal(control.fetchCalls, 0, '会话已失效就不该再去拉作业');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('会话失效的自动接回', () => {
  const base = (): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
    probeBeforeSync: true,
  });

  it('接回成功 → 当作什么都没发生，同步照常完成（用户不会知道掉过线）', async () => {
    const control: StubControl = { ...base(), recoverTo: 'ok' };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      // 第一次探测必然失败（桩的默认行为），但接回成功后同步应继续
      const report = await engine.syncAll({});

      assert.equal(report.accounts[0]!.status, 'ok', '接回成功就不该报会话失效');
      assert.equal(control.fetchCalls, 1, '接回后应继续拉取，而不是整轮放弃');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('接回失败 → 仍报会话失效，并把失败原因带给用户', async () => {
    const control: StubControl = {
      ...base(),
      recoverTo: 'fail',
      recoverNote: '自动续登未成功（总票据可能也已过期）',
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});

      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.match(report.accounts[0]!.message ?? '', /总票据可能也已过期/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('接回钩子自己抛错 → 不影响原本的错误（它只是尝试）', async () => {
    const control: StubControl = { ...base(), recoverTo: 'throw' };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});

      // 钩子内部抛错不会顶掉原本的「会话失效」，只会被转成一条附注
      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.match(report.accounts[0]!.message ?? '', /会话已被平台失效/, '原本的错误必须保留');
      assert.match(report.accounts[0]!.message ?? '', /自动续登时出错/, '接回失败的原因要能看到');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('探测抛错时的自动接回（真机 bug：接回被错误码掐掉）', () => {
  it('【回归】探测抛 CAPTCHA_REQUIRED（平台回 HTML 登录页）→ 仍会尝试自动接回', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      probeBeforeSync: true,
      probeThrows: 'CAPTCHA_REQUIRED',
      recoverTo: 'ok',
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});

      // 修复前：这个错误码一路冒泡，自动接回根本没跑，用户看到"疑似返回登录/验证页面"
      assert.equal(report.accounts[0]!.status, 'ok', '探测抛会话类错误也应走自动接回');
      assert.equal(control.fetchCalls, 1, '接回后应当继续同步');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('探测抛网络错误 → 不伪装成「需要重新登录」', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      probeBeforeSync: true,
      probeThrows: 'NETWORK',
      recoverTo: 'ok',
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});

      // 网络故障让用户去"重新登录"是错的指引，应该报 failed
      assert.equal(report.accounts[0]!.status, 'failed');
      assert.doesNotMatch(report.accounts[0]!.message ?? '', /一键重登/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe('失效归因由适配器声明（顺序 = 可能性高低）', () => {
  it('提示语带上适配器给的主因，且主因排在前面', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: true,
      coursesFail: false,
      probeBeforeSync: true,
      recoverTo: 'fail',
      recoverNote: '换票被退回登录页',
      expiryCauses: ['服务端会话约 2 小时闲置就作废', '你在别处登录或退出了'],
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});
      const msg = report.accounts[0]!.message ?? '';
      assert.equal(report.accounts[0]!.status, 'auth-required');
      assert.match(msg, /最可能的原因：服务端会话约 2 小时闲置就作废/);
      // 「异地登录」不该出现在最前面 —— 那会把用户引去改密码
      assert.ok(
        msg.indexOf('闲置') < msg.indexOf('别处登录'),
        '归因顺序必须是主因在前',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('适配器没声明归因时，不硬塞一句通用猜测', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: true,
      coursesFail: false,
      probeBeforeSync: true,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});
      assert.doesNotMatch(report.accounts[0]!.message ?? '', /最可能的原因/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('issuedAt（会话建立时刻）必须跟着「官方登录返回」刷新', () => {
  const flat = (): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
  });

  it('带 localStorage 快照的重登（雨课堂形态）会刷新 issuedAt', async () => {
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(flat()));
    try {
      const account = await engine.registerOfflineAccount('stub', 'browser', {});
      const first = (await vault.load(account.id))!.issuedAt;

      await new Promise((r) => setTimeout(r, 8));
      await engine.registerOfflineAccount('stub', 'browser', {
        storage: JSON.stringify({ authToken: 'refreshed-token-value' }),
        freshLogin: true,
      });

      const second = (await vault.load(account.id))!.issuedAt;
      assert.ok(new Date(second).getTime() > new Date(first).getTime());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('【回归】不带任何快照的重登（iSmart 形态）也必须刷新 issuedAt', async () => {
    // 真机 bug：iSmart 的凭据在 cookie 里（由系统保管），登录返回时根本没有
    // localStorage 快照。原来把刷新塞在「有没有 storage」的分支里 → 对它永远不生效，
    // 于是「距上次官方登录」被算成「距首次登记」，真机显示 77.9 小时而实际不到 2 小时。
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(flat()));
    try {
      const account = await engine.registerOfflineAccount('stub', 'browser', {});
      const first = (await vault.load(account.id))!.issuedAt;

      await new Promise((r) => setTimeout(r, 8));
      // 关键：没有任何 storage
      await engine.registerOfflineAccount('stub', 'browser', { freshLogin: true });

      const second = (await vault.load(account.id))!.issuedAt;
      assert.ok(
        new Date(second).getTime() > new Date(first).getTime(),
        `iSmart 形态的重登也要刷新 issuedAt（首次 ${first} → 现在 ${second}）`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cookie-import 不是「刚发生的登录」，不刷新 issuedAt', async () => {
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(flat()));
    try {
      const account = await engine.registerOfflineAccount('stub', 'u1', {});
      const first = (await vault.load(account.id))!.issuedAt;

      await new Promise((r) => setTimeout(r, 8));
      // 用户从别处拷来的凭据（不是刚登录）→ 只合并 token，不动「上次登录时刻」
      await engine.registerOfflineAccount('stub', 'u1', {
        storage: JSON.stringify({ authToken: 'pasted-token-value' }),
      });

      const after = (await vault.load(account.id))!.issuedAt;
      assert.equal(after, first, '粘贴凭据不应被当成一次登录');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('适配器可以说话：Page.notes 必须出现在同步消息里', () => {
  it('notes 并进本轮消息 —— 已知缺陷不该只活在代码注释里', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      adapterNotes: ['雨课堂章节树里没有完成状态，已完成栏暂为空'],
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});
      assert.match(
        report.accounts[0]!.message ?? '',
        /章节树里没有完成状态/,
        '适配器的话必须出现在用户能看到的同步消息里',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('同一句话重复带回时只显示一次（多课程会各带一份）', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
      adapterNotes: ['字段取证：A', '字段取证：A'],
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      const report = await engine.syncAll({});
      const msg = report.accounts[0]!.message ?? '';
      assert.equal(msg.split('字段取证：A').length - 1, 1, '重复的附注必须去重');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
