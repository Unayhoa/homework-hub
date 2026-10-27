/**
 * 与传输层无关的 API 实现。
 *
 * 抽出来的动机：同一个 API 需要跑在两种载体上 ——
 *   1. 桌面/局域网的 Node HTTP 服务（server.ts）
 *   2. Android WebView 里（页面直接用 fetch 拦截，不经过网络）
 *
 * 如果把 API 逻辑写在 server.ts 里，Android 端就只能复制一份，
 * 两份实现必然漂移（改了桌面忘了改手机）。所以这里只依赖端口
 * （HubStore / Vault / SyncEngine / AdapterRegistry），不碰 node:http。
 */
import {
  CdpHttpClient,
  canMarkCompleted,
  needsManualCompletion,
  completionOrigin,
  DEFAULT_NOTIFY_PREFS,
  effectiveStatus,
  HarReplayHttpClient,
  HubError,
  canSkip,
  validateConfig,
  normalizeAdapterConfig,
  hasPendingAc,
  ADAPTER_PROMPT,
  drillPack,
  ADAPTER_PITFALLS,
  isTerminalStatus,
  MIN_GAP_HOURS,
  normalizeNotifyPrefs,
  NOTIFY_LEVEL_LABELS,
  NOTIFY_PRESETS,
  SyncEngine,
  UnavailableSigner,
  analyzeSamples,
  buildConfig,
  buildFixPack,
  classifyFailure,
  buildSamplePack,
  packStorageKey,
  appendPackHistory,
} from '#core';
import type { ProbeSample, FailureKind, SamplePack } from '#core';

import { parseImport, toManualInput } from './adapter-import.ts';
import type {
  AdapterRegistry,
  Clock,
  HttpClient,
  Logger,
  NotifyPrefs,
  PlannedReminder,
  SyncReport,
  UnifiedTask,
  Vault,
  HubStore,
} from '#core';

// ---------------------------------------------------------------- DTO

export interface TaskDto {
  id: string;
  kind: string;
  title: string;
  courseName: string;
  /** 内部课程 ID（删除整个课程时用） */
  courseId: string;
  /** 所属账号（删除操作要定位到账号） */
  accountId: string;
  /**
   * **生效状态**（不是原始 status）—— 用户手标的"已完成"会在这里体现为 submitted。
   * 界面只认它，避免前端自己再写一遍"平台优先"规则。
   */
  status: string;
  /** 'platform' | 'manual' —— 界面上给手动标记的条目加「手动」标注，别让本地数据伪装成平台数据 */
  completionOrigin: string | null;
  /** 用户是否标记过完成（哪怕此刻被平台优先规则压住） */
  manualCompleted: boolean;
  /** 该不该显示「标记完成」按钮 —— 判据与生效规则同源，所以有按钮就必然点了有效 */
  canManualComplete: boolean;
  /**
   * 这条任务**必须用户自己标已完成**才会消掉 —— 因为平台根本不报完成状态
   * （目前只有长江雨课堂，见 yuketang 适配器的字段取证）。
   *
   * 为什么由后端算而不是把 statusSource 丢给前端判：这条判据决定卡片上教不教
   * 用户"点 ✓"。判错是双向的 —— 多给就是每张卡都多一行噪音，少给就是
   * 「做完了、卡片永远不清」的静默失败。判据只能有一处。
   */
  needsManualComplete: boolean;
  /** 用户标过「不用交」（小组由别人交 / 免修 / 换课） */
  manualSkipped: boolean;
  /**
   * 能不能标「不用交」。
   * 与 canManualComplete 不同：**不受「平台优先」限制** —— 平台说"你还没交"
   * 并不否定"这条不用你交"，它根本不知道这件事。
   */
  canSkip: boolean;
  deadline: unknown;
  deadlineAt: string | null;
  /**
   * 题目级进度（PTA 这类「一份作业 = N 道题」的平台才有）。
   * 没给就是 null —— 界面据此决定要不要画进度条，其他平台完全不受影响。
   */
  progress: { submitted: number; accepted: number; total: number } | null;
  /** 每题摘要（只在点开详情时渲染，列表里不用） */
  subtasks: Array<{ label: string; score: number; status: string }> | null;
  /**
   * 「题全交了，但还没全 AC，且没过期」。
   * 这一档留在待办页（用户还会回来刷 AC），但：不排提醒、不进已完成、排在同组末尾。
   */
  pendingAc: boolean;
  revision: number;
  url: string | null;
  platformId: string;
  /** 手动任务的平台名（用户自己填的文字）；平台任务为 null */
  platformLabel: string | null;
}

/**
 * 任务 DTO。刻意不带 raw（平台原始报文）与 history ——
 * 页面用不到，没必要送出去（也就没必要落进浏览器的内存里）。
 */
export function taskDto(t: UnifiedTask): TaskDto {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    courseName: t.courseName,
    courseId: t.courseId,
    accountId: t.accountId,
    status: effectiveStatus(t),
    completionOrigin: completionOrigin(t),
    manualCompleted: Boolean(t.userCompletedAt),
    canManualComplete: canMarkCompleted(t),
    needsManualComplete: needsManualCompletion(t),
    manualSkipped: Boolean(t.userSkippedAt),
    canSkip: canSkip(t),
    deadline: t.deadline,
    deadlineAt: t.deadlineAt ?? null,
    progress: t.progress ?? null,
    subtasks: t.subtasks ?? null,
    pendingAc: hasPendingAc(t, new Date()),
    revision: t.revision,
    url: t.sourceUrl ?? null,
    platformId: t.platformId,
    platformLabel: t.platformLabel ?? null,
  };
}

export interface PlatformSummary {
  id: string;
  displayName: string;
  homepage: string;
  capabilities: Record<string, boolean>;
  authMethods: Array<{
    id: string;
    label: string;
    kind: string;
    hint?: string;
    fields: Array<{ key: string; label: string; secret?: boolean }>;
  }>;
  experimental: boolean;
  /** 该路线的数据来源是否需要在浏览器里登录（Android 端用来决定「去登录」按钮） */
  loginUrl: string;
}

export function platformSummaries(registry: AdapterRegistry): PlatformSummary[] {
  return registry.list().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    homepage: a.homepage,
    capabilities: { ...a.capabilities } as Record<string, boolean>,
    authMethods: a.authMethods.map((m) => ({
      id: m.id,
      label: m.label,
      kind: m.kind,
      ...(m.hint ? { hint: m.hint } : {}),
      // 「应用内登录」需要知道打开哪个页面 —— 由适配器声明（它最懂自家登录页）
      ...(m.loginUrl ? { loginUrl: m.loginUrl } : {}),
      fields: m.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret === true })),
    })),
    experimental: a.id !== 'mock',
    loginUrl: a.homepage,
  }));
}

// ---------------------------------------------------------------- 依赖

export interface ApiDeps {
  engine: SyncEngine;
  store: HubStore;
  vault: Vault;
  registry: AdapterRegistry;
  logger: Logger;
  clock: Clock;
  /** 最近提醒（内存环形缓冲），由调用方持有 */
  reminders: PlannedReminder[];
  /**
   * 构造离线路线的传输层。
   * Android 端会把 CDP 换成一个「不支持」的实现 —— CDP 依赖本机浏览器调试端口，
   * 手机上不存在这个概念，与其让它抛一个看不懂的错，不如显式声明不支持。
   */
  buildTransport: (kind: 'replay' | 'attach', payload: Record<string, unknown>) => Promise<HttpClient>;
  /**
   * 提醒偏好的读写（密度档位 / 每日汇总）。
   *
   * 为什么由调用方注入、而不是这里直接碰 localStorage：
   * Android 用的其实是**原生 KV**（真机踩过 localStorage 择机刷盘导致丢数据），
   * 而引擎读的也是那一份。若这里写 localStorage、引擎读原生 KV，就会出现
   * "用户改了设置、提醒行为没变"这种最难查的静默失败 ——
   * 所以两边必须是**同一个 storage**，由入口统一注入。
   */
  notifyPrefs?: {
    read(): Required<NotifyPrefs>;
    write(raw: unknown): Required<NotifyPrefs>;
  };
  /**
   * 把样本包额外存一份到文件（只桌面端实现；Android 没有可写的项目目录）。
   *
   * 存在的理由：手机端把样本存在 store 里，用户只能靠「复制」把它带出来；
   * 而开发侧需要的是仓库里 `samples/<host>/<ts>.json` 这样的文件 —— 能被
   * `probe-samples.test.ts` 直接读进来当回归判据。两边都要有，但两边形态不同。
   * 不注入就不写文件，功能照常（样本仍在 store 里）。
   */
  saveSample?: (pack: SamplePack) => Promise<{ path: string }>;
}

export interface ApiRequest {
  method: string;
  /** 形如 /api/state，已去掉末尾斜杠 */
  pathname: string;
  search: URLSearchParams;
  /** 原始请求体字符串（可能为空） */
  body: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse>;

// ---------------------------------------------------------------- 实现

export function createApiHandler(deps: ApiDeps): ApiHandler {
  let inFlight: Promise<SyncReport> | undefined;

  /** 没注入时的兜底：内存版（桌面 / 测试）。读写都过归一化，不抛。 */
  const prefsOf = () =>
    deps.notifyPrefs ?? {
      read: () => ({ ...DEFAULT_NOTIFY_PREFS }),
      write: (raw: unknown) => normalizeNotifyPrefs(raw),
    };

  /**
   * 同步必须串行。不只是省资源：两个并发同步会在合并阶段互相干扰
   * 「消失/恢复」的判定。所以复用进行中的同步，而不是排队两个。
   */
  function runSync(opts: { allowRelogin?: boolean } = {}): Promise<SyncReport> {
    if (inFlight) return inFlight;
    inFlight = deps.engine
      .syncAll({ allowRelogin: opts.allowRelogin !== false })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  /**
   * 会话 cookie 名单诊断（`sessionCookieDiag`）与账号页那块折起展示，
   * 已于 2026-10-13 一并删除。
   *
   * 它当初要回答的是「iSmart 到底断在哪一环」，而这个问题早已有结论：
   * cookie 一直在本机（掉线是服务端闲置作废），真正杀死会话的是夜里没有网。
   * **诊断工具用完就该撤** —— 留着不但给正常使用添噪音，还会把人往回引
   * （"日志里那些 cookie 名单"看起来像有用信息，其实与结论无关）。
   */
  function summarize(report: SyncReport) {
    return {
      ok: report.totals.failed === 0,
      totals: report.totals,
      accounts: report.accounts.map((x) => ({
        label: x.label,
        platformId: x.platformId,
        accountId: x.accountId,
        status: x.status,
        message: x.message ?? null,
        fetched: x.fetched,
        created: x.created,
        updated: x.updated,
        removed: x.removed,
        readOnlyBlocked: x.readOnly.blocked,
        sessionOrigin: x.sessionOrigin,
      })),
    };
  }

  /** 用指定传输层另起一个引擎实例（存储/保险箱共用） */
  function subEngine(http: HttpClient, tag: string): SyncEngine {
    return new SyncEngine({
      registry: deps.registry,
      store: deps.store,
      vault: deps.vault,
      http,
      clock: deps.clock,
      logger: deps.logger.child({ transport: tag }),
      signer: new UnavailableSigner(),
    });
  }

  /**
   * 确保「用户添加的平台」已注册进适配器表。
   *
   * 配置持久化在库里，但注册表是内存态：**进程一重启就空了**。
   * 之前只在启用那一刻注册过，于是重启后同步直接报「未找到平台适配器」——
   * 看起来像配置丢了，其实是没人把它变成适配器。
   */
  let customLoaded = false;
  async function ensureCustomAdaptersLoaded(): Promise<void> {
    if (customLoaded) return;
    await deps.engine.loadCustomAdapters();
    customLoaded = true;
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const { method, pathname: path, search } = req;

    // 「用户自己添加的平台」配置存在库里，但注册表是内存态 —— 每次进程启动都是空的。
    // 之前只在「启用」那一刻注册过，于是重启后同步会报「未找到平台适配器 custom-xxx」：
    // 配置明明在，就是没人把它变成适配器。所以每个请求进门前都确保注册一次（幂等）。
    try {
      await ensureCustomAdaptersLoaded();
    } catch {
      // 注册失败不该让整个 API 挂掉；具体哪些平台不可用会在同步日志里体现
    }

    try {
      const parseBody = (): Record<string, unknown> => {
        if (!req.body.trim()) return {};
        try {
          return JSON.parse(req.body) as Record<string, unknown>;
        } catch {
          throw new Error('请求体不是合法 JSON');
        }
      };

      // ---- 读 ----
      // ---- 提醒设置（密度档位 / 每日汇总）----
      if (method === 'GET' && path === '/api/settings') {
        return {
          status: 200,
          body: {
            settings: prefsOf().read(),
            // 预设与护栏参数一并给出：界面用**同一份**数据渲染，
            // 而不是前端再硬编码一遍 —— 两份必然漂移（这个坑项目里踩过）
            presets: NOTIFY_PRESETS,
            levelLabels: NOTIFY_LEVEL_LABELS,
            minGapHours: MIN_GAP_HOURS,
          },
        };
      }

      if (method === 'POST' && path === '/api/settings') {
        const body = parseBody();
        const next = prefsOf().write(body.settings ?? body);
        // 改完**立刻重排**，否则要等下一次同步才生效（"改了没反应"）
        await deps.engine.rescheduleNotifications();
        return { status: 200, body: { settings: next } };
      }

      if (method === 'GET' && path === '/api/state') {
        const accounts = await deps.engine.listAccounts();
        // 窗口必须覆盖一整个学期，而不是 60 天。
        // 真机踩过（2026-10-23）：PTA 一个「不限时间」的选做题 69 天后截止，
        // 被 60 天窗口整条切掉 —— 用户看到的是「这个题目集没抓到」，
        // 而数据其实在库里。远期作业不该消失，它只是排在「更晚」那组。
        const tasks = await deps.engine.upcoming({ withinDays: 365, includeOverdue: true });
        // 只传**改过名的**课程（id → 显示名）：没改名的任务直接用自己的 courseName，
        // 这样这个映射通常是个空对象，不会把 state 撑大。
        const courseTitles: Record<string, string> = {};
        for (const a of accounts) {
          for (const c of await deps.engine.listCoursesWithState(a.id)) {
            if (c.displayName) courseTitles[c.id] = c.displayName;
          }
        }
        const now = Date.now();
        const bucket = (t: UnifiedTask): string => {
          if (t.deadline.kind !== 'absolute') return t.deadline.kind === 'open' ? 'open' : 'unknown';
          const ms = new Date(t.deadline.at).getTime() - now;
          if (ms < 0) return 'overdue';
          if (ms < 86_400_000) return 'today';
          if (ms < 3 * 86_400_000) return 'soon';
          return 'later';
        };
        const grouped: Record<string, TaskDto[]> = { overdue: [], today: [], soon: [], later: [], open: [], unknown: [] };
        for (const t of tasks) (grouped[bucket(t)] ??= []).push(taskDto(t));

        // 已完成（已提交/已批阅/已过期）：供用户对照平台界面核对数据完整性。
        // 上限 300：超星一门学期就可能有上百条历史作业，100 会把它们截掉 ——
        // 「数据在库里但界面看不到」和真的丢数据一样让人没底。
        const completed = (await deps.engine.completed({ limit: 300 })).map(taskDto);

        // 未来的通知排期（纯计算，无副作用）—— 上面响应体里要用
        const notifications = await deps.engine.upcomingNotifications();

        // hasCredentials：保险箱里是否存了这个账号的密码（决定 UI 显示「可一键重登」徽标）
        const accountDtos = [];
        for (const a of accounts) {
          const s = await deps.vault.load(a.id);
          accountDtos.push({
            id: a.id,
            label: a.label,
            platformId: a.platformId,
            username: a.username,
            enabled: a.enabled,
            lastSyncAt: a.lastSyncAt ?? null,
            lastSyncStatus: a.lastSyncStatus ?? null,
            lastSyncMessage: a.lastSyncMessage ?? null,
            hasCredentials: Boolean(s?.credentials?.password) && s?.origin !== 'imported',
          });
        }

        // ---- 数据体检 ----
        // 「库里有多少 / 界面上看得见多少 / 差在哪」必须能一眼看清。
        // 真机踩过两次「数据在库里但界面完全看不到」：一次是标题指纹把任务合并掉，
        // 一次是期限未知的任务被 upcoming 整体丢弃 —— 两次都只能靠猜，
        // 因为界面上没有任何地方能看出「有多少条被藏起来了」。
        const allTasks = await deps.store.listTasks({ includeDeleted: true });
        const visibleIds = new Set([...tasks, ...completed].map((t) => t.id));
        // 用统一的判定函数 —— 这里原来自己写了一遍终态列表，
        // 与 upcoming/completed 各写一遍是同一个隐患（加规则要改多处）。
        const storeStats = (
          deps.store as unknown as { stats?: () => { bytes: number; lastError: string | null } }
        ).stats?.();
        const hiddenUnknownDeadline = allTasks.filter(
          (t) =>
            !t.deletedAt &&
            !t.userDeletedAt &&
            !isTerminalStatus(effectiveStatus(t)) &&
            t.deadline.kind !== 'absolute' &&
            t.deadline.kind !== 'relative' &&
            !visibleIds.has(t.id),
        ).length;
        const diag = {
          total: allTasks.length,
          visible: visibleIds.size,
          hiddenSoftDeleted: allTasks.filter((t) => t.deletedAt && !t.userDeletedAt).length,
          hiddenUserDeleted: allTasks.filter((t) => t.userDeletedAt).length,
          hiddenUnknownDeadline,
          // 存储健康度：换介质（localStorage → 原生文件）之后，
          // 用户与开发者都能一眼确认「这次真的写下去了」。
          store: storeStats ? { bytes: storeStats.bytes, lastError: storeStats.lastError } : null,
          byPlatform: Object.fromEntries(
            [...new Set(allTasks.map((t) => t.platformId))].map((pid) => [
              pid,
              {
                total: allTasks.filter((t) => t.platformId === pid).length,
                visible: allTasks.filter((t) => t.platformId === pid && visibleIds.has(t.id)).length,
              },
            ]),
          ),
        };

        return {
          status: 200,
          body: {
            accounts: accountDtos,
            courseTitles,
            grouped,
            completed,
            counts: {
              overdue: grouped.overdue!.length,
              today: grouped.today!.length,
              soon: grouped.soon!.length,
              total: tasks.length,
              // 已交完、只差 AC 的条数：界面用 total - pendingAc 显示「还有几件事没做完」，
              // 否则「已交」的作业会把待办数撑虚 —— 那个数字是给自己看的，不能骗自己。
              pendingAc: tasks.filter((t) => hasPendingAc(t, new Date())).length,
            },
            diag,
            syncing: inFlight !== undefined,
            lastSyncAt: accounts.map((x) => x.lastSyncAt).filter(Boolean).sort().at(-1) ?? null,
            platforms: platformSummaries(deps.registry),
            reminders: deps.reminders.slice(0, 20).map((r) => ({
              title: r.title,
              body: r.body,
              fireAt: r.fireAt,
              dueAt: r.dueAt,
            })),
            // 通知栏排期：界面用它显示「已排期 N 条 · 下一条 …」。
            // 也算作一处可验证性 —— 提醒这条链路完全是异步的（到点在系统里发生），
            // 用户没法在界面上"看到"它到底排了没有，只能靠这里交底。
            notify: {
              scheduled: notifications.length,
              next: notifications[0]
                ? { title: notifications[0].title, fireAt: notifications[0].fireAt }
                : null,
              total: notifications.length,
            },
          },
        };
      }

      if (method === 'GET' && path === '/api/tasks') {
        const days = Number(search.get('days') ?? 60);
        const tasks = await deps.engine.upcoming({ withinDays: days, includeOverdue: true });
        return { status: 200, body: { tasks: tasks.map(taskDto) } };
      }

      if (method === 'GET' && path === '/api/courses') {
        // 课程管理用：每个账号下的课程 + 是否「不再同步」+ 任务数。
        // 单独一个端点（不塞进 /api/state）：它要按账号逐个查库，
        // 而 state 是每次刷新都要走的路径。
        const accounts = await deps.engine.listAccounts();
        const groups = [];
        for (const a of accounts) {
          groups.push({
            accountId: a.id,
            label: a.label,
            platformId: a.platformId,
            courses: await deps.engine.listCoursesWithState(a.id),
          });
        }
        return { status: 200, body: { groups } };
      }

      // 把一份「接入配置」启用成真正的平台：注册适配器 + 建账号。
      // 启用之后这个平台和超星 / iSmart 完全等价（同步、提醒、变更历史都走同一条链路）。
      if (method === 'POST' && path === '/api/adapter/enable') {
        const body = parseBody();
        let cfg = body.config as Record<string, unknown> | undefined;
        let fallbackError: string | undefined;
        if (!cfg && body.text) {
          const parsed = parseImport(String(body.text));
          cfg = parsed.adapterDraft as Record<string, unknown> | undefined;
          fallbackError = parsed.error;
        }
        if (!cfg) {
          return { status: 200, body: { ok: false, error: fallbackError ?? '没有找到接入配置' } };
        }
        // AI 给的是 { platform: {name, origin}, ... }，内部要的是摊平后的形状；
        // key 由域名派生（它从来不是提示词要求的字段，之前当必填把正确配置全拒了）。
        const normalized = normalizeAdapterConfig(cfg);
        // 接口要课程 ID，而 AI 只能给占位符 —— 从用户粘贴的原文里捞一个真实值兜底
        // （证据包的页面地址里通常就有 ?courseId=11430986）。
        // 平台名：配置里的往往是域名（wenda），用户在界面上填的优先
        if (body.name && String(body.name).trim()) {
          (normalized as unknown as { name?: string }).name = String(body.name).trim();
        }
        if (!(normalized as unknown as { defaultCourseId?: string }).defaultCourseId && body.text) {
          const m = /[?&]courseId=(\d{3,})/.exec(String(body.text));
          if (m) (normalized as unknown as { defaultCourseId?: string }).defaultCourseId = m[1];
        }
        cfg = normalized as unknown as Record<string, unknown>;
        const missing = validateConfig(normalized);
        if (missing.length > 0) {
          return { status: 200, body: { ok: false, error: `配置还缺：${missing.join('、')}` } };
        }
        const c = cfg as unknown as { key: string; name: string };
        // **启用前必须试抓通过。**
        //
        // 为什么把门槛放在这里、而不是只放在探查流程里：AI 粘回来的配置也走这个端点，
        // 而它同样可能是错的。放行一份跑不通的配置，用户拿到的是"平台加好了、
        // 待办永远是空的"—— 那是最难自查的一种失败（什么错误都没发生）。
        //
        // DOM 模式例外：它在点选那一步已经当真试抓过一次（抓到 N 条才让你回传），
        // 而且这里没有页面可抓，硬试只会得到一句"当前环境没有后台页面能力"。
        if ((cfg as { mode?: string }).mode !== 'dom') {
          const trial = await deps.engine.previewCustomAdapter(normalized);
          if (!trial.ok) {
            const err = trial.error ?? '接口能访问，但一条作业也没读出来';
            return {
              status: 200,
              body: {
                ok: false,
                error: err,
                trial: { count: trial.tasks.length, preview: trial.tasks.slice(0, 3).map((t) => ({ title: t.title, courseName: t.courseName })) },
                fix: buildFixPack({
                  code: trial.code ?? 'UNKNOWN',
                  error: err,
                  config: cfg,
                  platformName: c.name,
                  origin: String((cfg as { origin?: string }).origin ?? ''),
                }),
              },
            };
          }
        }
        await deps.engine.saveCustomAdapter(cfg as never);
        const platformId = `custom-${c.key}`;
        // 重新启用同一份配置（修正版）时，必须先把旧实例踢出注册表 ——
        // 否则用户改完点同步，跑的仍是旧对象，表现为「我明明改了却没生效」。
        deps.registry.unregister(platformId);
        await deps.engine.loadCustomAdapters();
        await deps.engine.registerOfflineAccount(platformId, 'web', {
          label: c.name,
          freshLogin: true,
          // 用户点了「启用为平台」—— 这就是明确确认。
          // 否则会撞上'这个账号此前已被你移除'的墓碑保护，而界面上并没有第二个确认键。
          explicit: true,
        });
        return { status: 200, body: { ok: true, platformId, name: c.name } };
      }

      // ── 探查：把录制到的响应变成「可启用的配置」，并**当场试抓**
      //
      // 这是「添加平台」的主路径：用户登录取样 → 这里自动分析 → 试抓验证 → 返回候选。
      // 用户不需要看懂任何字段名，只需要在候选里点一下（通常只有一个能过）。
      //
      // 为什么要按候选逐个试抓、而不是只试第一个：
      // 分析器给的是**结构上的排序**，不是真理。试抓一次只是一个 GET，
      // 而让用户"点启用 → 同步 → 发现是空的 → 回来重试"的成本高一个量级。
      if (method === 'POST' && path === '/api/adapter/probe') {
        const body = parseBody();
        const samples = Array.isArray(body.samples) ? (body.samples as ProbeSample[]) : [];
        if (samples.length === 0) {
          return {
            status: 200,
            body: {
              ok: false,
              candidates: [],
              fix: buildFixPack({
                code: 'PROBE_EMPTY',
                platformName: String(body.name ?? '这个平台'),
                origin: String(body.origin ?? ''),
              }),
            },
          };
        }
        const origin = String(body.origin ?? samples[0]?.url ?? '');
        const name = String(body.name ?? '').trim() || hostOf(origin) || '未命名平台';
        // 页面上下文（标题/地址）一起进去：它决定"人当时在哪一层"，
        // 而这是唯一不需要猜的信息 —— 课程维度对不对全看它。
        const analysis = analyzeSamples(samples, {
          pageUrl: String(body.pageUrl ?? ''),
          pageTitle: String(body.pageTitle ?? ''),
        });

        // 课程候选：优先用同一个站点、且不是作业列表的那个接口
        const courseCand = analysis.courses[0];

        const candidates = [];
        for (const c of analysis.tasks.slice(0, 3)) {
          // 交给 normalizeAdapterConfig 生成最终形状：key/name/origin 的派生只有那一处，
          // 这里若自己再算一遍，探针给的 key 和启用时落库的 key 就会不一样（同一平台两个身份）。
          const cfg = normalizeAdapterConfig(
            buildConfig(c, {
              key: 'draft',
              name,
              origin,
              ...(courseCand ? { courses: courseCand } : {}),
              ...(analysis.singleCourse ? { singleCourse: analysis.singleCourse } : {}),
            }),
          );
          // 试抓：走真适配器、真会话、同一套解析器。不写库、不需要账号已存在。
          const trial = await deps.engine.previewCustomAdapter(cfg);
          candidates.push({
            config: cfg,
            url: c.url,
            rowCount: c.rowCount,
            confidence: c.confidence,
            evidence: c.evidence,
            warnings: c.warnings,
            trial: {
              ok: trial.ok,
              count: trial.tasks.length,
              // 只回前 3 条给界面显示 —— 这里的作用是"证明读得出来"，不是数据预览
              preview: trial.tasks.slice(0, 3).map((t) => ({
                title: t.title,
                courseName: t.courseName,
                deadline: t.deadline ?? null,
                status: t.status ?? 'unknown',
              })),
              error: trial.error ?? null,
              // code 是唯一的分类依据，必须随候选一起回传（前端不解析它，只用于后端修复包）
              code: trial.code ?? null,
              notes: trial.notes,
            },
          });
        }

        const passed = candidates.filter((x) => x.trial.ok);
        // 有能用的就直接算成功；都不行时给一份修复包（用户只需复制一次）
        const fix = candidates.length === 0
          ? buildFixPack({
              code: 'PROBE_EMPTY',
              platformName: name,
              origin,
              samples,
              error: analysis.needsMore.join('；') || undefined,
              // 一个数组都没出现过 → 数据不在 JSON 里，别再让他翻页面了
              ...(analysis.sawAnyArray ? {} : { noJsonList: true }),
            })
          : passed.length === 0
            ? buildFixPack({
                code: candidates[0]!.trial.code ?? 'UNKNOWN',
                error: candidates[0]!.trial.error ?? '接口能访问，但没读出作业',
                config: candidates[0]!.config as unknown as Record<string, unknown>,
                samples,
                platformName: name,
                origin,
              })
            : undefined;

        // ---- 落一份脱敏样本包 ----
        //
        // 为什么每次采集都落：真机上那一次的响应形状，是识别器唯一能变聪明的依据。
        // 只靠手写 fixture，改识别器就是在盲改（本项目已经因为「结构相同、语义不同」
        // 把一门课拆成四门过一次）。
        //
        // 存两份：store（手机端也能取回、复制导出）+ 可选的文件（桌面端进仓库当回归样本）。
        // 存失败绝不影响主流程 —— 样本是给开发用的，不是给用户用的。
        let sample: { host: string; path?: string; capturedAt: string } | undefined;
        try {
          const pack = buildSamplePack({
            samples,
            context: { pageUrl: String(body.pageUrl ?? ''), pageTitle: String(body.pageTitle ?? '') },
            now: deps.clock.now(),
            ...(passed.length > 0
              ? {
                  result: {
                    taskCount: passed[0]!.trial.count,
                    courseCount: analysis.singleCourse ? 1 : analysis.courses.length,
                    ...(analysis.singleCourse?.name ? { courseName: analysis.singleCourse.name } : {}),
                    taskUrl: passed[0]!.url,
                  },
                }
              : {}),
          });
          const key = packStorageKey(pack.platformHint);
          const prev = await deps.store.getCursor('__system', key);
          await deps.store.setCursor({
            accountId: '__system',
            kind: key,
            cursor: JSON.stringify(appendPackHistory(prev?.cursor, pack)),
            updatedAt: deps.clock.now().toISOString(),
          });
          const file = deps.saveSample
            ? await deps.saveSample(pack).catch(() => undefined)
            : undefined;
          sample = {
            host: pack.platformHint,
            capturedAt: pack.capturedAt,
            ...(file?.path ? { path: file.path } : {}),
          };
        } catch (e) {
          deps.logger.warn('样本包保存失败（不影响接入）', { error: String(e) });
        }

        return {
          status: 200,
          body: {
            ok: passed.length > 0,
            name,
            origin,
            candidates,
            // 看得懂的技术细节也留着：真出问题时它是唯一能定位的东西
            rejected: analysis.rejected.slice(0, 5),
            ...(sample ? { sample } : {}),
            ...(fix ? { fix } : {}),
          },
        };
      }

      // 导出最近一次采集的样本包（账号页「导出诊断样本」/ 采集结果卡片）。
      //
      // 为什么不给前端直接读 store：样本包的键是按域名算的，前端不派生任何键
      // （铁律：key/课程 id 只有 core 一处真源）。这里按 platformId 反查配置里的 origin 得到 host。
      if (method === 'GET' && path === '/api/adapter/sample') {
        const platformId = String(search.get('platformId') ?? '');
        const hostParam = String(search.get('host') ?? '');
        let host = hostParam;
        if (!host && platformId) {
          const cfg = (await deps.engine.findCustomAdapter(platformId)) as { origin?: string } | undefined;
          if (cfg?.origin) {
            try {
              host = new URL(cfg.origin).host;
            } catch {
              host = '';
            }
          }
        }
        if (!host) {
          return { status: 200, body: { ok: false, error: '找不到这个平台的样本（需要先采集一次）' } };
        }
        const cur = await deps.store.getCursor('__system', packStorageKey(host));
        if (!cur?.cursor) {
          return { status: 200, body: { ok: false, error: '这个平台还没有采集过样本' } };
        }
        let latest: SamplePack | undefined;
        try {
          const list = JSON.parse(cur.cursor) as SamplePack[];
          latest = Array.isArray(list) ? list[list.length - 1] : undefined;
        } catch {
          latest = undefined;
        }
        if (!latest) {
          return { status: 200, body: { ok: false, error: '样本已损坏，请重新采集' } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            host,
            capturedAt: latest.capturedAt,
            requestCount: latest.requests.length,
            text: JSON.stringify(latest, null, 2),
          },
        };
      }

      // 任何失败点的"复制给 AI"都走这里：**由后端决定给什么**，
      // 前端只负责显示一句话 + 两个按钮。分类与提示词都在 core 的 diagnostics 里，
      // 前端若自己拼，就会变成 N 个地方各写一份（必然漂移，且质量随机）。
      if (method === 'POST' && path === '/api/adapter/fix') {
        const body = parseBody();
        const platformId = String(body.platformId ?? '');
        let cfg: unknown = body.config;
        if (!cfg && platformId) cfg = await deps.engine.findCustomAdapter(platformId);
        // 错误优先取调用方给的；没有就取最近一次失败的同步日志（用户不用手抄）
        let error = String(body.error ?? '');
        if (!error && platformId) {
          const acc = (await deps.engine.listAccounts()).find((a) => a.platformId === platformId);
          if (acc) {
            const log = await deps.store.listSyncLog(acc.id, 5);
            error = log.find((x) => x.status === 'failed')?.message ?? '';
          }
        }
        // code 的来源顺序：调用方明确给的 > 引擎落下的结构化失败记录 > UNKNOWN（全量诊断包）。
        // **不再**从错误文案反推 —— 那是上一版的做法，文案一改分类就静默漂移。
        let code = String(body.code ?? '');
        if (!code && platformId) {
          const acc = (await deps.engine.listAccounts()).find((a) => a.platformId === platformId);
          if (acc) {
            const rec = await deps.engine.lastFailure(acc.id);
            if (rec) {
              code = rec.code;
              if (!error) error = rec.message;
            }
          }
        }
        const pack = buildFixPack({
          code: code || 'UNKNOWN',
          error,
          config: cfg as Record<string, unknown> | undefined,
          samples: Array.isArray(body.samples) ? (body.samples as ProbeSample[]) : undefined,
          platformName: String(body.name ?? platformId ?? '这个平台'),
          origin: String(body.origin ?? ''),
        });
        return { status: 200, body: pack };
      }

      // 生成「诊断包」：把失败原因 + 请求 + 响应片段 + 当前配置打包，
      // 用户分享给 AI，让它在原配置上**改**，而不是从零重写。
      if (method === 'POST' && path === '/api/adapter/diagnose') {
        const body = parseBody();
        const platformId = String(body.platformId ?? '');
        const cfg = platformId ? await deps.engine.findCustomAdapter(platformId) : undefined;
        if (!cfg) {
          return { status: 200, body: { ok: false, error: '找不到这个平台的配置（可能不是自定义平台）' } };
        }
        // 错误取最近一次失败记录：用户不用手抄，也就不会抄错。
        let error = String(body.error ?? '');
        if (!error) {
          const acc = (await deps.engine.listAccounts()).find((a) => a.platformId === platformId);
          if (acc) {
            const log = await deps.store.listSyncLog(acc.id, 5);
            const last = log.find((x) => x.status === 'failed');
            error = last?.message ?? '';
          }
        }
        const md = drillPack(platformId, error, cfg);
        return { status: 200, body: { ok: true, markdown: md, prompt: ADAPTER_PROMPT } };
      }

      // 把 AI 的回复粘回来。两种格式都认：
      //   数据型（作业数组）→ 直接导入手动作业，立刻能用
      //   配置型（接口+字段映射）→ 目前只能识别，还不能自动同步
      if (method === 'POST' && path === '/api/adapter/import') {
        const body = parseBody();
        const parsed = parseImport(String(body.text ?? ''));
        if (!parsed.homework || parsed.homework.length === 0) {
          // 配置型：不是失败，而是「需要用户确认启用」—— 前端据此显示启用按钮
          const canEnable = parsed.kind === 'adapter' && !parsed.error;
          return {
            status: 200,
            body: { ok: false, kind: parsed.kind, notes: parsed.notes, error: parsed.error, canEnable },
          };
        }
        // 去重：同标题已存在就跳过，避免同一个平台导入两遍
        const existing = [
          ...(await deps.engine.upcoming({ withinDays: 365, includeOverdue: true })),
          ...(await deps.engine.completed({ limit: 300 })),
        ];
        let created = 0;
        let done = 0;
        let skipped = 0;
        for (const h of parsed.homework) {
          if (existing.some((e) => e.title.trim() === h.title.trim())) {
            skipped += 1;
            continue;
          }
          const input = toManualInput(h, parsed.courseName, parsed.platformName);
          const task = await deps.engine.createManualTask({
            title: input.title,
            deadlineAt: input.deadlineAt,
            courseName: input.courseName,
            platformLabel: input.platformLabel,
          });
          created += 1;
          if (input.done) {
            await deps.engine.setTaskCompleted(task.id, true);
            done += 1;
          }
        }
        return {
          status: 200,
          body: { ok: true, kind: 'homework', created, done, skipped, notes: parsed.notes },
        };
      }

      // 「自己加平台」用的提示词与注意事项。原生侧不硬编码这两样，避免两份漂移。
      if (method === 'GET' && path === '/api/adapter/prompt') {
        return { status: 200, body: { prompt: ADAPTER_PROMPT, pitfalls: ADAPTER_PITFALLS } };
      }

      if (method === 'GET' && path === '/api/platforms') {
        return { status: 200, body: { platforms: platformSummaries(deps.registry) } };
      }

      if (method === 'GET' && path === '/api/changes') {
        // days 必须夹住：非法值（空串、NaN、负数）会让 since 变成 Invalid Date，
        // 而 Invalid Date 参与比较恒为 false → 返回空数组。
        // 那时「参数错」和「真的没有变更」在界面上一模一样，是典型的静默失效。
        const raw = Number(search.get('days') ?? 7);
        const days = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 1), 365) : 7;
        const changes = await deps.engine.recentChanges(new Date(Date.now() - days * 86_400_000));
        return {
          status: 200,
          body: {
            days,
            changes: changes.map(({ task, changes: list }) => ({
              taskId: task.id,
              title: task.title,
              courseName: task.courseName,
              revision: task.revision,
              // 任务可能已被软删除 / 被用户删除：记录照留，但必须标出来 ——
              // 否则用户在记录里找一条待办里根本不存在的作业，会以为看错了。
              removed: Boolean(task.deletedAt || task.userDeletedAt),
              changes: list,
            })),
          },
        };
      }

      if (method === 'GET' && path === '/api/log') {
        const accounts = await deps.engine.listAccounts();
        const entries = [];
        for (const acc of accounts) entries.push(...(await deps.store.listSyncLog(acc.id, 30)));
        entries.sort((x, y) => y.finishedAt.localeCompare(x.finishedAt));
        return { status: 200, body: { log: entries.slice(0, 40) } };
      }

      // ---- 写 ----
      if (method === 'POST' && path === '/api/sync') {
        const body = parseBody();
        const report = await runSync({ allowRelogin: body.allowRelogin !== false });
        return { status: 200, body: summarize(report) };
      }

      if (method === 'POST' && path === '/api/login') {
        const body = parseBody();
        const platformId = String(body.platformId ?? '');
        const username = String(body.username ?? '');
        const password = String(body.password ?? '');
        const cookie = typeof body.cookie === 'string' ? body.cookie : undefined;
        const authMethod = String(body.method ?? 'password');
        if (!platformId) throw new Error('缺少 platformId');

        // 粘贴凭证 / 浏览器内已登录 —— 走离线登记，不发任何请求、不碰密码
        if (authMethod === 'cookie-import' || authMethod === 'browser' || cookie) {
          // storage：平台网页 localStorage 快照（雨课堂的 API token 在里面）
          const storage = typeof body.storage === 'string' ? body.storage : undefined;
          const explicit = body.explicit === true || authMethod === 'cookie-import';
          let account;
          try {
            account = await deps.engine.registerOfflineAccount(platformId, username || 'browser', {
              storage,
              explicit,
              // 'browser' = 用户刚在本应用的 WebView 里打开官方登录页登录完 →
              // 这也是「官方登录时刻」应该被刷新的时刻（与是否有 localStorage 快照无关）。
              // 'cookie-import' 不算：那是用户从别处拷来的凭据，不是刚发生的登录。
              freshLogin: authMethod === 'browser',
            });
          } catch (e) {
            // 撞墓碑：这个账号此前被用户移除过。
            // 这不是错误，而是一个需要用户决定的状态 —— 返回 200 让 UI 去问，
            // 用户确认后带 explicit:true 重发即可。（真机：移除后账号被静默重建）
            if (e instanceof HubError && e.details?.accountRemoved === true) {
              return {
                status: 200,
                body: {
                  ok: true,
                  removed: true,
                  platformId,
                  label: deps.registry.require(platformId).displayName,
                  note: e.message,
                },
              };
            }
            throw e;
          }
          const session = await deps.vault.load(account.id);
          if (session && cookie && cookie.trim()) {
            const raw = cookie.trim();
            if (!raw.includes('=') && raw.length > 20) {
              session.headers['Authorization'] = raw;
            } else {
              for (const part of raw.split(';')) {
                const eq = part.indexOf('=');
                if (eq > 0) session.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
              }
            }
            session.origin = 'imported';
            await deps.vault.save(session);
          }
          return {
            status: 200,
            body: {
              ok: true,
              account: {
                id: account.id,
                label: account.label,
                platformId: account.platformId,
                username: account.username,
                enabled: account.enabled,
                lastSyncAt: account.lastSyncAt ?? null,
                lastSyncStatus: account.lastSyncStatus ?? null,
                lastSyncMessage: account.lastSyncMessage ?? null,
              },
              note: '已登记（未发出任何网络请求）',
            },
          };
        }

        const saveCredentials = body.saveCredentials !== false;
        try {
          const account = await deps.engine.login(platformId, username, { password, captcha: typeof body.captcha === 'string' ? body.captcha : '' }, { saveCredentials });
          return {
            status: 200,
            body: {
              ok: true,
              credentialsSaved: saveCredentials,
              note: saveCredentials
                ? '密码已加密保存：会话失效时会自动重新登录（一键同步）'
                : '未保存密码：会话失效后需要重新登录',
              account: {
                id: account.id,
                label: account.label,
                platformId: account.platformId,
                username: account.username,
                enabled: account.enabled,
                lastSyncAt: account.lastSyncAt ?? null,
                lastSyncStatus: account.lastSyncStatus ?? null,
                lastSyncMessage: account.lastSyncMessage ?? null,
              },
            },
          };
        } catch (e) {
          // 验证码流程：把图片（data URL）带回给 UI 展示，不是一次失败的请求
          if (e instanceof HubError && e.code === 'CAPTCHA_REQUIRED') {
            return {
              status: 200,
              body: {
                needCaptcha: true,
                captchaImage: (e.details?.captchaImage as string | undefined) ?? null,
                error: e.message,
              },
            };
          }
          throw e;
        }
      }

      if (method === 'POST' && path === '/api/import-har') {
        const body = parseBody();
        const platformId = String(body.platformId ?? '');
        if (!platformId) throw new Error('缺少 platformId');
        const engine = subEngine(await deps.buildTransport('replay', body), 'har-replay');
        const account = await engine.registerOfflineAccount(platformId, 'har-import', {
          label: `${platformId}（HAR 回放）`,
        });
        // 只同步这个账号 —— 否则会把挂着真实会话的其他账号也拉一遍
        const report = await engine.syncAll({ refreshCourses: 'always', accountIds: [account.id] });
        return { status: 200, body: summarize(report) };
      }

      if (method === 'POST' && path === '/api/attach') {
        const body = parseBody();
        const platformId = String(body.platformId ?? '');
        if (!platformId) throw new Error('缺少 platformId');
        const engine = subEngine(await deps.buildTransport('attach', body), 'cdp');
        const account = await engine.registerOfflineAccount(platformId, 'cdp', {
          label: `${platformId}（CDP 附着）`,
        });
        const report = await engine.syncAll({ refreshCourses: 'always', accountIds: [account.id] });
        return { status: 200, body: summarize(report) };
      }

      if (method === 'POST' && path === '/api/task/manual') {
        const body = parseBody();
        const task = await deps.engine.createManualTask({
          title: String(body.title ?? ''),
          deadlineAt: String(body.deadlineAt ?? ''),
          courseName: typeof body.courseName === 'string' ? body.courseName : undefined,
          courseId: typeof body.courseId === 'string' ? body.courseId : undefined,
          newCourse: body.courseMode === 'new',
          platformLabel: typeof body.platformLabel === 'string' ? body.platformLabel : undefined,
        });
        return { status: 200, body: { ok: true, task: taskDto(task) } };
      }

      if (method === 'POST' && path === '/api/task/complete') {
        const body = parseBody();
        const taskId = String(body.taskId ?? '');
        if (!taskId) throw new Error('缺少 taskId');
        // completed 缺省为 true —— 前端只传 taskId 时表示"标记完成"
        const completed = body.completed === undefined ? true : body.completed === true;
        const r = await deps.engine.setTaskCompleted(taskId, completed);
        return { status: 200, body: { ok: true, ...r, task: taskDto(r.task) } };
      }

      if (method === 'POST' && path === '/api/task/skip') {
        const body = parseBody();
        const taskId = String(body.taskId ?? '');
        if (!taskId) throw new Error('缺少 taskId');
        // skipped 缺省为 true —— 前端只传 taskId 时表示"标记不用交"
        const skipped = body.skipped === undefined ? true : body.skipped === true;
        const r = await deps.engine.setTaskSkipped(taskId, skipped);
        return { status: 200, body: { ok: true, task: taskDto(r.task) } };
      }

      if (method === 'POST' && path === '/api/task/delete') {
        const body = parseBody();
        const taskId = String(body.taskId ?? '');
        if (!taskId) throw new Error('缺少 taskId');
        const all = await deps.store.listTasks({ includeDeleted: true });
        const t = all.find((x) => x.id === taskId);
        if (!t) throw new Error(`任务不存在：${taskId}`);
        await deps.engine.deleteTask(t.accountId, taskId);
        return { status: 200, body: { ok: true } };
      }

      if (method === 'POST' && path === '/api/course/delete') {
        const body = parseBody();
        const accountId = String(body.accountId ?? '');
        const courseId = String(body.courseId ?? '');
        if (!accountId || !courseId) throw new Error('缺少 accountId 或 courseId');
        const r = await deps.engine.deleteCourse(accountId, courseId);
        return {
          status: 200,
          body: { ok: true, removed: r.removed, note: '课程已删除，之后的同步将跳过这门课' },
        };
      }

      if (method === 'POST' && path === '/api/course/mute') {
        const body = parseBody();
        const accountId = String(body.accountId ?? '');
        const courseId = String(body.courseId ?? '');
        const muted = body.muted !== false;
        if (!accountId || !courseId) throw new Error('缺少 accountId / courseId');
        await deps.engine.setCourseMuted(accountId, courseId, muted);
        return { status: 200, body: { ok: true } };
      }

      // 改显示名。name 传空 = 恢复平台原名。
      // 重名**不拒绝**，只把冲突报回界面 —— 同名课各有 ID，本来就能并存。
      if (method === 'POST' && path === '/api/course/rename') {
        const body = parseBody();
        const courseId = String(body.courseId ?? '');
        if (!courseId) throw new Error('缺少 courseId');
        const name = body.name === null || body.name === undefined ? null : String(body.name);
        return { status: 200, body: await deps.engine.renameCourse(courseId, name) };
      }

      // 把手动添加的作业归并到这门课（重名的真正解法）。
      if (method === 'POST' && path === '/api/course/adopt') {
        const courseId = String(parseBody().courseId ?? '');
        if (!courseId) throw new Error('缺少 courseId');
        return { status: 200, body: await deps.engine.adoptManualTasks(courseId) };
      }

      if (method === 'POST' && path === '/api/account/remove') {
        const accountId = String(parseBody().accountId ?? '');
        if (!accountId) throw new Error('缺少 accountId');
        const acc = (await deps.engine.listAccounts()).find((a) => a.id === accountId);
        // 走引擎而不是直接删存储：引擎会同时留下墓碑并立即落盘 ——
        // 否则下次从平台页返回时账号会被静默重建（真机踩过）。
        await deps.engine.removeAccount(accountId);
        // 自定义平台：账号删了，它那份「平台配置」也得一起删。
        // 否则下次启动 loadCustomAdapters 又把适配器注册回来，
        // 平台下拉里留一个没有账号的幽灵项（真机反馈过）。
        if (acc?.platformId?.startsWith('custom-')) {
          await deps.engine.deleteCustomAdapter(acc.platformId);
          deps.registry.unregister(acc.platformId);
          customLoaded = false; // 下次请求重新加载，避免注册表里留着已删的
        }
        return { status: 200, body: { ok: true } };
      }

      return { status: 404, body: { ok: false, error: `未知接口 ${method} ${path}` } };
    } catch (e) {
      const msg = e instanceof HubError ? `[${e.code}] ${e.message}` : ((e as Error).message ?? String(e));
      return { status: 400, body: { ok: false, error: msg } };
    }
  }

  return handle;
}

// ---------------------------------------------------------------- 传输层工厂

/** 桌面/服务端可用的完整传输工厂（含 CDP）。 */
export function createTransportFactory(): ApiDeps['buildTransport'] {
  return async (kind, payload) => {
    if (kind === 'replay') {
      const har = String(payload.har ?? '');
      if (!har.trim()) throw new Error('HAR 内容为空');
      return new HarReplayHttpClient(har);
    }
    const port = Number(payload.port ?? 9222);
    const match = typeof payload.match === 'string' && payload.match.trim() ? payload.match.trim() : undefined;
    return new CdpHttpClient({ debugBase: `http://127.0.0.1:${port}`, targetUrlMatch: match });
  };
}

// ---------------------------------------------------------------- 探查用的小工具

/**
 * 从平台地址里取域名（给"平台名"兜底用）。
 *
 * 用户不填平台名时，用域名当名字比"未命名平台"好得多 —— 他至少认得出
 * zhihuishu.com 是哪门课的平台，而"未命名平台"在账号页里跟另一个未命名平台无法区分。
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

