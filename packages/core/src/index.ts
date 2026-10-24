/**
 * HomeworkHub Core —— 跨平台课业聚合核心库。
 *
 * 分层：
 *   domain/  纯数据模型与规则，无 IO
 *   ports/   抽象契约（适配器 / 存储 / 保险箱 / HTTP / 签名 / 限流）
 *   engine/  编排逻辑（同步、合并、提醒、会话 HTTP）
 *   infra/   具体实现（JSON 存储、AES 保险箱、fetch、令牌桶、子进程签名）
 *
 * 依赖方向严格单向：infra → engine → ports → domain。
 * 所以换掉任何一层实现都不需要改其他层。
 */

// ---- domain ----
export type {
  Deadline,
  DeadlineUnit,
} from './domain/deadline.ts';
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
export { SyncEngine, MANUAL_PLATFORM_ID, MANUAL_ACCOUNT_ID } from './engine/sync-engine.ts';
export type {
  SyncEngineDeps,
  SyncOptions,
  SyncReport,
  AccountSyncReport,
  ReminderSink,
} from './engine/sync-engine.ts';

export { mergeTasks, materializeTask, diffTask, DEFAULT_MERGE_OPTIONS } from './engine/merge.ts';
export { ADAPTER_PROMPT, ADAPTER_PITFALLS, buildEvidencePack, drillPack } from './engine/adapter-authoring.ts';
export { DeclarativeAdapter, DomAdapter, validateConfig, normalizeAdapterConfig, setDomExtractor, hasDomExtractor, getByPath, mapStatus } from './engine/declarative-adapter.ts';
export type { AdapterConfig } from './engine/declarative-adapter.ts';
export type { MergePlan, MergeOptions, TaskEvent } from './engine/merge.ts';

export { planReminders, DEFAULT_REMINDER_RULES } from './engine/reminder.ts';
export type { ReminderRule, PlannedReminder, PlanRemindersOptions } from './engine/reminder.ts';
export {
  buildNotificationSchedule,
  DEFAULT_REMIND_SPECS,
  MIN_GAP_HOURS,
  maxTimesFor,
  NOTIFY_LEVELS,
  NOTIFY_OFFSETS,
  NOTIFY_PRESETS,
  specToOffsets,
} from './engine/notify-schedule.ts';
export {
  NOTIFY_PREFS_KEY,
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_LEVEL_LABELS,
  normalizeNotifyPrefs,
  readNotifyPrefs,
  writeNotifyPrefs,
} from './engine/notify-prefs.ts';
export type { PrefsStorage } from './engine/notify-prefs.ts';
export type { NotifyLevel, NotifyPrefs } from './engine/notify-schedule.ts';
export type {
  ScheduledNotification,
  NotifyScheduleOptions,
  RemindSpec,
} from './engine/notify-schedule.ts';

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

// ---- infra ----
export { JsonFileStore, defaultStorePath } from './infra/json-store.ts';
export { MemoryStore } from './infra/memory-store.ts';
export type { MemoryStoreSnapshot } from './infra/memory-store.ts';
export { FetchHttpClient } from './infra/fetch-http.ts';
export type { FetchHttpOptions } from './infra/fetch-http.ts';
export { ConsoleLogger } from './infra/console-logger.ts';
export {
  EncryptedVault,
  EnvKeyProvider,
  FileKeyProvider,
  StaticKeyProvider,
  listVaultFiles,
} from './infra/encrypted-vault.ts';
export type { KeyProvider, EncryptedVaultOptions } from './infra/encrypted-vault.ts';
export { SubprocessSigner } from './infra/subprocess-signer.ts';
export type { SubprocessSignerOptions } from './infra/subprocess-signer.ts';
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
// 这些都实现为 HttpClient 的替身，所以任何适配器零改动就能换载体。
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
