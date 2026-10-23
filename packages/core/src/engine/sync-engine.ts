/**
 * 同步引擎 —— 整个应用的大脑。
 *
 * 职责：把「账号 → 适配器 → 限流 HTTP → 归一化 → 幂等合并 → 提醒」串成一条流水线，
 * 并且保证「任何一个平台挂掉都不会影响其他平台」。
 *
 * 这个容错要求决定了整体结构：syncAll 对每个账号做错误隔离，
 * 返回一份逐账号的报告，而不是抛异常中断整轮同步。
 * 一个学生的学习通会话过期了，不应该导致他看不到雨课堂的考试。
 */
import type { AdapterContext, FetchTasksRequest, PlatformAdapter } from '../ports/adapter.ts';
import type { AdapterRegistry } from '../ports/registry.ts';
import type { HubStore, SentReminder, SyncLogEntry } from '../ports/store.ts';
import type { HttpClient } from '../ports/http.ts';
import type { Limiter, LimiterOptions } from '../ports/limiter.ts';
import type { Logger } from '../ports/logger.ts';
import type { Clock } from '../domain/time.ts';
import type { PlatformAccount } from '../domain/course.ts';
import type { TaskKind, UnifiedTask } from '../domain/task.ts';
import { completionOrigin, effectiveStatus, hasPendingAc, isTerminalStatus } from '../domain/task.ts';
import { makeCourseId } from '../domain/ids.ts';
import { effectiveInstant } from '../domain/deadline.ts';
import { courseTitle, maskUsername } from '../domain/course.ts';
import { describe, HubError, schemaDrift, toHubError } from '../domain/errors.ts';
import { isSessionExpired, mayReauthenticate } from '../ports/vault.ts';
import type { Credentials, Session, SessionOrigin, Vault } from '../ports/vault.ts';
import type { PlatformTask } from '../domain/task.ts';
import type { ReadOnlyGuardStats } from '../ports/read-only.ts';
import { createReadOnlyGuardStats } from '../ports/read-only.ts';
import { createReadOnlyHttpClient } from './read-only-guard.ts';
import type { NativeSigner } from '../ports/signer.ts';
import { UnavailableSigner } from '../ports/signer.ts';
import { TokenBucket, defaultLimitsFor } from '../infra/token-bucket.ts';
import { createHttpStats, createResilientHttpClient, mapLimit } from './http-pipeline.ts';
import type { HttpStats, RetryPolicy } from './http-pipeline.ts';
import { DEFAULT_MERGE_OPTIONS, materializeTask, mergeTasks } from './merge.ts';
import type { TaskEvent } from './merge.ts';
import { DEFAULT_REMINDER_RULES, planReminders } from './reminder.ts';
import { buildNotificationSchedule } from './notify-schedule.ts';
import type { NotifyPrefs, ScheduledNotification } from './notify-schedule.ts';
import type { PlannedReminder, ReminderRule } from './reminder.ts';

/**
 * 「已移除账号」墓碑的命名空间。
 *
 * 为什么不把墓碑挂在被移除的账号下面（accountId 用真实 id）：
 * `removeAccount` 会清掉属于该账号的一切（课程/任务/提醒/游标）——
 * 墓碑必须活在账号之外，才能在账号消失之后仍然记得「用户否决过它」。
 * 真实的 accountId 形如 `platformId::username`（必含 `::`），
 * 因此不可能与这个命名空间撞车。
 */
const REMOVED_NS = '__removed__';

/**
 * 一门课要「静默」多久，才认为它不会再产生新内容（考试/测验）。
 *
 * 14 天：一次作业周期通常以周计，两周没有任何变化的课程基本已经结课。
 * 判定还叠加了「该课程全部任务为终态」与「库里已有数据」两个条件，
 * 所以刚开学、或还有未完成作业的课程永远不会被判静默 ——
 * 宁可不省这点请求，也不能漏掉老师临时发的小测验。
 */
const QUIET_COURSE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 手动添加任务的「来源」标识。
 *
 * 为什么用一个隔离的伪账号，而不是塞进某个真实账号：
 * 同步层会对「本轮的 existing 里没被上游看到」的任务累计缺席，够阈值就软删除。
 * 手动任务上游永远看不到，挂在真实账号下会被一轮轮同步判成"消失了"然后删掉。
 * 用一个不出现在 listAccounts() 里的伪身份，就天然绕开所有同步逻辑。
 */
export const MANUAL_PLATFORM_ID = 'manual';
export const MANUAL_ACCOUNT_ID = 'manual::me';

/** 通知栏排期的下发通道。全量替换语义：原生先把旧闹钟全撤掉，再按这份清单注册。 */
export interface NotificationSink {
  schedule(items: ScheduledNotification[]): Promise<void>;
}

export interface ReminderSink {
  deliver(reminder: PlannedReminder): Promise<void>;
}

export interface SyncOptions {
  /** 只同步指定账号；不传则同步全部启用账号 */
  accountIds?: string[];
  /** 并发同步的账号数。默认 2 —— 同一平台的请求已被限流器串行化，账号级并发主要提速跨平台场景 */
  concurrency?: number;
  /** 单账号单轮最多翻多少页，防止适配器 bug 导致无限翻页 */
  maxPages?: number;
  /** 忽略 expiresAt，强制向平台探测会话 */
  forceAuthProbe?: boolean;
  refreshCourses?: 'always' | 'if-empty' | 'ttl';
  courseTtlMs?: number;
  absenceThreshold?: number;
  /** 演练模式：完整跑一遍但不写库 */
  dryRun?: boolean;
  skipReminders?: boolean;
  retry?: RetryPolicy;
  /**
   * 「已全部完成的课程」在 TTL 内跳过重爬（提速开关，默认开）。
   *
   * 长江雨课堂这类平台一次同步要发上百个请求（逐课程逐课次），
   * 而大部分课程一学期就那几个作业、早已全部提交 —— 每次同步都重爬纯属浪费。
   * 跳过条件（三条同时满足才跳，宁慢勿漏）：
   *   1. 该课程在库里已有任务；
   *   2. 所有任务都是终态（已提交/已批阅/已过期）；
   *   3. 距上次完整爬取该课程不足 TTL（默认 6 小时）。
   * 「老师给做完全部作业的旧课次补发新作业」这个窗口由 TTL 兜底。
   * 跳过发生时本轮禁用删除判定 —— 绝不因为「没爬」而误删。
   */
  skipCompletedCourses?: boolean;
  /** 上条开关的 TTL，默认 6 小时 */
  completedCourseTtlMs?: number;
  /**
   * 会话失效时，允许用保险箱里保存的密码自动重新登录并重试一轮（一键同步）。
   * 默认 true —— 但只有「账号密码登录且勾选了记住密码」的账号才有凭据可登；
   * 粘贴 cookie / HAR / CDP 路线没有密码，本选项对它们无效。
   * 传 false 可强制回到旧行为：失效即停下，等用户手动处理。
   */
  allowRelogin?: boolean;
  /** 内部字段：本轮同步已经因重登重试过一次，防止失败后无限循环 */
  reloginAttempted?: boolean;
}

export interface AccountSyncReport {
  accountId: string;
  platformId: string;
  label: string;
  status: SyncLogEntry['status'];
  message?: string;
  courses: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  vanished: number;
  removed: number;
  reminders: PlannedReminder[];
  events: TaskEvent[];
  http: HttpStats;
  /**
   * 只读守卫的统计。
   * 正常情况下 blocked 应恒为 0 —— 它是一份「我们确实没有写过任何东西」的证据，
   * 也是唯一能在出现配置失误时立刻报警的指标。
   */
  readOnly: ReadOnlyGuardStats;
  /** 本次同步使用的会话来源。imported 表示我们只旁观，绝不主动续期 */
  sessionOrigin: SessionOrigin;
  /** 会话来源可读说明，用于 UI 直接展示给用户 */
  sessionOriginNote: string;
  durationMs: number;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  accounts: AccountSyncReport[];
  totals: {
    accounts: number;
    ok: number;
    failed: number;
    created: number;
    updated: number;
    removed: number;
    reminders: number;
    requests: number;
    throttledMs: number;
  };
}

export interface SyncEngineDeps {
  registry: AdapterRegistry;
  store: HubStore;
  vault: Vault;
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  signer?: NativeSigner;
  reminderSink?: ReminderSink;
  /**
   * 通知栏排期的下发通道（原生闹钟）。
   * 没注入时（桌面/CLI）所有排期逻辑照常算，只是没人接 —— 便于测试与降级。
   */
  notificationSink?: NotificationSink;
  /**
   * 提醒偏好（密度档位 / 每日汇总）。注入的是**取值函数**而不是值 ——
   * 用户随时可能在设置页改，而排期发生在每次同步的尾部，
   * 取函数才能保证拿到的是当场最新的那份配置。
   */
  notifyPrefs?: () => NotifyPrefs;
  reminderRules?: ReminderRule[];
  /** 覆盖各平台默认限流档位 */
  limits?: Record<string, LimiterOptions>;
}

const DAY_MS = 86_400_000;

export class SyncEngine {
  readonly #registry: AdapterRegistry;
  readonly #store: HubStore;
  readonly #vault: Vault;
  readonly #baseHttp: HttpClient;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #signer: NativeSigner;
  readonly #reminderSink: ReminderSink | undefined;
  readonly #notificationSink: NotificationSink | undefined;
  readonly #notifyPrefs: (() => NotifyPrefs) | undefined;
  readonly #rules: ReminderRule[];
  readonly #limits: Record<string, LimiterOptions>;
  /** 每个平台一个限流器，全局共享 —— 同一平台的多个账号必须共用配额 */
  readonly #limiters = new Map<string, Limiter>();

  constructor(deps: SyncEngineDeps) {
    this.#registry = deps.registry;
    this.#store = deps.store;
    this.#vault = deps.vault;
    this.#baseHttp = deps.http;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#signer = deps.signer ?? new UnavailableSigner();
    this.#reminderSink = deps.reminderSink;
    this.#notificationSink = deps.notificationSink;
    this.#notifyPrefs = deps.notifyPrefs;
    this.#rules = deps.reminderRules ?? DEFAULT_REMINDER_RULES;
    this.#limits = deps.limits ?? {};
  }

  /**
   * 登录并登记账号。
   *
   * 账号密码登录时默认把凭据一并存进加密保险箱（saveCredentials: false 可关闭）：
   * 这是「一键同步」的前提 —— 会话失效后引擎能用它自动重新登录，而不是停下来等用户。
   * 粘贴 cookie 的登录路径没有密码，自然不会保存任何凭据。
   */
  async login(
    platformId: string,
    username: string,
    credentials: Credentials,
    opts: { label?: string; accountId?: string; saveCredentials?: boolean } = {},
  ): Promise<PlatformAccount> {
    const adapter = this.#registry.require(platformId);
    const accountId = opts.accountId ?? `${platformId}::${username}`;
    const ctx = this.#contextFor(platformId, accountId);

    const session = await adapter.login(ctx, { username, ...credentials });
    session.accountId = accountId;
    if (credentials.password && opts.saveCredentials !== false) {
      session.credentials = { username, password: credentials.password };
    }
    await this.#vault.save(session);
    await this.#clearCourseCursors(accountId);
    // 账号密码登录是用户在表单里显式填写的添加意图 → 撤掉可能存在的墓碑
    await this.#clearTombstone(accountId);

    const existing = await this.#store.getAccount(accountId);
    const account: PlatformAccount = {
      id: accountId,
      platformId,
      label: opts.label ?? session.displayName ?? maskUsername(username),
      username,
      enabled: true,
      createdAt: existing?.createdAt ?? this.#clock.now().toISOString(),
      lastSyncAt: existing?.lastSyncAt,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncMessage: existing?.lastSyncMessage,
    };
    await this.#store.upsertAccount(account);
    if (mayReauthenticate(session)) {
      this.#logger.info('账号登录成功（独立登录）', { platformId, accountId, label: account.label });
    } else {
      this.#logger.info('账号已登记，会话由用户提供 —— 之后只做只读访问', {
        platformId,
        accountId,
        label: account.label,
        origin: session.origin,
      });
    }
    return account;
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return this.#store.listAccounts();
  }

  /**
   * 登记一个「离线账号」—— **全程不发任何网络请求**。
   *
   * 这是零影响路线（HAR 回放、CDP 附着）的入口。它们不走我们自己的登录：
   *   - HAR 回放根本不联网，会话里连 cookie 都不需要；
   *   - CDP 附着的 cookie 由浏览器自动附带，我们也读不到。
   * 所以这里只造一个空的、标记为 imported 的会话占位。
   *
   * 标记为 imported 是刻意的：这两条路线下的「会话失效」
   * 都不应该触发任何自动登录（也根本没有密码可登）。
   */
  async registerOfflineAccount(
    platformId: string,
    username: string,
    opts: {
      label?: string;
      displayName?: string;
      /** 平台网页的 localStorage 快照（JSON 串），用于提取 API token */
      storage?: string;
      /**
       * 用户是否**明确**要添加这个账号（账号页填表 / 二次确认后的重新添加）。
       *
       * 为什么需要这个标记（真机踩过）：从平台页返回时也会走这里登记，
       * 用户「只是想去看一眼平台」和「我要添加这个账号」在系统里长得一模一样。
       * 于是「移除账号」之后只要再点一次「登录平台」，账号就被静默重建 ——
       * 用户的移除等于没做。区分方式：自动路径（从平台页返回）不带这个标记，
       * 撞上墓碑就停下并告诉用户；用户确认后重发时才带上。
       */
      explicit?: boolean;
      /**
       * 本次调用代表「用户**刚刚**在官方登录页登录完」（应用内登录返回）。
       *
       * 为什么必须单独标出来（真机踩过）：issuedAt 的语义是「上次官方登录时刻」，
       * 而它原来只在**首次登记**时写一次。于是 iSmart 这种「登录返回时不带
       * localStorage 快照」的平台永远不会刷新它 —— 「距上次官方登录」被算成
       * 「距首次登记」，真机上直接显示成 77.9 小时，而实际只有 2 小时不到。
       * 用这个标记把刷新从「看有没有 storage」里解耦出来。
       */
      freshLogin?: boolean;
    } = {},
  ): Promise<PlatformAccount> {
    // 确认适配器存在 —— 这一步是纯内存查询，不发请求
    this.#registry.require(platformId);

    const accountId = `${platformId}::${username}`;

    // ---- 墓碑：用户此前明确移除过这个账号 ----
    const tombstone = await this.#store.getCursor(REMOVED_NS, accountId);
    if (tombstone?.cursor === '1') {
      if (!opts.explicit) {
        const name = this.#platformName(platformId);
        throw new HubError(
          'AUTH_REQUIRED',
          `${name}：这个账号此前已被你移除，本次登录**没有**自动把它加回来。` +
            '如果你确实想重新添加，再点一次确认即可。',
          { platformId, requiresUserAction: true, details: { accountRemoved: true } },
        );
      }
      // 用户确认要重新添加 → 撤掉墓碑
      await this.#clearTombstone(accountId);
    }

    const existing = await this.#store.getAccount(accountId);

    if (!existing) {
      await this.#vault.save({
        platformId,
        accountId,
        origin: 'imported',
        cookies: {},
        headers: this.#extractWebToken(platformId, opts.storage),
        issuedAt: this.#clock.now().toISOString(),
        displayName: opts.displayName,
        extra: opts.storage ? { webStorage: opts.storage.slice(0, 4000) } : undefined,
      });
    } else if (opts.storage || opts.freshLogin) {
      // 账号已存在 → 合并新拿到的 token / 快照进现有会话。
      // （雨课堂等平台的 API token 在 localStorage 里，每次应用内登录都要刷新）
      const prev = await this.#vault.load(accountId);
      if (prev) {
        const headers = opts.storage ? this.#extractWebToken(platformId, opts.storage) : {};
        await this.#vault.save({
          ...prev,
          headers: { ...prev.headers, ...headers },
          ...(opts.storage ? { extra: { ...prev.extra, webStorage: opts.storage.slice(0, 4000) } } : {}),
          // 只有「刚从官方登录页回来」才刷新 issuedAt。
          // 它必须**独立于 storage 是否存在**：iSmart 的凭据在 cookie 里（由系统保管，
          // 我们读不到也不需要读），登录返回时根本没有 localStorage 快照 ——
          // 原来把刷新塞在 storage 分支里，等于对 iSmart 永远不生效。
          ...(opts.freshLogin ? { issuedAt: this.#clock.now().toISOString() } : {}),
        });
      }
    }

    const account: PlatformAccount = {
      id: accountId,
      platformId,
      label: opts.label ?? existing?.label ?? opts.displayName ?? this.#offlineLabel(platformId, username),
      username,
      enabled: true,
      createdAt: existing?.createdAt ?? this.#clock.now().toISOString(),
      lastSyncAt: existing?.lastSyncAt,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncMessage: existing?.lastSyncMessage,
    };
    await this.#store.upsertAccount(account);
    // 应用内登录返回 = 用户刚在官方页面登录完 → 清掉删课排除与跳过游标，
    // 让这门课（哪怕之前被「删整课」过）重新参与同步。
    await this.#clearCourseCursors(accountId);
    this.#logger.info('已登记离线账号（未发出任何请求）', { platformId, accountId });
    return account;
  }

  /**
   * 移除账号。
   *
   * 与「删整课」一样，这里也要留下**墓碑**：否则下次从平台页返回时
   * （应用内登录的登记路径）账号会被静默重建 —— 用户的「移除」等于没做。
   * 真机踩过：0.1.27 移除的账号在 0.1.28 又出现在账号列表里。
   *
   * 三件事一起做，缺一不可：
   *   1. 删账号（存储层顺带清掉它名下的课程/任务/提醒/游标）
   *   2. 删会话（保险箱）
   *   3. 落墓碑 + 立即落盘（破坏性操作，不能等去抖——用户点完往往就退出 App）
   */
  async removeAccount(accountId: string): Promise<void> {
    await this.#store.removeAccount(accountId);
    await this.#vault.remove(accountId);
    await this.#store.setCursor({
      accountId: REMOVED_NS,
      kind: accountId,
      cursor: '1',
      updatedAt: this.#clock.now().toISOString(),
    });
    this.#store.flush?.();
    this.#logger.info('已移除账号（并留下墓碑，避免下次登录被静默重建）', { accountId });
  }

  /** 平台的展示名（用于面向用户的提示语）。 */
  #platformName(platformId: string): string {
    try {
      return this.#registry.require(platformId).displayName;
    } catch {
      return platformId;
    }
  }

  /**
   * 离线路线账号的展示名。
   *
   * 这几条路线的内部 username 是固定代号（browser / har-import / cdp），
   * 直接显示出来用户看不懂（真机反馈：「账号列表里有个 browser」）。
   * 换成「平台名 + 怎么进来的」，用户才能一眼分辨同一个平台的多个账号。
   */
  #offlineLabel(platformId: string, username: string): string {
    const name = this.#platformName(platformId);
    if (username === 'browser') return `${name}（应用内登录）`;
    if (username === 'har-import') return `${name}（离线导入）`;
    if (username === 'cdp') return `${name}（CDP 附着）`;
    return maskUsername(username);
  }

  /** 撤掉墓碑（用户明确要重新添加这个账号时调用）。 */
  async #clearTombstone(accountId: string): Promise<void> {    const t = await this.#store.getCursor(REMOVED_NS, accountId);
    if (t?.cursor !== '1') return;
    await this.#store.setCursor({
      accountId: REMOVED_NS,
      kind: accountId,
      cursor: '',
      updatedAt: this.#clock.now().toISOString(),
    });
  }

  /**
   * 从平台网页的 localStorage 快照里提取 API token，转成请求头。
   *
   * 背景：雨课堂的 API 认证不用 cookie，用 Authorization 头，token 存在
   * 网页 localStorage —— WebView 登录只回传 cookie 是拿不到它的（真机 401 根因）。
   * key 名各平台不一，这里宽松匹配 /auth|token/i；值原样使用（是否带 Bearer 由平台决定）。
   */
  #extractWebToken(platformId: string, storage: string | undefined): Record<string, string> {
    if (!storage) return {};
    try {
      const entries = Object.entries(JSON.parse(storage) as Record<string, unknown>);
      for (const [k, v] of entries) {
        if (/auth|token/i.test(k) && typeof v === 'string' && v.length > 10 && v.length < 4000) {
          this.#logger.info('从网页存储提取到 API token', { platformId, key: k });
          return { Authorization: v };
        }
      }
      this.#logger.warn('网页存储快照里没有找到 token 形态的键', { platformId, keys: entries.map(([k]) => k) });
    } catch {
      // 快照损坏就放弃 —— 走原有的 cookie 路径
    }
    return {};
  }

  /**
   * 登录 = 「我要重新同步」的信号：清掉该账号的删课排除清单与跳过游标。
   * 否则「删整课」之后再登录，这门课永远不会再被抓 ——
   * 表现为「平台明明登录了却什么都没有」（真机踩过）。
   */  async #clearCourseCursors(accountId: string): Promise<void> {
    const at = this.#clock.now().toISOString();
    for (const kind of ['course-exclude', 'course-crawl']) {
      const c = await this.#store.getCursor(accountId, kind);
      if (c) await this.#store.setCursor({ accountId, kind, cursor: '[]', updatedAt: at });
    }
  }

  /** 同步全部（或指定）账号，逐账号错误隔离。 */
  async syncAll(opts: SyncOptions = {}): Promise<SyncReport> {
    const startedAt = this.#clock.now();
    const all = await this.#store.listAccounts();
    const targets = all.filter((a) => a.enabled && (!opts.accountIds || opts.accountIds.includes(a.id)));

    if (targets.length === 0) {
      // 一个账号都没有也要重排提醒 —— 用户可能只用「手动添加」记作业。
      await this.#refreshNotificationSchedule();
      const end = this.#clock.now();
      return {
        startedAt: startedAt.toISOString(),
        finishedAt: end.toISOString(),
        durationMs: end.getTime() - startedAt.getTime(),
        accounts: [],
        totals: { accounts: 0, ok: 0, failed: 0, created: 0, updated: 0, removed: 0, reminders: 0, requests: 0, throttledMs: 0 },
      };
    }

    const reports = await mapLimit(targets, opts.concurrency ?? 2, (account) =>
      this.syncAccount(account, opts),
    );

    // 同一平台的多个账号并发时，各自报告里的 http 统计是分开的；
    // 这里按平台汇总时要避免重复计算 —— 所以只在单账号场景下累加限流等待，
    // 多账号场景下 throttledMs 取各账号之和（限流器共享，会重复计数但量级正确）。
    const totals = reports.reduce(
      (acc, r) => {
        acc.created += r.created;
        acc.updated += r.updated;
        acc.removed += r.removed;
        acc.reminders += r.reminders.length;
        acc.requests += r.http.requests;
        acc.throttledMs += r.http.throttledMs;
        if (r.status === 'ok') acc.ok += 1;
        else acc.failed += 1;
        return acc;
      },
      { accounts: reports.length, ok: 0, failed: 0, created: 0, updated: 0, removed: 0, reminders: 0, requests: 0, throttledMs: 0 },
    );

    // 同步改动了任务集（新增/改期/完成/删除）→ 通知排期必须整体重算。
    // 放在这里而不是每个账号内：排期是全局的（跨账号、含手动任务），
    // 分账号算会互相覆盖。
    await this.#refreshNotificationSchedule();

    const finishedAt = this.#clock.now();
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      accounts: reports,
      totals,
    };
  }

  /**
   * 单账号同步（公开入口）。
   *
   * 包了一层「一键同步」逻辑：内层同步若因会话失效而 auth-required，
   * 且保险箱里有这个账号保存的密码（账号密码登录才会有），就用它自动
   * 重新登录并重试一轮 —— 用户点一下同步按钮，从重登录到拿作业全流程跑完。
   *
   * 安全边界不变：粘贴 cookie / HAR / CDP 的账号没有保存凭据，
   * 这层逻辑对它们是空操作，绝不会替用户「造」一个新登录。
   */
  async syncAccount(account: PlatformAccount, opts: SyncOptions = {}): Promise<AccountSyncReport> {
    const report = await this.#syncAccountInner(account, opts);
    if (report.status !== 'auth-required' || opts.allowRelogin === false || opts.reloginAttempted) {
      return report;
    }

    const session = await this.#vault.load(account.id);
    const cred = session?.credentials;
    // imported 会话原则上也不该有凭据，但多防一手：凭据+来源双校验
    if (!session || !cred?.password || session.origin === 'imported') return report;
    const adapter = this.#registry.get(account.platformId);
    if (!adapter) return report;

    try {
      const ctx = this.#contextFor(account.platformId, account.id);
      const fresh = await adapter.login(ctx, { username: cred.username ?? account.username, ...cred });
      fresh.accountId = account.id;
      fresh.credentials = cred; // 保留凭据，下次失效还能再登
      await this.#vault.save(fresh);
      this.#logger.info('会话已失效，用保存的凭据自动重新登录成功，重试同步', {
        platformId: account.platformId,
        accountId: account.id,
      });
      return await this.#syncAccountInner(account, { ...opts, reloginAttempted: true });
    } catch (e) {
      const msg = `自动重新登录失败：${(e as Error).message ?? String(e)}`;
      this.#logger.warn('自动重新登录失败', { platformId: account.platformId, error: msg });
      return { ...report, message: msg };
    }
  }

  /** 单账号同步主体。所有异常在这里被转成报告，绝不向外抛。 */
  async #syncAccountInner(account: PlatformAccount, opts: SyncOptions): Promise<AccountSyncReport> {
    const startMs = this.#clock.nowMs();
    const stats = createHttpStats();
    const guardStats = createReadOnlyGuardStats();
    const now = this.#clock.now();
    const adapter = this.#registry.get(account.platformId);

    // 会话来源在读到会话之后才能确定，但 finish() 有可能在此之前就被调用，
    // 所以用可变引用 + 保守默认值（derived = 不假设用户自己带来的）。
    let sessionOrigin: SessionOrigin = 'derived';
    let sessionOriginNote = '会话来源未确定';

    const base: Omit<AccountSyncReport, 'status' | 'durationMs' | 'http' | 'readOnly' | 'sessionOrigin' | 'sessionOriginNote'> = {
      accountId: account.id,
      platformId: account.platformId,
      label: account.label,
      courses: 0,
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      vanished: 0,
      removed: 0,
      reminders: [],
      events: [],
      message: undefined,
    };

    const finish = async (
      status: SyncLogEntry['status'],
      patch: Partial<AccountSyncReport> = {},
      message?: string,
    ): Promise<AccountSyncReport> => {
      const endMs = this.#clock.nowMs();
      const report: AccountSyncReport = {
        ...base,
        ...patch,
        status,
        message,
        http: stats,
        readOnly: guardStats,
        sessionOrigin,
        sessionOriginNote,
        durationMs: endMs - startMs,
      };
      await this.#recordLog(report);
      return report;
    };

    if (!adapter) {
      return finish('skipped', {}, `未找到平台适配器 ${account.platformId}`);
    }

    const ctx = this.#contextFor(account.platformId, account.id, stats, opts.retry, guardStats);
    const log = ctx.logger;

    const session = await this.#vault.load(account.id);
    if (!session) {
      return finish('auth-required', {}, '本地无有效会话，请重新登录');
    }

    sessionOrigin = session.origin ?? 'derived';
    sessionOriginNote = mayReauthenticate(session)
      ? '独立登录得到的会话'
      : '用户自己提供的会话（我们只读取，不会替你重新登录）';

    let sessionRecovered = false;
    try {
      ({ recovered: sessionRecovered } = await this.#ensureSession(adapter, ctx, session, opts));
    } catch (e) {
      const err = toHubError(e, account.platformId);
      // 只有真正的会话类错误才算「需要重新登录」。网络/上游故障混进来会给出
      // 完全错误的指引（让用户去重登，而其实该去检查网络）—— 分类错了，
      // 用户接下来做的事就全错。
      const authLike =
        err.code === 'AUTH_REQUIRED' ||
        err.code === 'AUTH_FAILED' ||
        err.code === 'CAPTCHA_REQUIRED';
      const note = err.details?.recoveryNote;
      const msg =
        (authLike ? this.#authMessage(err.message, session, adapter) : err.message) +
        (typeof note === 'string' ? ` 〔${note}〕` : '');
      const status: PlatformAccount['lastSyncStatus'] = authLike ? 'auth-required' : 'failed';
      await this.#markAccount(account, status, msg);
      return finish(status, {}, msg);
    }

    // ---- 课程（较稳定，可缓存） ----
    let courses = await this.#store.listCourses([account.id]);
    const courseTtl = opts.courseTtlMs ?? 12 * 60 * 60 * 1000;
    const courseAge = account.lastSyncAt ? now.getTime() - new Date(account.lastSyncAt).getTime() : Infinity;
    const shouldRefreshCourses =
      adapter.capabilities.courses &&
      (opts.refreshCourses === 'always' ||
        courses.length === 0 ||
        (opts.refreshCourses !== 'if-empty' && courseAge > courseTtl));

    // 记住课程拉取失败的原因。
    // 为什么必须记下来：课程是拉任务的前置（很多平台要先有 classId 才能查作业）。
    // 如果课程失败后仍拿空列表去拉任务，适配器会抛「缺少课程列表」——
    // 于是用户看到的是这个二次错误，而**真正的原因**（未登录 / 环境不支持 / 网络不通）
    // 被掩盖了。排查时完全找不到方向。
    let courseError: unknown;

    if (shouldRefreshCourses) {
      try {
        const page = await adapter.fetchCourses(ctx, session);
        const at = this.#clock.now().toISOString();
        const mapped = page.items.map((c) => ({
          id: makeCourseId(account.platformId, account.id, c.platformCourseId),
          platformId: account.platformId,
          accountId: account.id,
          platformCourseId: c.platformCourseId,
          name: c.name,
          teacher: c.teacher,
          term: c.term,
          sourceUrl: c.sourceUrl,
          lastSeenAt: at,
          raw: c.raw,
        }));
        if (!opts.dryRun) await this.#store.upsertCourses(mapped);
        courses = mapped;
        log.debug('课程列表已刷新', { count: mapped.length });
      } catch (e) {
        // 课程拉取失败不算致命：用缓存继续拉任务，只是课程名可能缺失
        courseError = e;
        log.warn('课程拉取失败，使用本地缓存继续', { error: describe(e) });
      }
    }

    // ---- 已全部完成的课程跳过重爬（见 SyncOptions.skipCompletedCourses 注释） ----
    // 用户删除的课程也在这一步折叠掉：排除清单里的课程不爬、不进 fetchTasks。
    const skipTtlMs =
      opts.skipCompletedCourses === false ? 0 : (opts.completedCourseTtlMs ?? 6 * 60 * 60 * 1000);
    let crawlMap: Record<string, string> = {};
    try {
      const c = await this.#store.getCursor(account.id, 'course-crawl');
      if (c?.cursor) crawlMap = JSON.parse(c.cursor) as Record<string, string>;
    } catch {
      // 游标损坏就当作没有 —— 顶多多爬一轮
    }
    let excludedCourses = new Set<string>();
    try {
      const c = await this.#store.getCursor(account.id, 'course-exclude');
      if (c?.cursor) excludedCourses = new Set(JSON.parse(c.cursor) as string[]);
    } catch {
      excludedCourses = new Set();
    }
    // 用户手动设为「不再同步」的课程：完全不发请求，但**保留库里的数据**。
    // 与「删整课」的区别：删整课会连同已有任务一起删掉，静默只是不再更新 ——
    // 往期课程用这个最合适：省掉全部请求，又不会丢掉历史记录。
    let mutedCourses = new Set<string>();
    try {
      const c = await this.#store.getCursor(account.id, 'course-mute');
      if (c?.cursor) mutedCourses = new Set(JSON.parse(c.cursor) as string[]);
    } catch {
      mutedCourses = new Set();
    }
    const isTerminal = (s: string) => s === 'submitted' || s === 'graded' || s === 'expired';
    /** 本轮真正要爬的课程；被跳过/排除的课程本轮不参与删除判定 */
    let crawlableCourses = courses;
    if (excludedCourses.size > 0 && crawlableCourses.length > 0) {
      const before = crawlableCourses.length;
      crawlableCourses = crawlableCourses.filter((c) => !excludedCourses.has(c.id));
      if (crawlableCourses.length < before) {
        log.info('跳过用户已删除的课程', { excluded: before - crawlableCourses.length, total: before });
      }
    }
    if (mutedCourses.size > 0 && crawlableCourses.length > 0) {
      const before = crawlableCourses.length;
      crawlableCourses = crawlableCourses.filter((c) => !mutedCourses.has(c.id));
      if (crawlableCourses.length < before) {
        log.info('跳过用户设为「不再同步」的课程', {
          muted: before - crawlableCourses.length,
          total: before,
        });
      }
    }
    let skippedCourseCount = 0;
    /** 静默课程（平台原始 ID）：全部终态且长期无变化 → 适配器可跳过考试等探测请求 */
    let quietCourseIds: string[] = [];
    if (skipTtlMs > 0 && crawlableCourses.length > 0) {
      const liveTasks = await this.#store.listTasks({ accountIds: [account.id] });
      const byCourse = new Map<string, UnifiedTask[]>();
      for (const t of liveTasks) {
        const list = byCourse.get(t.courseId);
        if (list) list.push(t);
        else byCourse.set(t.courseId, [t]);
      }
      const nowMs = now.getTime();
      const internalIdOf = (c: { platformCourseId: string }) =>
        makeCourseId(account.platformId, account.id, c.platformCourseId);
      crawlableCourses = crawlableCourses.filter((c) => {
        // UnifiedTask.courseId 是内部 ID（makeCourseId），不是平台原始 ID —— 键要对齐
        const ts = byCourse.get(internalIdOf(c));
        if (!ts || ts.length === 0) return true; // 库里没数据 → 必须爬
        if (!ts.every((t) => isTerminal(t.status))) return true; // 还有没做完的 → 必须爬
        const last = crawlMap[c.platformCourseId];
        if (!last || nowMs - new Date(last).getTime() >= skipTtlMs) return true; // TTL 已过 → 重爬
        return false;
      });
      skippedCourseCount = courses.length - crawlableCourses.length;
      if (skippedCourseCount > 0) {
        log.info('跳过已全部完成的课程（TTL 内）', {
          skipped: skippedCourseCount,
          total: courses.length,
        });
      }

      // ---- 静默课程：不会再产生新内容 ----
      // 判定从严（宁可多查一次，不可漏掉新测验）：
      //   ① 库里必须已经有该课程的数据（首次见到某课程时绝不判静默）
      //   ② 该课程全部任务都是终态（有任何未完成的都算活跃）
      //   ③ 最近 14 天没有任何新变化（lastSeenAt 是「平台最近一次确认它的时间」）
      // 满足这三条的课程，考试/测验的时间窗早已关闭，不可能再冒出新的。
      quietCourseIds = crawlableCourses
        .filter((c) => {
          const ts = byCourse.get(internalIdOf(c));
          if (!ts || ts.length === 0) return false;
          if (!ts.every((t) => isTerminal(t.status))) return false;
          const newest = Math.max(...ts.map((t) => new Date(t.lastSeenAt ?? 0).getTime()));
          return Number.isFinite(newest) && nowMs - newest >= QUIET_COURSE_MS;
        })
        .map((c) => c.platformCourseId);
      if (quietCourseIds.length > 0) {
        log.info('判定为静默课程，将跳过考试等探测请求', {
          quiet: quietCourseIds.length,
          total: crawlableCourses.length,
        });
      }
    }

    // 引擎级兜底：课程拉取失败且没有任何缓存时，绝不把空列表交给适配器 ——
    // 有的适配器会静默返回空任务，把「课程拉取失败」伪装成「没有作业」。
    // 必须在这里用根因（课程为什么失败）直接报错。
    // （放在跳过统计之后：courses 始终是完整列表，不含排除/跳过的语义。）
    if (courseError !== undefined && courses.length === 0 && adapter.capabilities.tasks) {
      const rootCause = toHubError(courseError, account.platformId);
      const msg = `课程列表拉取失败（作业依赖它）：${rootCause.message}`;
      await this.#markAccount(account, 'failed', msg);
      return finish('failed', { courses: 0 }, msg);
    }

    // ---- 任务（分页） ----
    const maxPages = opts.maxPages ?? 50;
    const cursorRecord = await this.#store.getCursor(account.id, 'tasks');
    const collected: PlatformTask[] = [];
    let nextCursor: string | undefined = cursorRecord?.cursor;
    let pages = 0;
    let complete = false;
    let declaredTotal: number | undefined;
    let pageError: unknown;
    /** 适配器本轮要说的话（诊断结论 / 已知边界）。见 Page.notes 的注释。 */
    const adapterNotes: string[] = [];

    // 上轮适配器「提前中止」过 → 本轮跑完整诊断（消费式：读一次就复位，
    // 避免此后每轮都慢跑）。机制是通用的，不绑定任何平台。
    let fullDiagnostics = false;
    try {
      const c = await this.#store.getCursor(account.id, 'full-diagnostics');
      if (c?.cursor === '1') {
        fullDiagnostics = true;
        await this.#store.setCursor({
          accountId: account.id,
          kind: 'full-diagnostics',
          cursor: '0',
          updatedAt: now.toISOString(),
        });
        log.info('上轮为提前中止，本轮跑完整诊断');
      }
    } catch {
      // 游标损坏就忽略
    }

    if (crawlableCourses.length === 0 && courses.length > 0) {
      // 所有课程都被跳过：本轮没有任何新鲜数据，
      // 必须保持 complete=false —— 绝不能让合并层把「没爬」当成「消失了」。
      // 注意 courses 本来就为空（从没爬到课程）时不能走这里 ——
      // 那是「缺课程列表」的故障状态，必须照常交给适配器去响亮报错。
      log.info('全部课程均在跳过 TTL 内，本轮不拉取任务');
    } else {
      try {
        for (;;) {
          if (pages >= maxPages) {
            log.warn('达到单轮最大翻页数，本轮禁用删除判定', { maxPages });
            break;
          }
          const req: FetchTasksRequest = {
            cursor: nextCursor,
            courses: crawlableCourses,
            limit: 100,
            fullDiagnostics,
            quietCourseIds,
          };
        const page = await adapter.fetchTasks(ctx, session, req);
        declaredTotal = page.declaredTotal ?? declaredTotal;
        collected.push(...page.items);
        if (page.notes?.length) adapterNotes.push(...page.notes);
        pages += 1;

        if (!page.hasMore || !page.nextCursor) {
          complete = true;
          nextCursor = page.nextCursor;
          break;
        }
        nextCursor = page.nextCursor;
      }
    } catch (e) {
      pageError = e;
      const err = toHubError(e, account.platformId);
      // 只有「会话 / 验证码」类问题才立刻中止并标记 auth-required。
      // 平台改版（SCHEMA_DRIFT）同样严重，但它不是登录问题 ——
      // 混为一谈会让 UI 弹出「请重新登录」这种完全误导人的提示。
      const isAuthIssue =
        err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_FAILED' || err.code === 'CAPTCHA_REQUIRED';

      if (isAuthIssue) {
        // 适配器「提前中止」过（如连续 5 门课都返回登录页）→ 记下游标，
        // 下次同步自动跑完整诊断。这样「省请求」和「拿全诊断」两者兼得。
        if (err.details?.failFast === true) {
          await this.#store.setCursor({
            accountId: account.id,
            kind: 'full-diagnostics',
            cursor: '1',
            updatedAt: this.#clock.now().toISOString(),
          });
        }
        // 同样先给自动接回一次机会（见 #tryRecover 的注释：不能在两条路径上给不同待遇）
        const recovery = await this.#tryRecover(adapter, ctx, session);
        if (recovery.recovered) {
          // 接回来了，但本轮已经中断 —— 不谎报成功，也不做删除判定
          // （complete 仍是 false），下一次同步自然补全。
          const msg = '会话曾中断，已自动恢复；本轮数据可能不完整，下次同步会补全';
          await this.#markAccount(account, 'partial', msg);
          return finish('partial', { courses: courses.length, fetched: collected.length }, msg);
        }
        const note = recovery.note;
        const msg = this.#authMessage(err.message, session, adapter) + (note ? ` 〔${note}〕` : '');
        await this.#markAccount(account, 'auth-required', msg);
        return finish('auth-required', { courses: courses.length, fetched: collected.length }, msg);
      }

      if (collected.length === 0) {
        // 一条都没拿到：本轮绝不能做删除判定，否则会把用户所有作业「删掉」
        //
        // 如果课程也失败了，优先报课程那个错 —— 它才是根因。
        // 例如「手机端没有原生 HTTP 桥」或「未在浏览器里登录平台」，
        // 都会先卡在课程这一步；继续往下走只会得到一个误导性的
        // 「缺少课程列表，无法拉取作业」。
        const rootCause = courseError !== undefined && courses.length === 0 ? toHubError(courseError, account.platformId) : err;
        const msg = courseError !== undefined && courses.length === 0
          ? `课程列表拉取失败（作业依赖它）：${rootCause.message}`
          : err.message;
        await this.#markAccount(account, 'failed', msg);
        return finish('failed', { courses: courses.length }, msg);
      }

      // 拿到了部分数据：合并已获取部分，但禁用删除判定（complete 仍为 false）
      log.warn('任务拉取中断，将合并已获取部分', { error: err.message, fetched: collected.length });
      }
    }

    // 爬取成功才更新「该课程刚被完整爬过」的游标；跳过发生时禁用删除判定 ——
    // 绝不能让合并层把「这轮没爬」当成「作业消失了」。
    if (skippedCourseCount > 0) complete = false;
    if (!opts.dryRun && complete && crawlableCourses.length > 0 && !pageError) {
      const at = now.toISOString();
      for (const c of crawlableCourses) crawlMap[c.platformCourseId] = at;
      await this.#store.setCursor({
        accountId: account.id,
        kind: 'course-crawl',
        cursor: JSON.stringify(crawlMap),
        updatedAt: at,
      });
    }

    // ---- 会话回写 ----
    // 很多平台在每次请求时滚动更新会话 cookie（滑动过期）。
    // 适配器会就地修改传入的 session 对象，这里必须落盘，
    // 否则下次同步拿到的还是旧 cookie，最终表现为「过几天就要重登一次」。
    if (!opts.dryRun && session !== undefined) {
      await this.#vault.save(session);
    }

    // ---- 改版检测 ----
    // 上游说「有 30 条」，我们解析出 0 条 —— 一定是解析器跟不上平台改版了。
    // 静默返回空会让用户以为作业做完了，这是本类应用最严重的故障模式。
    if (!pageError && collected.length === 0 && (declaredTotal ?? 0) > 0) {
      const err = schemaDrift(account.platformId, `上游声明 ${declaredTotal} 条任务，实际解析出 0 条`);
      await this.#markAccount(account, 'failed', err.message);
      return finish('failed', { courses: courses.length }, err.message);
    }

    // ---- 归一化 + 合并 ----
    const nameByPlatformCourse = new Map<string, string>(
      courses.map((c) => [c.platformCourseId, c.name] as const),
    );
    const incoming = collected.map((t) => {
      const task = materializeTask({
        platformId: account.platformId,
        accountId: account.id,
        platformTask: t,
        now,
        courseNameFallback: nameByPlatformCourse.get(t.courseId),
      });
      // 深链兜底：四个适配器都实现了 buildTaskUrl，但此前**从没有人调用它** ——
      // 于是「点作业名去平台」只有手写了 sourceUrl 的 PTA 能用，其余平台的作业名
      // 点了没反应。适配器只负责"拼 URL"，往任务上挂这一步统一在这里做。
      if (!task.sourceUrl && adapter.buildTaskUrl) {
        const url = adapter.buildTaskUrl(t.courseId, t);
        if (url) task.sourceUrl = url;
      }
      return task;
    });

    let existing = await this.#store.listTasks({ accountIds: [account.id], includeDeleted: true });

    // ---- 静默课程的非作业任务：本轮「主动不去看」它们 ----
    // 适配器跳过了静默课程的考试探测，所以这些任务不会出现在本轮结果里。
    // 若不把它们从「已有」中拿掉，合并层会按缺席处理它们 ——
    // 连续缺席达到阈值就软删除，历史考试记录会因此被误删。
    // 它们是「我们不去看」而不是「平台没有了」，所以直接不参与本轮判定。
    // （作业任务不受影响：静默课程的作业请求照常发，会被正常 touch。）
    if (quietCourseIds.length > 0) {
      const quietInternal = new Set(
        quietCourseIds.map((id) => makeCourseId(account.platformId, account.id, id)),
      );
      existing = existing.filter((t) => !(quietInternal.has(t.courseId) && t.kind !== 'homework'));
    }

    const plan = mergeTasks(existing, incoming, {
      ...DEFAULT_MERGE_OPTIONS,
      absenceThreshold: opts.absenceThreshold ?? DEFAULT_MERGE_OPTIONS.absenceThreshold,
      // 数据不完整时绝不做删除判定 —— 宁可多留一条，不可少留一条
      skipRemovalDetection: !complete || Boolean(pageError) || opts.dryRun === true,
    });

    let mergedCount = 0;
    if (!opts.dryRun && plan.writes.length > 0) {
      const upsert = await this.#store.upsertTasks(plan.writes);
      mergedCount = upsert.merged ?? 0;
    if (mergedCount > 0) {
        // 合并层认为「新增 N 条」，存储层却把其中一部分认领到了已有记录上 ——
        // 说明这些任务的标题指纹撞车了。真机踩过：拉取 84 条、列表里只剩几条，
        // 而日志一切正常。这类「静默吞掉」必须留下痕迹。
        log.warn('部分任务因标题指纹相同被认领到已有记录', {
          merged: mergedCount,
          plannedNew: plan.created,
          fetched: collected.length,
        });
      }
    }

    // ---- 提醒 ----
    let reminders: PlannedReminder[] = [];
    if (!opts.dryRun && !opts.skipReminders && this.#reminderSink) {
      reminders = await this.#dispatchReminders(account, now);
    }

    const status: SyncLogEntry['status'] = pageError ? 'partial' : 'ok';
    const notes: string[] = [];
    if (sessionRecovered) {
      // 自动接回是「好事」，但它必须是**可见的**：否则用户只能靠"这次没报错"去推断，
      // 而一个从不留下证据的机制，既没法验证也没法信任。
      notes.push('会话曾失效，已自动接回（无需你操作）');
    }
    if (pageError) notes.push(`部分完成：${describe(pageError)}`);
    if (skippedCourseCount > 0) {
      notes.push(
        `跳过 ${skippedCourseCount} 门已全部完成的课程（${opts.completedCourseTtlMs ?? 6 * 60 * 60 * 1000 / 3600000} 小时内不重爬）`,
      );
    }
    if (mergedCount > 0) {
      // 让「实际入库比拉取少」在界面上直接可见 ——
      // 这类数据丢失以前是完全静默的（真机：拉取 84 条，列表只剩几条）
      notes.push(`注意：${mergedCount} 条任务的标题与已有记录重复，已被合并`);
    }
    // 适配器要说的话放最后：它是补充说明，不该挤掉上面这些「本轮发生了什么」。
    //
    // 顺带修掉一个重复：这段 push 此前被复制了两份（相邻两个 if 完全相同），
    // 于是自动接回成功时消息里会出现两遍「会话曾失效，已自动接回」。
    for (const n of [...new Set(adapterNotes)]) {
      if (notes.join('；').length + n.length > 1200) break; // 消息是给人读的，不是日志倾倒口
      notes.push(n);
    }
    const message = notes.length > 0 ? notes.join('；') : undefined;
    await this.#markAccount(account, status, message);

    return finish(
      status,
      {
        courses: courses.length,
        fetched: collected.length,
        created: plan.created,
        updated: plan.updated,
        unchanged: plan.unchanged,
        vanished: plan.vanished,
        removed: plan.removed,
        reminders,
        events: plan.events,
      },
      message,
    );
  }

  /** 提醒投递 + 记账。把「已发送」和「已消费但未发送」的窗口都落库，防止后续补发风暴。 */
  async #dispatchReminders(account: PlatformAccount, now: Date): Promise<PlannedReminder[]> {
    const sink = this.#reminderSink;
    if (!sink) return [];

    const sentKeys = new Set((await this.#store.listReminders(account.id)).map((r) => r.key));
    const tasks = await this.#store.listTasks({ accountIds: [account.id] });
    const planned = planReminders(tasks, now, { rules: this.#rules, sentKeys });
    if (planned.length === 0) return [];

    const records: SentReminder[] = [];
    for (const r of planned) {
      await sink.deliver(r);
      records.push({
        key: r.key,
        taskId: r.taskId,
        ruleId: r.ruleId,
        accountId: r.accountId,
        sentAt: r.fireAt,
        revision: tasks.find((t) => t.id === r.taskId)?.revision ?? 1,
        channel: 'default',
        title: r.title,
      });
      for (const k of r.consumedKeys) {
        records.push({
          key: k,
          taskId: r.taskId,
          ruleId: `${r.ruleId}:consumed`,
          accountId: r.accountId,
          sentAt: r.fireAt,
          revision: 0,
          channel: 'suppressed',
          title: r.title,
        });
      }
    }
    await this.#store.recordReminders(records);
    return planned;
  }

  /** 单独跑一轮提醒检查（不拉取数据），适合高频定时器。 */
  async runReminders(): Promise<PlannedReminder[]> {
    const accounts = await this.#store.listAccounts();
    const now = this.#clock.now();
    const out: PlannedReminder[] = [];
    for (const a of accounts) {
      if (!a.enabled) continue;
      out.push(...(await this.#dispatchReminders(a, now)));
    }
    return out;
  }

  /**
   * 会话有效性检查：先看本地过期时间，只有必要时才发探测请求。
   *
   * ─────────────────────────────────────────────────────────────
   * 这里是「不影响平台正常使用」最关键的判断点。
   *
   * 会话失效时，我们**只报错，不尝试重新登录**。
   * 这不是偷懒，而是一条必须守住的边界：
   *
   *   重新登录 = 在服务端创建一个新会话。而多数平台是单点登录、
   *   或者会在每次登录时轮换 token —— 那会把用户正在用的手机/电脑上的
   *   那个会话顶掉，表现为「我明明没退，怎么就掉线了」。
   *   如果会话是用户自己从浏览器里复制出来的（origin === 'imported'），
   *   我们更没有任何立场替他重新登录。
   *
   * 所以正确做法是：报 AUTH_REQUIRED，让 UI 提示用户
   * 「请到浏览器里重新登录后把新的 Cookie 粘过来」——
   * 由用户自己决定什么时候重建会话，我们只做读者。
   *
   * 注意：本方法之所以不需要额外判断 origin，是因为引擎从一开始
   * 就不保存明文密码，根本没有"自动重新登录"的能力。
   * 这条注释的意义在于：**将来如果有人想在这里加自动续期，先读这段话。**
   * ─────────────────────────────────────────────────────────────
   */
  async #ensureSession(
    adapter: PlatformAdapter,
    ctx: AdapterContext,
    session: Session,
    opts: SyncOptions,
  ): Promise<{ recovered: boolean }> {
    const now = this.#clock.now();
    const expired = isSessionExpired(session, now);
    // probeBeforeSync：会话本地判断不了（没有 expiresAt）的平台主动探一次。
    // 既让失效在第一跳就暴露（错误分类准确、不白跑后续请求），
    // 也顺带刷新服务端的会话活跃时间（闲置超时会因此被续上）。
    const adapterWantsProbe = adapter.capabilities.probeBeforeSync === true;
    if (!expired && !opts.forceAuthProbe && !adapterWantsProbe) return { recovered: false };

    // 探测本身也可能抛错。注意区分：**会话类**错误意味着"探测给出了答案：不能用"，
    // 而网络/上游故障是真的没探测成。前者要继续走自动接回，后者照旧上抛。
    //
    // 真机踩过：会话失效时平台直接回了 HTML 登录页，解析层抛的是 CAPTCHA_REQUIRED，
    // 于是这里直接冒泡、自动接回完全没跑 —— 这条防线必须由引擎兜住，
    // 不能指望每个适配器都把错误码穷举对。
    let alive = false;
    try {
      alive = await adapter.probeSession(ctx, session);
    } catch (e) {
      const probeErr = toHubError(e, adapter.id);
      const authLike =
        probeErr.code === 'AUTH_REQUIRED' ||
        probeErr.code === 'AUTH_FAILED' ||
        probeErr.code === 'CAPTCHA_REQUIRED';
      if (!authLike) throw e;
      alive = false;
    }
    if (!alive) {
      // 会话没了 —— 但在宣告失败之前，先给适配器一次**自动把它接回来**的机会。
      // 有些平台在"本层会话"失效时上一层凭证还在（单点登录的总票据），
      // 浏览器遇到这种情况会静默重新换票、用户毫无察觉；这里就是把这个动作搬过来。
      // 能接回来的话，用户根本不会知道曾经掉过线 —— 这比"报错 + 引导重登"好一个量级。
      const recovery = await this.#tryRecover(adapter, ctx, session);
      if (recovery.recovered) {
        this.#logger.info('会话已自动接回（未打扰用户）', { platformId: adapter.id });
        return { recovered: true };
      }
      // 归因与提示语由 #authMessage() 统一附加 —— 保证「最可能的原因」与
      // 「我们不会替你重新登录」这两句话在所有发现会话失效的路径上都一致。
      // 自动续登没成功的原因一并带上：用户下次要重登时，至少知道是哪一环断了。
      throw new HubError('AUTH_REQUIRED', '会话已被平台失效。', {
        platformId: adapter.id,
        requiresUserAction: true,
        details: recovery.note ? { recoveryNote: recovery.note } : undefined,
      });
    }
    // 探测通过说明会话仍然可用，但本地 expiresAt 已经过了 —— 说明平台的
    // 过期时间比本地记录的更宽松（或本地记录有误）。清掉 expiresAt 避免每轮都探测。
    if (expired) {
      await this.#vault.save({ ...session, expiresAt: undefined });
    }
    return { recovered: false };
  }

  /**
   * 会话失效时的**自动接回**尝试（适配器可选能力）。永远不抛。
   *
   * 为什么抽成方法、且在**每一个**发现会话失效的地方都调用：
   * 会话失效会在多处被发现（同步前的探测、拉课程/任务时撞登录墙）。
   * 只在其中一处接回，用户就会遇到"有时候自己好了、有时候要重新登录"——
   * 这种时有时无的行为比稳定的失败更难理解，也更难信任。
   */
  async #tryRecover(
    adapter: PlatformAdapter,
    ctx: AdapterContext,
    session: Session,
  ): Promise<{
    recovered: boolean;
    note?: string;
    diagnosis?: 'recovered' | 'ticket-expired' | 'mechanism' | 'channel' | 'no-session';
  }> {
    if (!adapter.recoverSession) return { recovered: false };
    try {
      return await adapter.recoverSession(ctx, session);
    } catch (e) {
      return {
        recovered: false,
        note: `自动续登时出错：${(e as Error).message.slice(0, 80)}`,
        diagnosis: 'channel',
      };
    }
  }

  /**
   * 给 auth-required 的提示语附加「会话来源」相关的说明。
   *
   * 为什么必须集中在这里：会话失效可能在三处被发现 ——
   * 过期探测、拉课程、拉任务。如果只在其中一处拼提示语，
   * 用户就会遇到「有时候说得很清楚，有时候只丢一句 401」。
   * 而这句话直接决定了用户接下来做什么（重新登录 vs 重新粘贴凭证），
   * 以及在担心「会不会把我手机上的登录顶掉」，不能时有时无。
   */
  #authMessage(base: string, session: Session | undefined, adapter?: PlatformAdapter): string {
    // 归因顺序决定用户下一步做什么：把「异地登录」排在「闲置超时」前面，
    // 用户会以为账号被盗、跑去改密码 —— 而真实主因往往是平台每两小时闲置就掉一次。
    // 顺序只有适配器给得出来（它知道自家的会话机制），引擎只负责拼。
    const causes = adapter?.sessionExpiryCauses;
    const causeText =
      causes && causes.length > 0
        ? `最可能的原因：${causes[0]}${causes.length > 1 ? `（其次是${causes.slice(1).join('、')}）` : ''}。`
        : '';
    if (!session || mayReauthenticate(session)) return base + causeText;
    return (
      `${base}${causeText} 我们不会替你重新登录 —— 那可能会把你正在使用的浏览器/App 顶下线。` +
      '到「账号」页点这个账号的「一键重登」，在官方页面登录一次即可。'
    );
  }

  async #markAccount(
    account: PlatformAccount,
    status: PlatformAccount['lastSyncStatus'],
    message?: string,
  ): Promise<void> {
    await this.#store.upsertAccount({
      ...account,
      lastSyncAt: this.#clock.now().toISOString(),
      lastSyncStatus: status,
      lastSyncMessage: message,
    });
  }

  async #recordLog(report: AccountSyncReport): Promise<void> {
    const now = this.#clock.now().toISOString();
    await this.#store.appendSyncLog({
      accountId: report.accountId,
      platformId: report.platformId,
      startedAt: new Date(this.#clock.nowMs() - report.durationMs).toISOString(),
      finishedAt: now,
      status: report.status,
      created: report.created,
      updated: report.updated,
      removed: report.removed,
      fetched: report.fetched,
      message: report.message,
      requests: report.http.requests,
      retries: report.http.retries,
      durationMs: report.durationMs,
    });
  }

  #limiterFor(platformId: string): Limiter {
    let limiter = this.#limiters.get(platformId);
    if (!limiter) {
      limiter = new TokenBucket(this.#limits[platformId] ?? defaultLimitsFor(platformId));
      this.#limiters.set(platformId, limiter);
    }
    return limiter;
  }

  #contextFor(
    platformId: string,
    accountId: string,
    stats?: HttpStats,
    retry?: RetryPolicy,
    guardStats?: ReadOnlyGuardStats,
  ): AdapterContext {
    const limiter = this.#limiterFor(platformId);
    const httpStats = stats ?? createHttpStats();
    const logger = this.#logger.child({ platformId, accountId });

    // 管道顺序（从外到内）：
    //   只读守卫 → 限流/重试 → 真实传输
    //
    // 守卫放在最外层，是为了让被拦下的请求**根本不会发出去**，
    // 也不会计入限流令牌消耗、不会触发重试。
    const resilient = createResilientHttpClient(this.#baseHttp, {
      platformId,
      limiter,
      logger,
      stats: httpStats,
      retry,
    });
    const adapter = this.#registry.get(platformId);
    const guarded = createReadOnlyHttpClient(resilient, {
      platformId,
      policy: adapter?.readOnlyPolicy,
      logger,
      stats: guardStats ?? createReadOnlyGuardStats(),
    });

    return { http: guarded, clock: this.#clock, logger, limiter, signer: this.#signer };
  }

  // ---------------------------------------------------------------- 查询侧

  /**
   * 待办视图：按截止时间排序。
   * 这是 app 首页的核心查询，所以放在引擎里而不是让 UI 自己拼。
   */
  /**
   * 已完成的任务（已提交 / 已批阅 / 已过期），按截止时间倒序。
   *
   * 单独列出来不只是好看：用户拿它对照平台真实界面，才能确认
   * 「同步没漏课、状态映射没错」—— 待办只体现一半的数据面貌。
   */
  async completed(opts: { limit?: number; kinds?: TaskKind[] } = {}): Promise<UnifiedTask[]> {
    const now = this.#clock.now();
    const tasks = await this.#store.listTasks();
    const done = tasks.filter(
      (t) =>
        !t.deletedAt &&
        !t.userDeletedAt &&
        isTerminalStatus(effectiveStatus(t)) &&
        // 「已交但还没全 AC」不算了结：它留在待办页。
        // 一条信息只能有一个权威位置 —— 两边都出现会被当成两条作业。
        !hasPendingAc(t, now) &&
        (!opts.kinds || opts.kinds.includes(t.kind)),
    );
    done.sort((a, b) => {
      const aa = effectiveInstant(a.deadline, a.deadlineAt, now)?.getTime() ?? 0;
      const bb = effectiveInstant(b.deadline, b.deadlineAt, now)?.getTime() ?? 0;
      return bb - aa;
    });
    return done.slice(0, opts.limit ?? 100);
  }

  // ---------------------------------------------------------------- 手动任务

  /**
   * 手动添加一条待办。
   *
   * 为什么需要它：不是所有作业都能从平台抓到 —— 老师口头布置的、其他网站的、
   * 平台接口没覆盖的。这类任务如果记不进来，app 就不是"课业中枢"而只是"平台镜像"。
   *
   * 四个字段全部由用户填写（按要求：自行填写，不做平台/课程下拉选择）——
   * 选择框看着规整，但会把手动任务限制在"已知平台"里，那正是它要解决的问题。
   */
  async createManualTask(input: {
    title: string;
    deadlineAt: string;
    courseName?: string;
    /**
     * 明确指定归到哪门课（用户在被问到「同名课程，要归过去吗」时选了"是"）。
     * 给了它就不再按名字猜 —— 猜是猜不准的，尤其是同名课有两门以上时。
     */
    courseId?: string;
    /** 用户明确选了"新建独立分组"——此时**不要**按名字自动归到已有课程。 */
    newCourse?: boolean;
    platformLabel?: string;
    kind?: TaskKind;
  }): Promise<UnifiedTask> {
    const title = input.title.trim();
    if (!title) throw new HubError('UNKNOWN', '作业名称不能为空');

    const due = new Date(input.deadlineAt);
    if (!Number.isFinite(due.getTime())) {
      throw new HubError('UNKNOWN', `截止时间无法识别：${input.deadlineAt}`);
    }

    const now = this.#clock.now();
    const courseName = input.courseName?.trim() || '未分类';
    // 尽量归到已有课程：手动任务的 courseId 本来只是用户敲的课程名，
    // 于是和平台课程同名时会分裂成两拨 —— 待办里看着一样，点课程名只筛到一拨。
    // 名字**唯一**匹配时直接用那门课的 ID；多门同名就保持独立，
    // 交给用户在课程页用「⇄」明确归并（自动猜会猜错）。
    const sameName = (await this.#store.listCourses()).filter((c) => courseTitle(c) === courseName);
    const hitCourse = input.newCourse
      ? undefined
      : input.courseId
        ? sameName.find((c) => c.id === input.courseId)
        : sameName.length === 1
          ? sameName[0]
          : undefined;
    const task = materializeTask({
      platformId: MANUAL_PLATFORM_ID,
      accountId: MANUAL_ACCOUNT_ID,
      platformTask: {
        // 没有上游 ID，自己造一个稳定的：时间戳 + 随机后缀，
        // 同一条任务被重复保存时也不会撞车（用户手动添加，重复是人的操作，不是同步抖动）
        platformTaskId: `manual-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        courseId: courseName,
        courseName,
        kind: input.kind ?? 'homework',
        title,
        status: 'pending',
        // 手动任务背后根本没有平台，"未完成"是我们自己给的初值 ——
        // 标成 inferred，用户点「标记完成」才生效（否则平台优先规则会把它自己压住）。
        statusSource: 'inferred',
        deadline: due.toISOString(),
      },
      now,
    });
    if (hitCourse) {
      task.courseId = hitCourse.id;
      task.courseName = courseTitle(hitCourse);
    }

    const label = input.platformLabel?.trim();
    if (label) task.platformLabel = label;

    // 手动添加同样是一次「新增」—— 记录页不该偏爱同步来的任务。
    // 用户几天后想确认「这条是我自己加的，还是平台给的」，靠的就是这一条。
    task.history = [{ field: 'created', from: null, to: title, at: now.toISOString() }];

    await this.#store.upsertTasks([task]);
    await this.#refreshNotificationSchedule();
    this.#logger.info('手动添加任务', { taskId: task.id, title, dueAt: due.toISOString() });
    return task;
  }

  // ---------------------------------------------------------------- 通知排期

  /**
   * 让外部（设置页改完提醒配置）能**立刻**重排，不必等下一次同步。
   * 不这么做的话，用户改完档位要等下次同步才生效 —— 而"改了没反应"
   * 是这个项目最忌讳的失败形态。
   */
  async rescheduleNotifications(): Promise<void> {
    await this.#refreshNotificationSchedule();
  }

  /**
   * 重算「未来要弹的通知」并整体下发给原生。
   *
   * 全量替换：原生侧先把旧闹钟全部撤销，再按这份清单注册。这样做的好处是
   * **不需要维护增量状态** —— 任务改期、完成、删除、手动新增，都只需要重算一次，
   * 不存在"漏撤一个闹钟"的可能。
   */
  async #refreshNotificationSchedule(): Promise<void> {
    if (!this.#notificationSink) return;
    try {
      const items = await this.upcomingNotifications();
      await this.#notificationSink.schedule(items);
    } catch (e) {
      // 排期失败不能影响同步结果 —— 它只是个附加能力
      this.#logger.warn('下发通知排期失败', { error: (e as Error).message });
    }
  }

  /** 当前算出来的未来提醒（只读，无副作用）。界面用它显示「已排期 N 条」。 */
  async upcomingNotifications(): Promise<ScheduledNotification[]> {
    const tasks = await this.#store.listTasks();
    return buildNotificationSchedule(tasks, this.#clock.now(), {
      prefs: this.#notifyPrefs?.(),
    });
  }

  /**
   * 用户删除单条任务。与同步层的软删除不同：打上 userDeletedAt 墓碑，
   * 合并层见到它就不复活 —— 不管平台还推多少次。
   */
  async deleteTask(accountId: string, taskId: string): Promise<void> {
    const tasks = await this.#store.listTasks({ accountIds: [accountId], includeDeleted: true });
    const t = tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`任务不存在：${taskId}`);
    await this.#store.upsertTasks([{ ...t, userDeletedAt: this.#clock.now().toISOString() }]);
    // 任务没了，它未来那些提醒也必须撤掉 —— 否则用户会为一条自己删掉的作业收到通知
    await this.#refreshNotificationSchedule();
    this.#logger.info('用户删除任务', { accountId, taskId, title: t.title });
  }

  /**
   * 用户手动标记 / 撤销「已完成」。
   *
   * 与删除一样，它是**本地事实**，不是对平台的写操作：全程只改本地记录，
   * 一个请求都不发（"只读"这条永不变）。
   *
   * 为什么要返回 `suppressedByPlatform`：按「平台优先」，平台明确断言过"未完成"时
   * 这个标记会被压制。**"点了没反应"必须给出可解释的答复** ——
   * 静默什么都不做，正是这个项目最忌讳的失败形态。
   */
  async setTaskCompleted(
    taskId: string,
    completed: boolean,
  ): Promise<{ applied: boolean; suppressedByPlatform: boolean; task: UnifiedTask }> {
    const all = await this.#store.listTasks({ includeDeleted: true });
    const t = all.find((x) => x.id === taskId);
    if (!t) throw new HubError('UNKNOWN', `任务不存在：${taskId}`);

    const next: UnifiedTask = completed
      ? { ...t, userCompletedAt: this.#clock.now().toISOString() }
      : { ...t, userCompletedAt: undefined };

    // 平台明确说"未完成"→ 标记不生效（平台优先）。用户的话仍然留下，只是暂时被压制。
    const suppressedByPlatform =
      completed && next.statusSource !== 'inferred' && next.status === 'pending';

    await this.#store.upsertTasks([next]);
    // 提醒排期跟着变：标完成后不该再为它响；撤销后要补回来
    await this.#refreshNotificationSchedule();
    this.#logger.info(completed ? '手动标记完成' : '撤销手动完成标记', {
      taskId,
      title: t.title,
      suppressedByPlatform,
    });
    return { applied: !suppressedByPlatform, suppressedByPlatform, task: next };
  }

  /**
   * 用户判定「这条不用我交」（小组由别人交 / 免修 / 换课）。
   *
   * 与 setTaskCompleted 的关键区别：**它不受「平台优先」限制，永远不会被压制**。
   * 因为 skipped 说的是另一个维度的事 —— 平台说 pending 只否定了"我交了"，
   * 从没说过"这条需要你交"。所以这里没有 suppressedByPlatform 这个返回值。
   *
   * 与 completed **互斥**：标一个会清掉另一个
   * （用户不可能同时说"我交了"和"不用我交"，两个都留着只会让状态含糊）。
   */
  async setTaskSkipped(taskId: string, skipped: boolean): Promise<{ task: UnifiedTask }> {
    const all = await this.#store.listTasks({ includeDeleted: true });
    const t = all.find((x) => x.id === taskId);
    if (!t) throw new HubError('UNKNOWN', `任务不存在：${taskId}`);

    const next: UnifiedTask = skipped
      ? { ...t, userSkippedAt: this.#clock.now().toISOString(), userCompletedAt: undefined }
      : { ...t, userSkippedAt: undefined };

    await this.#store.upsertTasks([next]);
    // 排期跟着变：标"不用交"后不该再为它响；撤销后要补回来
    await this.#refreshNotificationSchedule();
    this.#logger.info(skipped ? '标记不用交' : '撤销不用交标记', { taskId, title: t.title });
    return { task: next };
  }

  /**
   * 用户删除整个课程：该课程所有任务打墓碑，并记入排除清单 ——
   * 之后的同步**不再爬取这门课**（结课课程一次请求都不发，正是用户要的提速）。
   */
  async deleteCourse(accountId: string, courseId: string): Promise<{ removed: number }> {
    const tasks = (await this.#store.listTasks({ accountIds: [accountId], includeDeleted: true })).filter(
      (t) => t.courseId === courseId && !t.userDeletedAt,
    );
    const at = this.#clock.now().toISOString();
    if (tasks.length > 0) {
      await this.#store.upsertTasks(tasks.map((t) => ({ ...t, userDeletedAt: at })));
    }

    let excluded: string[] = [];
    try {
      const c = await this.#store.getCursor(accountId, 'course-exclude');
      if (c?.cursor) excluded = JSON.parse(c.cursor) as string[];
    } catch {
      excluded = [];
    }
    if (!excluded.includes(courseId)) {
      excluded.push(courseId);
      await this.#store.setCursor({
        accountId,
        kind: 'course-exclude',
        cursor: JSON.stringify(excluded),
        updatedAt: at,
      });
    }
    this.#logger.info('用户删除课程（已加入同步排除清单）', { accountId, courseId, removed: tasks.length });
    return { removed: tasks.length };
  }

  /**
   * 把某门课设为「不再同步」（手动静默）。
   *
   * 与 `deleteCourse`（删整课）的区别很重要：
   *   - 删整课：任务被标记删除 + 加入排除清单 —— 库里也看不到了；
   *   - 静默：**不动任何已有数据**，只是后续同步不再请求这门课。
   * 往期课程用它最合适：省掉全部请求，历史记录仍然完整保留。
   *
   * 注意：静默是用户的长期偏好，**重新登录不会自动撤销**它
   * （与「删整课」被重新登录清除的语义相反 —— 那个是「重新开始」的信号）。
   */
  async setCourseMuted(accountId: string, courseId: string, muted: boolean): Promise<void> {
    let list: string[] = [];
    try {
      const c = await this.#store.getCursor(accountId, 'course-mute');
      if (c?.cursor) list = JSON.parse(c.cursor) as string[];
    } catch {
      list = [];
    }
    const set = new Set(list);
    if (muted) set.add(courseId);
    else set.delete(courseId);
    await this.#store.setCursor({
      accountId,
      kind: 'course-mute',
      cursor: JSON.stringify([...set]),
      updatedAt: this.#clock.now().toISOString(),
    });
    this.#logger.info(muted ? '课程已设为不再同步' : '课程已恢复同步', { accountId, courseId });
  }

  /**
   * 改一门课的**显示名**（保存到 `displayName`，不动 `name`）。
   *
   * 为什么只动显示名：`name` 是数据键的一部分（和平台比对、去重、日志都靠它），
   * 改了它下次同步就会被平台写回，而且历史记录会对不上。
   *
   * `name` 传空 = 恢复平台原名（清掉 displayName）。
   *
   * 重名**不拒绝**：两门同名课各自有 ID，界面上靠平台标签区分、筛选也按 ID，
   * 所以同名本身不是错误。这里只把冲突**报回去**，让界面决定要不要提示用户
   * （比如「已有同名课程，确定吗」）。一律拒绝反而把用户逼到"改个错名"。
   */
  async renameCourse(
    courseId: string,
    name: string | null,
  ): Promise<{ ok: boolean; conflict?: { id: string; title: string; platformId: string } }> {
    const courses = await this.#store.listCourses();
    const target = courses.find((c) => c.id === courseId);
    if (!target) throw new HubError('UNKNOWN', `课程不存在：${courseId}`);

    const trimmed = name?.trim() ?? '';
    // 清空 → 恢复原名（显式写 undefined，让 upsert 的展开覆盖掉旧值）
    if (!trimmed) {
      await this.#store.upsertCourses([{ ...target, displayName: undefined }]);
      this.#logger.info('课程恢复原名', { courseId, name: target.name });
      return { ok: true };
    }

    // 只在**同一账号内**检测重名：两个学校都有「高等数学」很常见，跨账号检测会一直误报
    const clash = courses.find(
      (c) => c.id !== courseId && c.accountId === target.accountId && courseTitle(c) === trimmed,
    );
    await this.#store.upsertCourses([{ ...target, displayName: trimmed }]);
    this.#logger.info('课程改名', { courseId, from: courseTitle(target), to: trimmed });
    return clash
      ? { ok: true, conflict: { id: clash.id, title: courseTitle(clash), platformId: clash.platformId } }
      : { ok: true };
  }

  /**
   * 把「游离的手动任务」归并到某门课下。
   *
   * 为什么需要它：手动添加的作业没有平台课程可挂，`courseId` 用的是用户敲的**课程名**。
   * 于是当平台课程也叫这个名字时，待办里会出现两拨同名条目，点课程名筛选只筛到一拨。
   * 归并就是把那些任务的 `courseId` 改写成目标课程的真实 ID。
   *
   * 只动**手动任务**（accountId === 'manual'）：
   * 平台任务的课程归属由平台决定，硬改下次同步就会被写回去，等于没改。
   */
  async adoptManualTasks(courseId: string): Promise<{ moved: number }> {
    const courses = await this.#store.listCourses();
    const target = courses.find((c) => c.id === courseId);
    if (!target) throw new HubError('UNKNOWN', `课程不存在：${courseId}`);

    const all = await this.#store.listTasks({ includeDeleted: true });
    const loose = all.filter((t) => t.accountId === MANUAL_ACCOUNT_ID && t.courseId !== courseId);
    // 「同名」包括两种：courseId 就是那个名字，或任务上记的课程名和它一致
    const title = courseTitle(target);
    const hit = loose.filter((t) => t.courseId === title || t.courseName === title || t.courseId === target.name || t.courseName === target.name);
    if (hit.length === 0) return { moved: 0 };

    await this.#store.upsertTasks(
      hit.map((t) => ({ ...t, courseId, courseName: title })),
    );
    this.#logger.info('手动作业归并到课程', { courseId, moved: hit.length });
    return { moved: hit.length };
  }

  /**
   * 列出账号下的课程，附带「是否静默」与任务数 —— 供界面的课程管理使用。
   * 任务数包含所有状态（含已删除），这样用户能看到「静默不影响已有数据」。
   */
  async listCoursesWithState(
    accountId: string,
  ): Promise<{
    id: string;
    name: string;
    displayName?: string;
    platformCourseId: string;
    muted: boolean;
    taskCount: number;
  }[]> {
    const courses = await this.#store.listCourses([accountId]);
    const tasks = await this.#store.listTasks({ accountIds: [accountId], includeDeleted: true });
    const countByCourse = new Map<string, number>();
    for (const t of tasks) countByCourse.set(t.courseId, (countByCourse.get(t.courseId) ?? 0) + 1);

    let muted: string[] = [];
    try {
      const c = await this.#store.getCursor(accountId, 'course-mute');
      if (c?.cursor) muted = JSON.parse(c.cursor) as string[];
    } catch {
      muted = [];
    }
    const mutedSet = new Set(muted);

    return courses
      .map((c) => ({
        id: c.id,
        name: c.name,
        displayName: c.displayName,
        platformCourseId: c.platformCourseId,
        muted: mutedSet.has(c.id),
        taskCount: countByCourse.get(c.id) ?? 0,
      }))
      .sort((a, b) => courseTitle(a).localeCompare(courseTitle(b), 'zh-CN'));
  }

  async upcoming(opts: { withinDays?: number; limit?: number; kinds?: TaskKind[]; includeOverdue?: boolean } = {}): Promise<UnifiedTask[]> {
    const now = this.#clock.now();
    const withinMs = (opts.withinDays ?? 14) * DAY_MS;
    const includeOverdue = opts.includeOverdue ?? true;

    const tasks = await this.#store.listTasks();
    const filtered = tasks.filter((t) => {
      if (t.deletedAt || t.userDeletedAt) return false;
      // 用生效状态：用户手标的"已完成"要能进已完成栏、出待办栏
      const st = effectiveStatus(t);
      // 「题全交了但还没全 AC」仍是待办的一种 —— 它被排除在终态之外，
      // 否则用户交了之后想回来刷 AC，就再也找不到这条作业了。
      if (isTerminalStatus(st) && !hasPendingAc(t, now)) return false;
      if (opts.kinds && !opts.kinds.includes(t.kind)) return false;
      const at = effectiveInstant(t.deadline, t.deadlineAt, now);
      if (at) {
        const remain = at.getTime() - now.getTime();
        if (remain < 0) return includeOverdue;
        return remain <= withinMs;
      }
      // 期限未知 / 不限时的任务必须保留 —— 它们没法按时间排序，但不该消失。
      //
      // 真机踩过（2026-10-06）：这里原本是 `return t.deadline.kind !== 'unknown'`，
      // 即把「期限未知」的任务直接丢掉。后果是**整门课凭空消失**：
      // 超星 84 条任务的截止时间都没解析出来（kind=unknown），
      // 于是它们进不了待办（在这里被丢弃），也进不了已完成（状态不是终态）——
      // 在界面上彻底不可见，而库里明明有数据。
      // 前端 `renderTodo` 早就准备了「期限未知」分组，是后端先滤掉了它们。
      return true;
    });

    filtered.sort((a, b) => {
      const ra = rank(a, now, includeOverdue);
      const rb = rank(b, now, includeOverdue);
      if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
      // 同一紧急度里，「已交未全 AC」排到未交的后面。
      // 半透明降的是视觉权重，位置降的才是注意力 —— 一条今天截止但已经交了的作业，
      // 不该占着「24 小时内」的第一个位置。
      const pa = hasPendingAc(a, now) ? 1 : 0;
      const pb = hasPendingAc(b, now) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (ra.ms !== rb.ms) return ra.ms - rb.ms;
      return a.title.localeCompare(b.title, 'zh-CN');
    });

    return opts.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  async recentChanges(
    since: Date,
    limit = 50,
  ): Promise<{ task: UnifiedTask; changes: UnifiedTask['history'] }[]> {
    // includeDeleted —— 任务被软删除（平台撤了作业 / 课程被移除）之后，
    // 它的变更记录**不能跟着消失**：否则用户会看到历史「倒退」，
    // 昨天还在的改期记录今天凭空没了，比没有记录更让人不信任。
    const tasks = await this.#store.listTasks({ includeDeleted: true });
    const from = since.getTime();
    // 时间参数无效时不要静默返回空 —— 「参数错」和「真的没有变更」
    // 在界面上长得一模一样（都是"最近没有记录"），这是最难发现的一类失效。
    // 退化成最近 30 天：宁可多给一条，不可静默少给。
    const floor = Number.isFinite(from) ? from : Date.now() - 30 * DAY_MS;

    const hits = tasks
      .map((task) => {
        const list = task.history.filter((h) => {
          const at = new Date(h.at).getTime();
          return Number.isFinite(at) && at >= floor;
        });
        const latest = list.reduce((max, h) => Math.max(max, new Date(h.at).getTime()), 0);
        return { task, changes: list, latest };
      })
      .filter((x) => x.changes.length > 0)
      // 按「最近一条变更」倒序：这一页的第一屏必须是刚发生的事。
      // 之前的实现按 store 插入顺序（≈ 建号先后）返回、且**先 slice 后排序**，
      // 于是新变更排在列表末尾、条数一多还会被整条截掉 ——
      // 表现就是"这页不更新"，而数据其实一条没少。
      .sort((a, b) => b.latest - a.latest);

    return hits.slice(0, limit).map(({ task, changes }) => ({ task, changes }));
  }
}

/** 排序桶：逾期最前，其次有明确截止时间的，最后不限时的。 */
function rank(task: UnifiedTask, now: Date, includeOverdue: boolean): { bucket: number; ms: number } {
  const at = effectiveInstant(task.deadline, task.deadlineAt, now);
  if (at) {
    const ms = at.getTime() - now.getTime();
    if (ms < 0) return { bucket: includeOverdue ? 0 : 3, ms };
    return { bucket: 1, ms };
  }
  return { bucket: 2, ms: Number.MAX_SAFE_INTEGER };
}
