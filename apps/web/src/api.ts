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
  completionOrigin,
  DEFAULT_NOTIFY_PREFS,
  effectiveStatus,
  HarReplayHttpClient,
  HubError,
  canSkip,
  validateConfig,
  hasPendingAc,
  ADAPTER_PROMPT,
  ADAPTER_PITFALLS,
  isTerminalStatus,
  MIN_GAP_HOURS,
  normalizeNotifyPrefs,
  NOTIFY_LEVEL_LABELS,
  NOTIFY_PRESETS,
  SyncEngine,
  UnavailableSigner,
} from '#core';

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

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const { method, pathname: path, search } = req;

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
        const missing = validateConfig(cfg);
        if (missing.length > 0) {
          return { status: 200, body: { ok: false, error: `配置还缺：${missing.join('、')}` } };
        }
        const c = cfg as unknown as { key: string; name: string };
        await deps.engine.saveCustomAdapter(cfg as never);
        await deps.engine.loadCustomAdapters();
        const platformId = `custom-${c.key}`;
        await deps.engine.registerOfflineAccount(platformId, 'web', {
          label: c.name,
          freshLogin: true,
        });
        return { status: 200, body: { ok: true, platformId, name: c.name } };
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
        // 走引擎而不是直接删存储：引擎会同时留下墓碑并立即落盘 ——
        // 否则下次从平台页返回时账号会被静默重建（真机踩过）。
        await deps.engine.removeAccount(accountId);
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
