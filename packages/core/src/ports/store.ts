/**
 * 存储端口。
 *
 * 接口是按「一次同步的写入形态」设计的（批量 upsert），而不是 CRUD。
 * 原因：一次同步可能拿到几百条任务，逐条 upsert 在 JSON 实现下是 O(n²)，
 * 在 SQLite 下也会白跑几百次事务。
 *
 * JsonFileStore 是参考实现（单文件、原子写）。
 * 真上生产换 SQLite，只要实现这个接口，engine 一行都不用改。
 */
import type { PlatformAccount, UnifiedCourse } from '../domain/course.ts';
import type { UnifiedTask } from '../domain/task.ts';

export interface SyncCursor {
  accountId: string;
  /** 数据种类：tasks / courses / exams */
  kind: string;
  cursor: string;
  updatedAt: string;
}

export interface SentReminder {
  key: string;
  taskId: string;
  ruleId: string;
  accountId: string;
  sentAt: string;
  /** 发送时任务的关键快照，任务变更时用来判断是否需要重发 */
  revision: number;
  channel: string;
  title: string;
}

export interface SyncLogEntry {
  accountId: string;
  platformId: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'partial' | 'failed' | 'auth-required' | 'skipped';
  created: number;
  updated: number;
  removed: number;
  fetched: number;
  message?: string;
  /** 本轮发出的平台请求数 —— 判断「慢」是请求多还是单请求慢的唯一依据 */
  requests?: number;
  /** 重试次数（429/5xx/网络抖动） */
  retries?: number;
  /** 本轮总耗时 ms */
  durationMs?: number;
}

export interface TaskFilter {
  accountIds?: string[];
  platformIds?: string[];
  includeDeleted?: boolean;
}

export interface UpsertResult {
  created: number;
  updated: number;
  /** 内容无变化、被跳过的数量（用于验证幂等性） */
  unchanged: number;
  /**
   * 被「指纹认领」的数量：平台没给稳定 id 时，按标题指纹认领到已有任务
   * （而不是新建）。健康值是 0 或很小；如果它接近拉取量，
   * 说明标题指纹在大量撞车 —— 那意味着**多条不同的作业被并成了一条**。
   */
  merged?: number;
}

export interface HubStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // ---- 账号 ----
  listAccounts(): Promise<PlatformAccount[]>;
  getAccount(id: string): Promise<PlatformAccount | undefined>;
  upsertAccount(account: PlatformAccount): Promise<void>;
  removeAccount(id: string): Promise<void>;

  /**
   * 立即落盘（可选能力）。
   *
   * 有的实现是「去抖后整体序列化」（浏览器端 PersistentStore 去抖 400ms），
   * 常规写入靠去抖没问题；但**破坏性操作**（移除账号）不能等 ——
   * 用户点完移除往往立刻退出 App，400ms 的窗口里可能把结果丢掉。
   * 实现方按自己的介质决定要不要提供；调用方用 `store.flush?.()`。
   */
  flush?(): void;

  // ---- 课程 ----
  listCourses(accountIds?: string[]): Promise<UnifiedCourse[]>;
  upsertCourses(courses: UnifiedCourse[]): Promise<void>;
  /**
   * 删掉若干课程记录（连同它们的行，不删任务）。
   *
   * 只给「课程残留」用：平台不再报告、也没有任何任务引用它 ——
   * 它是历史误解留下的空壳（比如曾把课程内容误认成 4 门课）。
   * 有任务引用的课程**永远不该删**：那会让任务变成孤儿。
   */
  deleteCourses(ids: string[]): Promise<void>;

  // ---- 任务 ----
  listTasks(filter?: TaskFilter): Promise<UnifiedTask[]>;
  getTask(id: string): Promise<UnifiedTask | undefined>;
  /** 按 id 与 fingerprint 双重匹配做幂等写入 */
  upsertTasks(tasks: UnifiedTask[]): Promise<UpsertResult>;
  softDeleteTasks(ids: string[], at: string): Promise<number>;
  hardDeleteTasks(ids: string[]): Promise<number>;

  // ---- 游标 ----
  getCursor(accountId: string, kind: string): Promise<SyncCursor | undefined>;
  setCursor(cursor: SyncCursor): Promise<void>;

  // ---- 提醒去重 ----
  hasReminder(key: string): Promise<boolean>;
  /** 批量写入。按 key 去重，重复 key 覆盖而不是追加 —— 否则文件会无限膨胀。 */
  recordReminders(reminders: SentReminder[]): Promise<void>;
  listReminders(accountId?: string): Promise<SentReminder[]>;
  /** 任务被删除时清理其提醒记录，避免 key 池无限增长 */
  clearRemindersForTask(taskId: string): Promise<number>;

  // ---- 同步日志 ----
  appendSyncLog(entry: SyncLogEntry): Promise<void>;
  listSyncLog(accountId?: string, limit?: number): Promise<SyncLogEntry[]>;
}
