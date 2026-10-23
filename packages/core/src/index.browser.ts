/**
 * HomeworkHub Core —— **浏览器/WebView 专用入口**。
 *
 * 与 index.ts 的唯一区别：去掉了 4 个依赖 Node 内置模块的实现。
 * 那些模块顶层 `import { ... } from 'node:fs'`，一旦进浏览器模块图，
 * 整个 bundle 会因解析不到 node: 前缀而加载失败（不是「调用时才报错」，
 * 而是「加载就报错」）。
 *
 *   去掉：JsonFileStore（node:fs）· EncryptedVault（node:crypto）
 *         FetchHttpClient（依赖 Node 的响应行为）· SubprocessSigner（node:child_process）
 *   替代：PersistentStore（packages/web-kit）· WebCryptoVault · BridgeHttpClient
 *
 * 其余部分（domain / ports / engine / 纯 infra）在两个环境完全共用 ——
 * 也就是说：同步、合并、提醒、只读守卫这些真正容易出错的逻辑，
 * 桌面端和手机端跑的是同一份代码。
 *
 * ⚠️ 改动 index.ts 时记得同步这里。这条约束靠人守不住，
 * 所以配了 scripts/check-browser-safe.mjs 在构建前自动校验（见 build-android.mjs）。
 */

// ---- domain ----
export type { Deadline, DeadlineUnit } from './domain/deadline.ts';
export {
  normalizeDeadline,
  deadlineInstant,
  effectiveInstant,
  deadlineKey,
  msUntil,
  formatCountdown,
  formatEffective,
  humanizeCountdown,
} from './domain/deadline.ts';

export type {
  UnifiedTask,
  PlatformTask,
  TaskKind,
  TaskStatus,
  TaskChange,
  ChangeField,
  TaskProgress,
  TaskSubtask,
} from './domain/task.ts';
export {
  isActionable,
  isOverdue,
  isTerminalStatus,
  effectiveStatus,
  completionOrigin,
  canMarkCompleted,
  canSkip,
  hasPendingAc,
} from './domain/task.ts';

export type { UnifiedCourse, PlatformCourse, PlatformAccount } from './domain/course.ts';
export { courseTitle, maskUsername } from './domain/course.ts';

export {
  hashOf,
  sha1Hex,
  makeTaskId,
  makeCourseId,
  makeFingerprint,
  makeReminderKey,
  normalizeTitle,
} from './domain/ids.ts';

export type { Clock } from './domain/time.ts';
export { systemClock, FakeClock } from './domain/time.ts';

export type { ErrorCode } from './domain/errors.ts';
export {
  HubError,
  authRequired,
  rateLimited,
  netError,
  upstreamError,
  schemaDrift,
  signerUnavailable,
  writeBlocked,
  describe,
  toHubError,
} from './domain/errors.ts';

// ---- ports ----
export type {
  PlatformAdapter,
  AdapterContext,
  AdapterCapabilities,
  AdapterManifest,
  AuthMethod,
  AuthField,
  Page,
  FetchTasksRequest,
  FetchCoursesRequest,
} from './ports/adapter.ts';
export { AdapterRegistry } from './ports/registry.ts';

export type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from './ports/http.ts';
export { serializeCookies, parseSetCookie, mergeSetCookies } from './ports/http.ts';

export type { Session, Credentials, Vault, SessionOrigin } from './ports/vault.ts';
export { isSessionExpired, sessionTtlMs, isImportedSession, mayReauthenticate } from './ports/vault.ts';

export type { ReadOnlyPolicy, ReadOnlyGuardStats } from './ports/read-only.ts';
export { createReadOnlyGuardStats } from './ports/read-only.ts';

export type { HubStore, SyncCursor, SentReminder, SyncLogEntry, TaskFilter, UpsertResult } from './ports/store.ts';

export type { Logger, LogLevel, LogFields } from './ports/logger.ts';
export { createSilentLogger } from './ports/logger.ts';

export type { Limiter, LimiterOptions } from './ports/limiter.ts';
export type { NativeSigner, SignRequest } from './ports/signer.ts';
export { UnavailableSigner } from './ports/signer.ts';

// ---- engine ----
export { SyncEngine } from './engine/sync-engine.ts';
export type {
  SyncEngineDeps,
  SyncOptions,
  SyncReport,
  AccountSyncReport,
  ReminderSink,
} from './engine/sync-engine.ts';

export { mergeTasks, materializeTask, diffTask, DEFAULT_MERGE_OPTIONS } from './engine/merge.ts';
export { ADAPTER_PROMPT, ADAPTER_PITFALLS, buildEvidencePack, drillPack } from './engine/adapter-authoring.ts';
export { DeclarativeAdapter, validateConfig, normalizeAdapterConfig, getByPath, mapStatus } from './engine/declarative-adapter.ts';
export type { AdapterConfig } from './engine/declarative-adapter.ts';
export type { MergePlan, MergeOptions, TaskEvent } from './engine/merge.ts';

export { planReminders, DEFAULT_REMINDER_RULES } from './engine/reminder.ts';
export {
  NOTIFY_PREFS_KEY,
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_LEVEL_LABELS,
  normalizeNotifyPrefs,
  readNotifyPrefs,
  writeNotifyPrefs,
} from './engine/notify-prefs.ts';
export type { PrefsStorage } from './engine/notify-prefs.ts';
export {
  buildNotificationSchedule,
  NOTIFY_LEVELS,
  NOTIFY_OFFSETS,
  NOTIFY_PRESETS,
  DEFAULT_REMIND_SPECS,
  MIN_GAP_HOURS,
  maxTimesFor,
  specToOffsets,
} from './engine/notify-schedule.ts';
export type {
  NotifyLevel,
  NotifyPrefs,
  RemindSpec,
  ScheduledNotification,
} from './engine/notify-schedule.ts';
export type { ReminderRule, PlannedReminder, PlanRemindersOptions } from './engine/reminder.ts';

export { SessionHttpClient } from './engine/session-http.ts';
export type { JsonResult } from './engine/session-http.ts';

export {
  createReadOnlyHttpClient,
  authOnlyPolicy,
  DEFAULT_FORBIDDEN_PATTERNS,
} from './engine/read-only-guard.ts';
export type { ReadOnlyGuardOptions } from './engine/read-only-guard.ts';

export {
  createResilientHttpClient,
  createHttpStats,
  backoffDelay,
  mapLimit,
  DEFAULT_RETRY,
} from './engine/http-pipeline.ts';
export type { HttpStats, RetryPolicy, ResilientHttpOptions } from './engine/http-pipeline.ts';

// ---- 纯 infra（无 Node 依赖） ----
export { MemoryStore } from './infra/memory-store.ts';
export type { MemoryStoreSnapshot } from './infra/memory-store.ts';
export { ConsoleLogger } from './infra/console-logger.ts';
export { TokenBucket, DEFAULT_PLATFORM_LIMITS, defaultLimitsFor } from './infra/token-bucket.ts';
export {
  decodeEntities,
  stripTags,
  matchAll,
  firstGroup,
  splitBlocks,
  extractLink,
  queryParam,
  looksLikeAuthWall,
} from './infra/html.ts';

// ---- 零/低影响传输路线 ----
export type {
  HarLog,
  HarEntry,
  HarRequest,
  HarResponse,
  HarContent,
  HarNameValuePair,
  HarCreator,
} from './infra/har.ts';
export {
  serializeHar,
  parseHar,
  headerPairsToMap,
  splitResponseHeaders,
  normalizeUrlForMatching,
  urlPathKey,
  SENSITIVE_REQUEST_HEADERS,
  SENSITIVE_RESPONSE_HEADERS,
} from './infra/har.ts';
export { RecordingHttpClient } from './infra/recording-http.ts';
export type { RecordingHttpOptions, RecordedRequest } from './infra/recording-http.ts';
export { HarReplayHttpClient, createReplayStats } from './infra/har-replay-http.ts';
export type { HarReplayOptions, ReplayStats } from './infra/har-replay-http.ts';
// CDP 在手机上没意义（依赖本机浏览器调试端口），但代码是纯 fetch + WebSocket，
// 保留导出以免桌面/移动两套 barrel 出现无谓差异。
export {
  CdpHttpClient,
  CdpConnection,
  discoverCdpTargets,
  nodeWebSocketFactory,
  buildPageFetchExpression,
  buildEvaluateMessage,
  parseCdpFrame,
  pickTargetForOrigin,
} from './infra/cdp-http.ts';
export type {
  CdpTarget,
  CdpHttpOptions,
  CdpConnectionOptions,
  WsLike,
  WsFactory,
  PageFetchConfig,
  CdpFrame,
} from './infra/cdp-http.ts';
