/**
 * HomeworkHub CLI。
 *
 * 两个用途：
 *   `demo` —— 一键跑完整端到端验证：在一个真实 HTTP 服务器上复现平台的
 *             各种恶劣行为（改版、限流、会话失效、任务增删改），
 *             逐条断言核心引擎的处理是否正确的。这既是演示，也是回归测试。
 *   其余命令 —— 日常使用的真实入口（login / sync / list / changes）。
 *
 * 运行：
 *   node apps/cli/src/main.ts demo
 *   node apps/cli/src/main.ts list --days 7
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 读文本文件。CLI 专属 —— 核心库不再提供，因为它要能在无文件系统的 WebView 里加载。 */
async function readUtf8(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`无法读取文件 ${path}：${(e as Error).message}`);
  }
}

import {
  AdapterRegistry,
  CdpHttpClient,
  ConsoleLogger,
  discoverCdpTargets,
  EncryptedVault,
  FakeClock,
  FetchHttpClient,
  FileKeyProvider,
  HarReplayHttpClient,
  HubError,
  JsonFileStore,
  RecordingHttpClient,
  SyncEngine,
  TokenBucket,
  UnavailableSigner,
  createReadOnlyGuardStats,
  createReadOnlyHttpClient,
  formatEffective,
  isOverdue,
  isSessionExpired,
  maskUsername,
  mayReauthenticate,
} from '#core';
import type {
  AccountSyncReport,
  HttpClient,
  PlatformAccount,
  PlannedReminder,
  SyncReport,
  UnifiedTask,
} from '#core';
import { MockAdapter, MockPlatform, createFixtures, createDefaultRegistry } from '#adapters';

/**
 * 注册全部平台适配器。
 *
 * 平台清单统一放在 packages/adapters/index.ts（CLI / Web App / 桌面壳共用），
 * 这里只负责透传 mock 选项。
 */
function createRegistry(mockBaseUrl?: string): AdapterRegistry {
  return createDefaultRegistry({ mockBaseUrl });
}

// ------------------------------------------------------------------ 输出工具

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m',
  magenta: '\u001b[35m',
};

// 只在真正的交互式终端里上色。被重定向到文件/管道时输出纯文本，
// 否则日志文件和 CI 输出里会塞满 ANSI 转义序列。
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (color: keyof typeof C, s: string) => (useColor ? `${C[color]}${s}${C.reset}` : s);

function heading(text: string): void {
  const line = '─'.repeat(Math.max(4, 66 - text.length));
  console.log(`\n${paint('bold', `▌ ${text}`)} ${paint('dim', line)}`);
}

function step(n: number, text: string): void {
  console.log(`\n${paint('blue', `【场景 ${n}】`)} ${paint('bold', text)}`);
}

function kv(label: string, value: string): void {
  console.log(`   ${paint('dim', label.padEnd(12))} ${value}`);
}

let passCount = 0;
let failCount = 0;

function check(desc: string, condition: boolean, detail?: string): void {
  if (condition) {
    passCount += 1;
    console.log(`   ${paint('green', '✓')} ${desc}${detail ? paint('dim', `  ${detail}`) : ''}`);
  } else {
    failCount += 1;
    console.log(`   ${paint('red', '✗')} ${desc}${detail ? paint('red', `  ${detail}`) : ''}`);
  }
}

function equal(desc: string, actual: unknown, expected: unknown): void {
  check(desc, actual === expected, `实际 ${String(actual)} / 期望 ${String(expected)}`);
}

// ------------------------------------------------------------------ 应用装配

interface App {
  engine: SyncEngine;
  store: JsonFileStore;
  vault: EncryptedVault;
  registry: AdapterRegistry;
  workspace: string;
  keyPath: string;
}

async function createApp(opts: {
  workspace: string;
  registry: AdapterRegistry;
  clock: FakeClock;
  reminders: PlannedReminder[];
  logger: ConsoleLogger;
  /** 替换底层传输：HAR 回放 / CDP 附着都会从这里注入 */
  http?: HttpClient;
}): Promise<App> {
  const store = new JsonFileStore(join(opts.workspace, 'state.json'));
  await store.init();

  const keyPath = join(opts.workspace, 'master.key');
  const vault = new EncryptedVault({
    directory: join(opts.workspace, 'sessions'),
    keyProvider: new FileKeyProvider(keyPath),
  });

  const engine = new SyncEngine({
    registry: opts.registry,
    store,
    vault,
    http: opts.http ?? new FetchHttpClient({ trace: process.env.HH_TRACE === '1' }),
    clock: opts.clock,
    logger: opts.logger,
    // iSmart 这类平台需要 native 签名；演示环境挂占位实现，
    // 适配器会据此降级为「只读」而不是整体失败。
    signer: new UnavailableSigner(),
    reminderSink: {
      deliver: async (r) => {
        opts.reminders.push(r);
      },
    },
  });

  return { engine, store, vault, registry: opts.registry, workspace: opts.workspace, keyPath };
}

// ------------------------------------------------------------------ demo 主流程

async function runDemo(): Promise<number> {
  const clock = new FakeClock();
  const workspace = await mkdtemp(join(tmpdir(), 'homework-hub-demo-'));
  const reminders: PlannedReminder[] = [];
  const logger = new ConsoleLogger({ level: process.env.HH_LOG === 'debug' ? 'debug' : 'warn', color: useColor });

  console.log(paint('bold', '\n╔══════════════════════════════════════════════════════════════════╗'));
  console.log(paint('bold', '║   HomeworkHub · 课业中枢 —— 端到端能力验证                        ║'));
  console.log(paint('bold', '╚══════════════════════════════════════════════════════════════════╝'));
  kv('工作目录', workspace);
  kv('虚拟当前时间', clock.now().toLocaleString('zh-CN'));

  // ---- 启动假平台 ----
  const platform = new MockPlatform({
    port: 0,
    ...createFixtures(clock.now()),
    accounts: [{ username: '20230001', password: 's3cret', displayName: '张同学' }],
    pageSize: 3, // 故意只给 3 条一页，强制走多页逻辑
  });
  const baseUrl = await platform.start();
  console.log(paint('dim', `\n[setup] Mock 平台已启动：${baseUrl}（每页 3 条，共 ${platform.state.taskCount} 条任务）`));

  const registry = new AdapterRegistry().register(new MockAdapter({ baseUrl }));
  const app = await createApp({ workspace, registry, clock, reminders, logger });

  try {
    // ================================================================ 场景 1
    heading('场景 1 · 能力声明与登录');
    const adapter = registry.require('mock');
    kv('适配器', `${adapter.displayName} (${adapter.id})`);
    kv(
      '能力',
      Object.entries(adapter.capabilities)
        .map(([k, v]) => `${k}=${v ? '是' : '否'}`)
        .join(' '),
    );

    const account = await app.engine.login('mock', '20230001', { password: 's3cret' });
    check('登录成功并登记账号', account.id === 'mock::20230001', `accountId=${account.id}`);
    equal('账号展示名取自平台返回值', account.label, '张同学');

    const session = await app.vault.load(account.id);
    check('会话已写入保险箱', Boolean(session));
    check(
      '会话 cookie 已捕获',
      Object.keys(session?.cookies ?? {}).length > 0,
      Object.keys(session?.cookies ?? {}).join(','),
    );
    check('会话未标记过期', session ? !isSessionExpired(session, clock.now()) : false);

    const inspect = await app.vault.debugInspect(account.id);
    check('保险箱密文中不含明文账号', inspect.exists && !inspect.leaksPlaintext, `密文 ${inspect.bytes} 字节`);

    // ================================================================ 场景 2
    step(2, '首次全量同步（分页 + 归一化 + 指纹兜底）');
    const r1 = await app.engine.syncAll();
    printReport(r1);

    const accountReport1 = r1.accounts[0]!;
    equal('拉取到全部 9 条任务', accountReport1.fetched, 9);
    equal('分页请求数 > 1（每页 3 条）', accountReport1.http.requests > 1, true);
    equal('新增 9 条', accountReport1.created, 9);
    equal('更新 0 条', accountReport1.updated, 0);

    const allTasks = await app.store.listTasks();
    const noStableId = allTasks.find((t) => t.title.includes('实验一'));
    check(
      '无平台 ID 的任务用指纹兜底（fp_ 前缀）',
      Boolean(noStableId?.platformTaskId.startsWith('fp_')),
      `platformTaskId=${noStableId?.platformTaskId}`,
    );
    const relative = allTasks.find((t) => t.title.includes('hometown'));
    check(
      '「还剩 3 天」被锚定成绝对时刻（否则永远到不了期）',
      relative?.deadline.kind === 'relative' && Boolean(relative.deadlineAt),
      `deadlineAt=${relative?.deadlineAt}`,
    );
    const open = allTasks.find((t) => t.title.includes('Writing Task'));
    equal('「不限时」识别为开放态', open?.deadline.kind, 'open');
    const epochTask = allTasks.find((t) => t.title.includes('随堂小测'));
    check('epoch 毫秒被识别为绝对时间', epochTask?.deadline.kind === 'absolute');
    check(
      '课程名已通过 courseId 关联补齐',
      allTasks.every((t) => t.courseName !== '未知课程'),
      `未知课程数=${allTasks.filter((t) => t.courseName === '未知课程').length}`,
    );

    console.log(paint('dim', `\n   本轮产生 ${reminders.length} 条提醒：`));
    for (const r of reminders) console.log(`     ${paint('magenta', '•')} ${r.title}  ${paint('dim', r.body)}`);

    // ================================================================ 场景 3
    step(3, '重复同步 —— 验证幂等性');
    const before3 = reminders.length;
    const r3 = await app.engine.syncAll();
    const a3 = r3.accounts[0]!;
    equal('新增 0 条（没有重复入库）', a3.created, 0);
    equal('更新 0 条（内容无变化）', a3.updated, 0);
    equal('静默跳过 9 条', a3.unchanged, 9);
    equal('重复提醒 0 条（提醒去重生效）', reminders.length - before3, 0);
    equal('库内任务总数仍为 9', (await app.store.listTasks()).length, 9);

    // ================================================================ 场景 4
    step(4, '老师提前了截止时间 —— 应识别为「变更」而非「新建」，并重新提醒');
    const target = allTasks.find((t) => t.title.includes('第三章'))!;
    const originalRevision = target.revision;
    // 从「2 天后」提前到「2 小时后」：既验证变更检测，也验证提醒窗口迁移
    platform.shiftDeadline('work_88001', new Date(clock.now().getTime() + 2 * 3_600_000).toISOString());

    const before4 = reminders.length;
    const r4 = await app.engine.syncAll();
    const a4 = r4.accounts[0]!;
    equal('新增 0 条', a4.created, 0);
    equal('更新 1 条', a4.updated, 1);

    const changed = await app.store.getTask(target.id);
    check('revision 递增', (changed?.revision ?? 0) > originalRevision, `${originalRevision} → ${changed?.revision}`);
    const deadlineChange = changed?.history.find((h) => h.field === 'deadline');
    check('变更历史记录了 deadline 变化', Boolean(deadlineChange), deadlineChange ? `${deadlineChange.from} → ${deadlineChange.to}` : '');
    check('任务总数未变（没有产生重复记录）', (await app.store.listTasks()).length === 9);
    check('改期后重新触发提醒（提醒 key 含截止时间，自动失效旧记录）', reminders.length > before4, `新增 ${reminders.length - before4} 条`);

    // ================================================================ 场景 5
    step(5, '平台新增一条作业');
    platform.addTask({
      id: 'work_99001',
      courseId: 'C1002',
      kind: 'homework',
      title: '第四章 网络层 作业',
      status: 'pending',
      deadline: new Date(clock.now().getTime() + 30 * 3_600_000).toISOString(),
      totalScore: 50,
    });
    const r5 = await app.engine.syncAll();
    equal('新增 1 条', r5.accounts[0]!.created, 1);
    equal('库内任务总数 10', (await app.store.listTasks()).length, 10);

    // ================================================================ 场景 6
    step(6, '平台删除一条任务 —— 验证「防翻页抖动误删」');
    const toDelete = (await app.store.listTasks({ includeDeleted: true })).find(
      (t) => t.platformTaskId === 'work_88004',
    )!;
    platform.deleteTask('work_88004');
    const r6a = await app.engine.syncAll();
    const a6a = r6a.accounts[0]!;
    equal('第一轮：标记为「疑似消失」而非删除', a6a.vanished, 1);
    equal('第一轮：实际删除 0 条', a6a.removed, 0);
    const ghost = await app.store.getTask(toDelete.id);
    check('第一轮：记录仍在库中（未软删）', ghost !== undefined && !ghost.deletedAt, `absentCount=${ghost?.absentCount}`);

    const r6b = await app.engine.syncAll();
    equal('第二轮：连续缺席后软删除 1 条', r6b.accounts[0]!.removed, 1);
    const gone = await app.store.getTask(toDelete.id);
    check('记录仍可追溯（软删除而非硬删除）', Boolean(gone?.deletedAt));
    check('默认查询已隐藏该记录', !(await app.store.listTasks()).some((t) => t.id === toDelete.id));

    // ================================================================ 场景 7
    step(7, '平台改版（字段改名）—— 必须响亮失败，而不是静默返回空');
    const snapshotBefore7 = (await app.store.listTasks()).length;
    platform.setMode('drift');
    const r7 = await app.engine.syncAll();
    const a7 = r7.accounts[0]!;
    equal('同步状态为 failed', a7.status, 'failed');
    check('错误信息明确指出是结构改版', /改版|list/.test(a7.message ?? ''), a7.message);
    check('本地数据未被清空', (await app.store.listTasks()).length === snapshotBefore7, `仍为 ${snapshotBefore7} 条`);

    platform.setMode('ok');

    // ================================================================ 场景 8
    step(8, '同一轮里一个平台挂了，不影响其他账号');
    const r8 = await app.engine.syncAll();
    equal('恢复后同步正常', r8.accounts[0]!.status, 'ok');
    platform.invalidateSessions();
    // 账号是密码登录且引擎已保存凭据（一键同步）：会话失效后应自动重登并恢复同步。
    // 「停在 auth-required」的行为只属于没有凭据的 imported 会话，那条路径在单测里覆盖。
    const r8b = await app.engine.syncAll();
    const a8b = r8b.accounts[0]!;
    equal('会话失效后自动重登，同步恢复（一键同步）', a8b.status, 'ok');
    check('数据完整且为重登后的新同步', (await app.store.listTasks()).length === snapshotBefore7);
    // imported 路线（无凭据）仍然必须停下等用户 —— 安全边界不因新功能松动
    platform.invalidateSessions();
    {
      const s = await app.vault.load('mock::20230001');
      if (s) {
        delete s.credentials;
        s.origin = 'imported';
        await app.vault.save(s);
      }
    }
    const r8c = await app.engine.syncAll();
    equal('无凭据的会话失效仍正确停在 auth-required', r8c.accounts[0]!.status, 'auth-required');
    check('提示语引导用户处理而非崩溃', /重新登录|失效|凭证/.test(r8c.accounts[0]!.message ?? ''), r8c.accounts[0]!.message);
    check('本地数据依然完整', (await app.store.listTasks()).length === snapshotBefore7);

    // 重新登录恢复
    await app.engine.login('mock', '20230001', { password: 's3cret' });
    check('重新登录后会话恢复', Boolean(await app.vault.load('mock::20230001')));

    // ================================================================ 场景 9
    step(9, '平台限流（429 + Retry-After）—— 自动退避重试');
    platform.setMode('ratelimit', 1);
    const r9 = await app.engine.syncAll();
    const a9 = r9.accounts[0]!;
    equal('最终同步成功（未因限流失败）', a9.status, 'ok');
    check('发生过重试', a9.http.retries >= 1, `retries=${a9.http.retries}`);
    check('限流等待被记录', a9.http.throttledMs > 0, `throttledMs=${a9.http.throttledMs}`);
    check('状态码统计包含 429', Boolean(a9.http.statusCounts['429']), JSON.stringify(a9.http.statusCounts));

    platform.setMode('ok');

    // ================================================================ 场景 10
    step(10, '网络抖动（503）—— 指数退避重试');
    platform.setMode('flaky', 2);
    const r10 = await app.engine.syncAll();
    equal('最终成功', r10.accounts[0]!.status, 'ok');
    check('重试次数 ≥ 2', r10.accounts[0]!.http.retries >= 2, `retries=${r10.accounts[0]!.http.retries}`);
    platform.setMode('ok');

    // ================================================================ 场景 11
    step(11, '时间推进 3.1 天 —— 验证提醒窗口与「相对截止时间」不会漂移');
    const before11 = reminders.length;
    const relativeTaskId = allTasks.find((t) => t.title.includes('hometown'))!.id;
    const anchorBefore = (await app.store.getTask(relativeTaskId))?.deadlineAt;

    // 推 3 天多一点：确保越过锚点，同时不超出「逾期 3 天内仍提醒」的宽限期
    clock.advance(3.1 * 86_400_000);
    const due = await app.engine.runReminders();
    console.log(paint('dim', `   时间推进 3 天后新触发 ${due.length} 条提醒：`));
    for (const r of due) console.log(`     ${paint('magenta', '•')} ${r.title}`);
    check('时间推进后产生了新的提醒', due.length > 0, `共 ${due.length} 条`);
    check('提醒总数增长', reminders.length > before11);

    const r11 = await app.engine.syncAll();
    const relativeAfter = await app.store.getTask(relativeTaskId);
    check(
      '相对截止时间的锚点未被重置（平台仍返回「还剩 3 天」）',
      anchorBefore === relativeAfter?.deadlineAt,
      `锚点 ${anchorBefore}`,
    );
    check(
      '该任务已逾期，而不是永远显示「还剩 3 天」',
      Boolean(relativeAfter) && isOverdue(relativeAfter!, clock.now()),
      relativeAfter ? formatEffective(relativeAfter.deadline, relativeAfter.deadlineAt, clock.now()) : '',
    );
    equal('锚定后未产生虚假的「截止时间变更」', r11.accounts[0]!.updated, 0);

    // ================================================================ 场景 12
    step(12, '待办视图（按截止时间排序 + 状态过滤）');
    const upcoming = await app.engine.upcoming({ withinDays: 30 });
    printTaskTable(upcoming, clock.now());

    check('已提交/已批阅的作业不出现在待办里', !upcoming.some((t) => t.status === 'submitted' || t.status === 'graded'));
    check('软删除的任务不出现在待办里', !upcoming.some((t) => t.deletedAt));
    const instants = upcoming
      .map((t) => (t.deadline.kind === 'absolute' ? new Date(t.deadline.at).getTime() : Number.MAX_SAFE_INTEGER))
      .filter((x) => x !== Number.MAX_SAFE_INTEGER);
    const sorted = [...instants].sort((a, b) => a - b);
    check('有明确截止时间的任务按时间升序', JSON.stringify(instants) === JSON.stringify(sorted));

    // ================================================================ 场景 13
    step(13, '多平台能力矩阵与签名缺失时的降级策略');
    const realRegistry = createRegistry();
    console.log('');
    for (const a of realRegistry.list()) {
      const caps = a.capabilities;
      const flags = [
        caps.courses ? '课程' : null,
        caps.tasks ? '作业' : null,
        caps.exams ? '考试' : null,
        caps.incremental ? '增量' : '全量',
        caps.requiresNativeSigner ? paint('yellow', '需签名组件') : null,
        caps.aggressiveAntiBot ? paint('yellow', '强风控') : null,
      ].filter(Boolean);
      console.log(`   ${paint('bold', a.displayName.padEnd(14))} ${paint('dim', a.id.padEnd(22))} ${flags.join(' · ')}`);
    }

    // iSmart 已按真实抓包校准（2026-09-27）：网页端学生接口是普通表单 POST，
    // 不需要任何签名组件 —— 曾经的「ut 签名墙」理论只适用于客户端专属接口。
    // 这里改为断言「无签名依赖」这个新事实。
    const ismartCaps = realRegistry.require('ismart').capabilities;
    check('iSmart 不依赖签名组件（抓包校准结论）', ismartCaps.requiresNativeSigner === false);
    check('iSmart 声明为 cookie 会话', ismartCaps.cookieOnlySession === true);

    // ================================================================ 场景 14
    step(14, '只读守卫与登录态隔离 —— 证明我们不会影响你正常使用平台');

    const mockAdapter = registry.require('mock') as MockAdapter;
    const loginPosts = () =>
      platform.state.requests.filter((r) => r.method === 'POST' && r.path === '/login').length;

    // ---- 14a · 整场演示的请求全貌 ----
    const allReq = platform.state.requests;
    const byMethod = platform.state.methods;
    kv('平台收到的请求', `${allReq.length} 次  ${JSON.stringify(byMethod)}`);
    const nonGet = allReq.filter((r) => r.method !== 'GET');
    check(
      '除登录外，平台只收到过 GET 请求',
      nonGet.every((r) => r.method === 'POST' && r.path === '/login'),
      nonGet.length === 0 ? '（一个非 GET 请求都没有）' : `非 GET：${nonGet.map((r) => `${r.method} ${r.path}`).join('、')}`,
    );

    // ---- 14b · 主动尝试「提交作业」，必须被拦下 ----
    const guardStats = createReadOnlyGuardStats();
    const guarded = createReadOnlyHttpClient(new FetchHttpClient(), {
      platformId: 'mock',
      policy: mockAdapter.readOnlyPolicy,
      stats: guardStats,
    });

    let blockedCode = '';
    let blockedDetail = '';
    try {
      await guarded.request(
        { url: `${baseUrl}/submit`, method: 'POST', json: { workId: 'work_88001', answer: 'A' } },
        { platformId: 'mock' },
      );
    } catch (e) {
      blockedCode = e instanceof HubError ? e.code : 'UNKNOWN';
      blockedDetail = e instanceof Error ? e.message : String(e);
    }
    check('提交类 POST 被拦截（WRITE_BLOCKED）', blockedCode === 'WRITE_BLOCKED');
    check('危险端点从未真正收到请求', platform.submitCount === 0, `submitCount=${platform.submitCount}`);

    // 换个花样：把动作藏进 query
    let queryBlocked = false;
    try {
      await guarded.request(
        { url: `${baseUrl}/api/courses?action=submit&id=1`, method: 'GET' },
        { platformId: 'mock' },
      );
    } catch (e) {
      queryBlocked = e instanceof HubError && e.code === 'WRITE_BLOCKED';
    }
    check('把动作藏进 query 参数同样被拦截', queryBlocked);

    // 正常读取仍然畅通 —— 守卫不能把该放行的也拦了
    // 用当前保险箱里的会话（前面几轮的故障注入换来换去，scenario 1 拿到的那个已经失效了）
    const liveSession = await app.vault.load(account.id);
    const cookieHeader = Object.entries(liveSession?.cookies ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const okRead = await guarded.request(
      { url: `${baseUrl}/api/courses`, method: 'GET', headers: { Cookie: cookieHeader } },
      { platformId: 'mock' },
    );
    check('正常 GET 查询不受影响', okRead.status === 200, `status=${okRead.status}`);
    check('守卫统计：拦截 2 次、放行 1 次合法请求', guardStats.blocked === 2 && guardStats.checked === 3,
      `checked=${guardStats.checked} blocked=${guardStats.blocked}`);
    console.log(paint('dim', `     拦截原因示例：${blockedDetail.slice(0, 110)}…`));

    // ---- 14c · 导入的会话失效时，绝不替你重新登录 ----
    const importedSession = { ...liveSession!, origin: 'imported' as const };
    await app.vault.save(importedSession);
    check('会话已标记为 imported（用户自己提供的）', !mayReauthenticate(importedSession));

    const postsBefore = loginPosts();
    platform.invalidateSessions();
    const r14 = await app.engine.syncAll();
    const a14 = r14.accounts[0]!;

    equal('会话失效被识别为 auth-required', a14.status, 'auth-required');
    equal('本次同步的会话来源为 imported', a14.sessionOrigin, 'imported');
    equal('没有产生任何新的登录请求（不会把你顶下线）', loginPosts(), postsBefore);
    check('提示语明确告知「不会替你重新登录」', /不会替你重新登录/.test(a14.message ?? ''), a14.message?.slice(0, 90));
    equal('本次同步只读拦截数', a14.readOnly.blocked, 0);
    equal('本地数据依然完整', (await app.store.listTasks()).length, snapshotBefore7);

    // 用户主动选择重新登录时才发登录请求（这是用户的动作，不是我们的）
    await app.engine.login('mock', '20230001', { password: 's3cret' });
    check('用户主动重新登录后才出现新的登录请求', loginPosts() === postsBefore + 1, `login POST = ${loginPosts()}`);

    // ================================================================ 场景 15
    step(15, '零流量路线：HAR 录制 → 关闭平台 → 离线回放');
    console.log(
      paint('dim', '   把传输层换成「回放」后，同一个适配器、同一个引擎，' +
        '但全程一个网络请求都不发。\n   这一轮会真的把平台关掉，以证明回放不依赖它在线。'),
    );

    // 独立的工作目录，避免和前面的断言互相干扰
    const harWorkspace = await mkdtemp(join(tmpdir(), 'homework-hub-har-'));
    const harReminders: PlannedReminder[] = [];

    // 15a · 录制：包一层 RecordingHttpClient，在「已登录」的状态下正常同步一轮
    //（现实里这一步对应的是：你本来就在平台上操作，我们只是在旁边记录）
    const recorder = new RecordingHttpClient(new FetchHttpClient());
    const recordApp = await createApp({ workspace: harWorkspace, registry, clock, reminders: harReminders, logger, http: recorder });
    const recordAccount = await recordApp.engine.login('mock', '20230001', { password: 's3cret' }, { label: 'HAR 录制账号' });
    const r15a = await recordApp.engine.syncAll({ refreshCourses: 'always', accountIds: [recordAccount.id] });
    const a15a = r15a.accounts[0]!;
    printReport(r15a);

    equal('录制同步成功', a15a.status, 'ok');
    check('录到了足够多的接口', recorder.count >= 2, `共 ${recorder.count} 条：${recorder.summary().map((s) => s.path.split('?')[0]).join('、')}`);
    check('导出的 HAR 不含任何登录凭证', !recorder.containsSensitiveHeaders());
    check('导出的 HAR 不含平台下发的会话 cookie', !recorder.toHar().includes('MOCK_SESSION'));
    const harString = recorder.toHar();
    const liveTaskIds = (await recordApp.store.listTasks()).map((t) => t.title).sort();

    // 15b · 关闭平台 —— 从这里开始，任何网络访问都会立刻失败
    const requestsBeforeClose = platform.state.requestCount;
    await platform.close();
    console.log(paint('dim', '\n   [setup] Mock 平台已关闭。现在即使适配器想联网也会失败。'));

    // 15c · 离线回放：同一个适配器，传输层换成 HAR 回放
    const replayHttp = new HarReplayHttpClient(harString);
    const replayReminders: PlannedReminder[] = [];
    const replayApp = await createApp({
      workspace: harWorkspace,
      registry,
      clock,
      reminders: replayReminders,
      logger,
      http: replayHttp,
    });
    const r15c = await replayApp.engine.syncAll({ refreshCourses: 'always' });
    const a15c = r15c.accounts[0]!;
    printReport(r15c);

    equal('平台已关闭，同步仍然成功', a15c.status, 'ok');
    equal('回放拉到的任务数与真实同步一致', a15c.fetched, a15a.fetched);
    check(
      '回放产出的数据与真实同步完全一致（0 新增，全部命中既有记录）',
      a15c.created === 0 && a15c.updated === 0 && a15c.unchanged === a15a.created,
      `新增 ${a15c.created} · 更新 ${a15c.updated} · 未变 ${a15c.unchanged}（真实同步新增了 ${a15a.created} 条）`,
    );
    check('所有请求都从回放文件精确命中', replayHttp.stats.exactHits > 0 && replayHttp.stats.misses === 0,
      `精确命中 ${replayHttp.stats.exactHits} 次 · 兜底 ${replayHttp.stats.pathHits} 次 · 未命中 ${replayHttp.stats.misses} 次`);

    const replayTaskIds = (await replayApp.store.listTasks()).map((t) => t.title).sort();
    check('回放得到的任务清单与真实同步完全相同', JSON.stringify(replayTaskIds) === JSON.stringify(liveTaskIds),
      `共 ${replayTaskIds.length} 条`);

    console.log(paint('dim', `\n   [setup] 平台在整个回放期间收到 0 个请求（它已经关了）。` +
      `关闭前累计请求数 ${requestsBeforeClose}，此后未再变化。`));

    await recordApp.store.close();
    await replayApp.store.close();
    if (process.env.HH_KEEP !== '1') await rm(harWorkspace, { recursive: true, force: true }).catch(() => {});

    // ================================================================ 汇总
    heading('验证汇总');
    const store2 = await app.store.listSyncLog(account.id, 20);
    kv('同步日志条数', String(store2.length));
    kv('假平台收到的请求数', String(platform.state.requestCount));
    kv('保险箱密钥来源', app.vault.keySource);
    kv('待办任务数', String(upcoming.length));
    kv('累计产生提醒', String(reminders.length));
    console.log(
      `\n${failCount === 0 ? paint('green', '全部通过') : paint('red', '存在失败')}：` +
        `${paint('green', `${passCount} 通过`)} / ${paint(failCount > 0 ? 'red' : 'dim', `${failCount} 失败`)}\n`,
    );

    await app.store.close();
    return failCount === 0 ? 0 : 1;
  } finally {
    await platform.close();
    if (process.env.HH_KEEP !== '1') {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(paint('dim', `\n[setup] 保留工作目录：${workspace}`));
    }
  }
}

function printReport(report: SyncReport): void {
  for (const a of report.accounts) {
    const statusColor =
      a.status === 'ok' ? 'green' : a.status === 'partial' ? 'yellow' : a.status === 'auth-required' ? 'yellow' : 'red';
    console.log(
      `   ${paint(statusColor, `[${a.status}]`)} ${a.label}  拉取 ${a.fetched} 条 · ` +
        `新增 ${a.created} · 更新 ${a.updated} · 未变 ${a.unchanged} · 消失 ${a.vanished} · 删除 ${a.removed} · ` +
        `请求 ${a.http.requests} 次 · 耗时 ${a.durationMs}ms`,
    );
    // 只读承诺是一份要向用户交代的事，所以默认就展示，而不是塞进 debug 日志
    const ro = a.readOnly;
    const roText = `只读检查 ${ro.checked} 次 · 放行非 GET ${ro.allowedNonSafe} 次 · 拦截 ${ro.blocked} 次`;
    console.log(`   ${paint('dim', roText)}  ${paint('dim', `会话来源 ${a.sessionOrigin}`)}`);
    if (a.message) console.log(`   ${paint('dim', '原因：' + a.message)}`);
  }
  kv('合计', `请求 ${report.totals.requests} 次 · 限流等待 ${report.totals.throttledMs}ms · 总耗时 ${report.durationMs}ms`);
}

const KIND_LABEL: Record<string, string> = {
  homework: '作业',
  exam: '考试',
  quiz: '测验',
  'task-point': '任务点',
  discussion: '讨论',
  other: '其他',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待完成',
  submitted: '已提交',
  graded: '已出分',
  expired: '已过期',
  unknown: '未知',
};

function printTaskTable(tasks: UnifiedTask[], now: Date): void {
  if (tasks.length === 0) {
    console.log(paint('dim', '   （无待办）'));
    return;
  }
  const rows = tasks.map((t) => ({
    kind: KIND_LABEL[t.kind] ?? t.kind,
    title: t.title.length > 30 ? `${t.title.slice(0, 28)}…` : t.title,
    course: t.courseName.length > 12 ? `${t.courseName.slice(0, 10)}…` : t.courseName,
    countdown: formatEffective(t.deadline, t.deadlineAt, now),
    status: STATUS_LABEL[t.status] ?? t.status,
    rev: t.revision > 1 ? `r${t.revision}` : '',
  }));

  const w = {
    kind: Math.max(4, ...rows.map((r) => displayWidth(r.kind))),
    title: Math.max(6, ...rows.map((r) => displayWidth(r.title))),
    course: Math.max(4, ...rows.map((r) => displayWidth(r.course))),
    countdown: Math.max(6, ...rows.map((r) => displayWidth(r.countdown))),
    status: 4,
  };

  const hr = `${'─'.repeat(w.kind + 2)}┼${'─'.repeat(w.title + 2)}┼${'─'.repeat(w.course + 2)}┼${'─'.repeat(w.countdown + 2)}┼${'─'.repeat(w.status + 4)}`;
  console.log('');
  console.log(
    `   ${pad('类型', w.kind)} │ ${pad('标题', w.title)} │ ${pad('课程', w.course)} │ ${pad('倒计时', w.countdown)} │ 状态`,
  );
  console.log(`   ${paint('dim', hr)}`);
  for (const r of rows) {
    const overdue = r.countdown.startsWith('已逾期');
    const countdown = overdue ? paint('red', pad(r.countdown, w.countdown)) : paint('yellow', pad(r.countdown, w.countdown));
    const rev = r.rev ? paint('magenta', ` ${r.rev}`) : '';
    console.log(
      `   ${pad(r.kind, w.kind)} │ ${pad(r.title, w.title)} │ ${pad(r.course, w.course)} │ ${countdown} │ ${r.status}${rev}`,
    );
  }
}

/** 中文按 2 列宽计算，否则表格会错位。 */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

function pad(s: string, width: number): string {
  const diff = width - displayWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

// ------------------------------------------------------------------ 常规命令

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string | boolean> } {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

async function withApp<T>(
  fn: (app: App, clock: FakeClock) => Promise<T>,
  transport?: HttpClient,
): Promise<T> {
  const clock = new FakeClock(new Date());
  const logger = new ConsoleLogger({ level: (process.env.HH_LOG as 'debug') ?? 'info', color: useColor });
  const reminders: PlannedReminder[] = [];

  const registry = createRegistry(process.env.HH_MOCK_URL);

  const { homedir } = await import('node:os');
  const workspace = process.env.HH_HOME ?? join(homedir(), '.homework-hub');
  const app = await createApp({ workspace, registry, clock, reminders, logger, http: transport });

  try {
    return await fn(app, clock);
  } finally {
    await app.store.close();
  }
}

function printHelp(): void {
  console.log(`
${paint('bold', 'HomeworkHub CLI')} —— 跨平台课业聚合

用法：
  node apps/cli/src/main.ts <命令> [参数]

命令：
  ${paint('blue', 'demo')}                          跑完整的端到端能力验证（推荐先看这个）
  ${paint('blue', 'platforms')}                     列出已注册的平台适配器与能力
  ${paint('blue', 'accounts')}                      列出已登录账号及其同步状态
  ${paint('blue', 'login')} <platform> <user> <pwd>  登录并登记账号
  ${paint('blue', 'sync')} [--dry-run]              同步全部账号
  ${paint('blue', 'list')} [--days N] [--all]       查看待办（默认未来 14 天）
  ${paint('blue', 'changes')} [--days N]            查看最近的作业变更（改期、出新分）
  ${paint('blue', 'log')} [--limit N]               查看同步日志
  ${paint('blue', 'vault')}                         检查会话保险箱状态

零影响路线（不碰你的登录态）：
  ${paint('green', 'record')} <platform> <user> <pwd> --out capture.har
      登录并同步一轮，把响应录成脱敏 HAR（供离线回放 / 适配器调试）。
  ${paint('green', 'import-har')} <platform> <file.har>
      全程零网络请求。也可以直接用浏览器 DevTools 导出的 HAR：
      打开平台作业页 → Network → 右键「Save all as HAR with content」→ 交给本命令。
      适合首次导入、以及不想让本工具接触任何账号的情况。
  ${paint('green', 'attach')} <platform> [--port 9222] [--match 关键词]
      借用你已登录的浏览器发请求（需带 --remote-debugging-port=9222 启动浏览器）。
      cookie 由浏览器自动附带，本工具读不到也存不了 —— 凭据不过手。

环境变量：
  HH_HOME      数据目录（默认 ~/.homework-hub）
  HH_LOG       日志级别 debug|info|warn|error
  HH_TRACE=1   打印每个 HTTP 请求（含 cookie，仅调试用）
  HH_KEEP=1    demo 结束后保留临时工作目录

说明：
  真实平台适配器（chaoxing / yuketang / ismart）的接口路径来自社区开源项目的公开信息，
  需要你用真实账号逐条验证后再投入使用。当前 demo 走本地 Mock 平台，
  目的是证明「核心引擎」的行为正确，而不是证明「逆向结论」正确。
`);
}

async function main(): Promise<number> {  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'demo':
      return runDemo();

    case 'platforms':
      return withApp(async (app) => {
        heading('已注册的平台适配器');
        for (const a of app.registry.list()) {
          console.log(`\n  ${paint('bold', a.displayName)}  ${paint('dim', a.id)}`);
          kv('入口', a.homepage || '（本地）');
          kv(
            '能力',
            Object.entries(a.capabilities)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(', ') || '无',
          );
          kv(
            '登录方式',
            a.authMethods.map((m) => `${m.label}(${m.fields.map((f) => f.key).join('/')})`).join('、'),
          );
        }
        return 0;
      });

    case 'accounts':
      return withApp(async (app) => {
        const accounts = await app.engine.listAccounts();
        heading('已登录账号');
        if (accounts.length === 0) {
          console.log(paint('dim', '  （无。先用 login 命令添加）'));
          return 0;
        }
        for (const a of accounts) {
          const icon = a.lastSyncStatus === 'ok' ? paint('green', '●') : paint('yellow', '○');
          console.log(
            `  ${icon} ${a.label}  ${paint('dim', `${a.platformId} · ${maskUsername(a.username)}`)}`,
          );
          kv('最近同步', a.lastSyncAt ? new Date(a.lastSyncAt).toLocaleString('zh-CN') : '从未');
          if (a.lastSyncMessage) kv('状态', a.lastSyncMessage);
        }
        return 0;
      });

    case 'login': {
      const [platformId, username, password] = positional;
      if (!platformId || !username || !password) {
        console.error(paint('red', '用法：login <platform> <username> <password>'));
        return 2;
      }
      return withApp(async (app) => {
        const account = await app.engine.login(platformId, username, { password });
        console.log(paint('green', `✓ 已登录 ${account.label}（${account.platformId}）`));
        return 0;
      });
    }

    case 'sync':
      return withApp(async (app) => {
        heading('同步');
        const report = await app.engine.syncAll({ dryRun: flags.get('dry-run') === true });
        printReport(report);
        return report.totals.failed > 0 ? 1 : 0;
      });

    case 'list': {
      const days = Number(flags.get('days') ?? 14);
      const all = flags.get('all') === true;
      return withApp(async (app) => {
        heading(`待办${all ? '（全部）' : `（未来 ${days} 天）`}`);
        const tasks = await app.engine.upcoming({ withinDays: all ? 3650 : days, includeOverdue: true });
        printTaskTable(tasks, new Date());
        console.log(paint('dim', `\n  共 ${tasks.length} 条`));
        return 0;
      });
    }

    case 'changes': {
      const days = Number(flags.get('days') ?? 7);
      return withApp(async (app) => {
        heading(`最近 ${days} 天的变更`);
        const since = new Date(Date.now() - days * 86_400_000);
        const changes = await app.engine.recentChanges(since);
        if (changes.length === 0) {
          console.log(paint('dim', '  （无变更）'));
          return 0;
        }
        for (const { task, changes: list } of changes) {
          console.log(`\n  ${paint('bold', task.title)}  ${paint('dim', task.courseName)}`);
          for (const c of list) {
            console.log(`    ${paint('magenta', c.field)}: ${c.from ?? '(空)'} → ${c.to ?? '(空)'}`);
          }
        }
        return 0;
      });
    }

    case 'log':
      return withApp(async (app) => {
        heading('同步日志');
        const limit = Number(flags.get('limit') ?? 20);
        const accounts = await app.engine.listAccounts();
        const entries = [];
        for (const a of accounts) entries.push(...(await app.store.listSyncLog(a.id, limit)));
        entries.sort((x, y) => y.finishedAt.localeCompare(x.finishedAt));
        for (const e of entries.slice(0, limit)) {
          const color = e.status === 'ok' ? 'green' : e.status === 'partial' ? 'yellow' : 'red';
          console.log(
            `  ${paint('dim', new Date(e.finishedAt).toLocaleString('zh-CN'))} ${paint(color, `[${e.status}]`)} ` +
              `${e.platformId} 拉取 ${e.fetched} · 新增 ${e.created} · 更新 ${e.updated} · 删除 ${e.removed}`,
          );
          if (e.message) console.log(`    ${paint('dim', e.message)}`);
        }
        return 0;
      });

    case 'vault':
      return withApp(async (app) => {
        heading('会话保险箱');
        kv('密钥来源', app.vault.keySource);
        kv('密钥文件', app.keyPath);
        const accounts = await app.engine.listAccounts();
        for (const a of accounts) {
          const session = await app.vault.load(a.id);
          const inspect = await app.vault.debugInspect(a.id);
          console.log(`\n  ${paint('bold', a.label)}`);
          kv('密文大小', `${inspect.bytes} 字节`);
          kv('明文泄露', inspect.leaksPlaintext ? paint('red', '是（异常！）') : paint('green', '否'));
          kv('Cookie 数', String(Object.keys(session?.cookies ?? {}).length));
          kv('过期时间', session?.expiresAt ? new Date(session.expiresAt).toLocaleString('zh-CN') : '未声明（靠探测）');
        }
        return 0;
      });

    // ---------------------------------------------------------------- 零影响路线

    /**
     * 录制一轮同步并导出脱敏 HAR。
     * 这是 import-har 的配套命令：不用碰 DevTools 也能产出回放文件，
     * 也是适配器开发时固化真实响应的标准做法。
     */
    case 'record': {
      const [platformId, username, password] = positional;
      const outFile = flags.get('out');
      if (!platformId || !username || !password || typeof outFile !== 'string') {
        console.error(paint('red', '用法：record <platform> <user> <pwd> --out capture.har'));
        console.error(paint('dim', '  登录并同步一轮，把响应录成脱敏 HAR（供 import-har 离线回放）。'));
        return 2;
      }
      const recorder = new RecordingHttpClient(new FetchHttpClient());
      return withApp(
        async (app) => {
          heading(`录制 · ${platformId}`);
          await app.engine.login(platformId, username, { password });
          const report = await app.engine.syncAll({ refreshCourses: 'always' });
          printReport(report);

          const { writeFile } = await import('node:fs/promises');
          await writeFile(outFile, recorder.toHar(), 'utf8');
          kv('已写入', outFile);
          kv('录制条目', String(recorder.count));
          kv('敏感头检查', recorder.containsSensitiveHeaders() ? paint('red', '发现泄露（异常！）') : paint('green', '已全部脱敏'));
          for (const s of recorder.summary()) {
            console.log(paint('dim', `    ${s.method} ${s.path} → ${s.status}`));
          }
          console.log(paint('dim', '\n  之后可离线回放：' +
            `node apps/cli/src/main.ts import-har ${platformId} ${outFile}`));
          return report.totals.failed > 0 ? 1 : 0;
        },
        recorder,
      );
    }

    /**
     * HAR 回放：全程不发一个网络请求。
     *
     * 用法：在浏览器里打开平台的作业页面（确保登录且数据加载完整），
     * DevTools → Network → 右键 →「Save all as HAR with content」，
     * 然后把文件交给这条命令。
     */
    case 'import-har': {
      const [platformId, file] = positional;
      if (!platformId || !file) {
        console.error(paint('red', '用法：import-har <platform> <capture.har>'));
        console.error(paint('dim', '  例：import-har chaoxing D:\\Downloads\\学习通.har'));
        return 2;
      }
      const har = await readUtf8(file);
      const replayClient = new HarReplayHttpClient(har);
      const replayStats = replayClient.stats;

      return withApp(
        async (app) => {
          heading(`HAR 回放 · ${platformId}`);
          kv('抓包文件', file);
          kv('已录制接口', `${replayStats.total} 条`);

          const account = await app.engine.registerOfflineAccount(platformId, 'har-import', {
            label: `${platformId}（HAR 回放）`,
          });
          kv('账号', `${account.label}（未发出任何登录请求）`);

          // 关键：必须只同步这个离线账号。
          // 如果不指定 accountIds，引擎会把库里所有账号都同步一遍 ——
          // 其中可能有挂着真实会话的账号，那就会真的去请求平台，
          // 「零网络请求」的承诺就被这一行代码悄悄破坏了。
          // 这正是「离线路径必须显式圈定范围」的原因：默认行为是全局的，
          // 而全局行为对离线场景是危险的。
          const report = await app.engine.syncAll({ refreshCourses: 'always', accountIds: [account.id] });
          printReport(report);
          kv('回放命中', `精确 ${replayStats.exactHits} · 兜底 ${replayStats.pathHits} · 未命中 ${replayStats.misses}`);

          const tasks = await app.engine.upcoming({ withinDays: 3650, includeOverdue: true });
          heading('解析出的待办');
          printTaskTable(tasks, new Date());
          console.log(paint('dim', `\n  共 ${tasks.length} 条。注意：回放是快照，看到的是录制那一刻的数据。`));
          return report.totals.failed > 0 ? 1 : 0;
        },
        replayClient,
      );
    }

    /**
     * CDP 附着：借用你已登录的浏览器发请求。
     * 凭据不过手 —— cookie 由浏览器自动附带，我们读不到。
     */
    case 'attach': {
      const [platformId] = positional;
      if (!platformId) {
        console.error(paint('red', '用法：attach <platform> [--port 9222] [--match 关键词]'));
        console.error(paint('dim', '  先给浏览器快捷方式加 --remote-debugging-port=9222 并登录平台。'));
        return 2;
      }
      const port = Number(flags.get('port') ?? 9222);
      const match = flags.get('match');
      const matchText = match === true || match === undefined ? undefined : String(match);

      return withApp(
        async (app) => {
          heading(`CDP 附着 · ${platformId}`);
          kv('调试端口', `http://127.0.0.1:${port}`);
          if (matchText) kv('标签页匹配', matchText);

          const targets = await discoverCdpTargets(`http://127.0.0.1:${port}`);
          kv('可见标签页', String(targets.filter((t) => t.type === 'page').length));
          for (const t of targets.filter((x) => x.type === 'page').slice(0, 8)) {
            console.log(paint('dim', `    · ${t.title} — ${t.url.slice(0, 70)}`));
          }

          await app.engine.registerOfflineAccount(platformId, 'cdp', { label: `${platformId}（CDP 附着）` });
          // 同 import-har：只同步这个账号，避免把库里挂着真实会话的其他账号
          // 也一起拉一遍 —— 附着路线的请求应该全部来自用户的浏览器。
          const report = await app.engine.syncAll({ refreshCourses: 'always', accountIds: [`${platformId}::cdp`] });
          printReport(report);

          const tasks = await app.engine.upcoming({ withinDays: 3650, includeOverdue: true });
          heading('解析出的待办');
          printTaskTable(tasks, new Date());
          return report.totals.failed > 0 ? 1 : 0;
        },
        new CdpHttpClient({
          debugBase: `http://127.0.0.1:${port}`,
          targetUrlMatch: matchText,
        }),
      );
    }

    case 'help':
    default:
      printHelp();
      return command === 'help' ? 0 : 2;
  }
}

// 顶层兜底：任何未捕获异常都应输出可读信息，而不是一堆堆栈
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    if (e instanceof HubError) {
      console.error(paint('red', `✗ [${e.code}] ${e.message}`));
    } else {
      console.error(paint('red', `✗ ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
    }
    process.exitCode = 1;
  });
