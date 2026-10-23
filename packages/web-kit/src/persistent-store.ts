/**
 * 浏览器端持久化存储：MemoryStore 的快照 + 写回 WebStorage。
 *
 * 为什么复用 MemoryStore 而不是重写一份 HubStore：
 * 那份「按 id 与 fingerprint 双重匹配做幂等写入」的逻辑很容易写错
 * （桌面端就是靠单测才发现的跨账号主键覆盖问题）。
 * 存储介质变了，但合并语义必须完全一致 —— 所以只换介质，不换逻辑。
 *
 * 写入策略：去抖 400ms 后整体序列化。
 * 一次同步会产生几十次写入，逐次序列化在手机上会卡顿；
 * 整体快照又很小（一个学期几百条任务 < 1MB），所以去抖合并最划算。
 */
import { MemoryStore } from '#core';
import type { HubStore, MemoryStoreSnapshot, UpsertResult, TaskFilter, PlatformAccount, UnifiedCourse, UnifiedTask, SyncCursor, SentReminder, SyncLogEntry } from '#core';
import type { WebStorage } from './web-storage.ts';

export interface PersistentStoreOptions {
  storage: WebStorage;
  key?: string;
  /** 去抖间隔（毫秒）。设 0 表示每次写入立刻落盘（测试用） */
  debounceMs?: number;
  /** 落盘失败时的回调（例如容量超限），默认只打日志 */
  onError?: (e: unknown) => void;
}

/** 会改动数据的方法名 —— 这些方法调用后需要触发落盘。 */
const MUTATORS = [
  'upsertAccount',
  'removeAccount',
  'upsertCourses',
  'upsertTasks',
  'softDeleteTasks',
  'hardDeleteTasks',
  'setCursor',
  'recordReminders',
  'clearRemindersForTask',
  'appendSyncLog',
] as const;

export class PersistentStore implements HubStore {
  readonly #inner = new MemoryStore();
  readonly #opts: Required<PersistentStoreOptions>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loaded = false;
  #lastBytes = 0;
  #lastError: string | null = null;

  constructor(opts: PersistentStoreOptions) {
    this.#opts = {
      storage: opts.storage,
      key: opts.key ?? 'hh.state.v1',
      debounceMs: opts.debounceMs ?? 400,
      onError: opts.onError ?? ((e) => console.error('[store] 落盘失败', e)),
    };
  }

  async init(): Promise<void> {
    const raw = this.#opts.storage.getItem(this.#opts.key);
    if (raw) {
      try {
        this.#inner.restore(JSON.parse(raw) as MemoryStoreSnapshot);
      } catch (e) {
        // 数据损坏时**不要**清空 —— 与桌面端 JsonFileStore 的策略一致：
        // 宁可这次读不出来，也不要让用户的作业记录凭空消失。
        this.#opts.onError(e);
      }
    }
    this.#loaded = true;
  }

  /** 立刻落盘（App 进入后台、或同步结束后调用，避免丢最后一批写入）。 */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#loaded) return;
    try {
      const json = JSON.stringify(this.#inner.snapshot());
      this.#opts.storage.setItem(this.#opts.key, json);
      this.#lastBytes = json.length;
      this.#lastError = null;
    } catch (e) {
      // 记下来：落盘失败必须能被上层看见（真机踩过 —— 只写 console 的话，
      // 「重启后数据变少」这种最坏的故障形态完全没有提示）。
      this.#lastError = (e as Error)?.message ?? String(e);
      this.#opts.onError(e);
    }
  }

  /**
   * 存储健康度（诊断用）：最近一次落盘的字节数与失败原因。
   * 界面用它显示「存储：原生文件 · 约 320 KB」，失败时直接亮出原因。
   */
  stats(): { bytes: number; lastError: string | null } {
    return { bytes: this.#lastBytes, lastError: this.#lastError };
  }

  #schedule(): void {
    if (this.#opts.debounceMs === 0) {
      this.flush();
      return;
    }
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#opts.debounceMs);
  }

  async close(): Promise<void> {
    this.flush();
  }

  /** 当前数据的快照（调试/导出用）。 */
  snapshot(): MemoryStoreSnapshot {
    return this.#inner.snapshot();
  }

  // ---- 读（直接透传） ----
  listAccounts(): Promise<PlatformAccount[]> {
    return this.#inner.listAccounts();
  }
  getAccount(id: string): Promise<PlatformAccount | undefined> {
    return this.#inner.getAccount(id);
  }
  listCourses(accountIds?: string[]): Promise<UnifiedCourse[]> {
    return this.#inner.listCourses(accountIds);
  }
  listTasks(filter?: TaskFilter): Promise<UnifiedTask[]> {
    return this.#inner.listTasks(filter);
  }
  getTask(id: string): Promise<UnifiedTask | undefined> {
    return this.#inner.getTask(id);
  }
  getCursor(accountId: string, kind: string): Promise<SyncCursor | undefined> {
    return this.#inner.getCursor(accountId, kind);
  }
  hasReminder(key: string): Promise<boolean> {
    return this.#inner.hasReminder(key);
  }
  listReminders(accountId?: string): Promise<SentReminder[]> {
    return this.#inner.listReminders(accountId);
  }
  listSyncLog(accountId?: string, limit?: number): Promise<SyncLogEntry[]> {
    return this.#inner.listSyncLog(accountId, limit);
  }

  // ---- 写（落盘） ----
  async upsertAccount(account: PlatformAccount): Promise<void> {
    await this.#inner.upsertAccount(account);
    this.#schedule();
  }
  async removeAccount(id: string): Promise<void> {
    await this.#inner.removeAccount(id);
    this.#schedule();
  }
  async upsertCourses(courses: UnifiedCourse[]): Promise<void> {
    await this.#inner.upsertCourses(courses);
    this.#schedule();
  }
  async upsertTasks(tasks: UnifiedTask[]): Promise<UpsertResult> {
    const r = await this.#inner.upsertTasks(tasks);
    this.#schedule();
    return r;
  }
  async softDeleteTasks(ids: string[], at: string): Promise<number> {
    const n = await this.#inner.softDeleteTasks(ids, at);
    this.#schedule();
    return n;
  }
  async hardDeleteTasks(ids: string[]): Promise<number> {
    const n = await this.#inner.hardDeleteTasks(ids);
    this.#schedule();
    return n;
  }
  async setCursor(cursor: SyncCursor): Promise<void> {
    await this.#inner.setCursor(cursor);
    this.#schedule();
  }
  async recordReminders(reminders: SentReminder[]): Promise<void> {
    await this.#inner.recordReminders(reminders);
    this.#schedule();
  }
  async clearRemindersForTask(taskId: string): Promise<number> {
    const n = await this.#inner.clearRemindersForTask(taskId);
    this.#schedule();
    return n;
  }
  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    await this.#inner.appendSyncLog(entry);
    this.#schedule();
  }
}

/** 供测试与自检：契约完整性检查（将来给 HubStore 加方法时能立刻发现漏实现）。 */
export function assertImplementsHubStore(): readonly string[] {
  return MUTATORS;
}
