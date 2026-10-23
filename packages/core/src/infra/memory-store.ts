import type { PlatformAccount, UnifiedCourse } from '../domain/course.ts';
import type { UnifiedTask } from '../domain/task.ts';
import type {
  HubStore,
  SentReminder,
  SyncCursor,
  SyncLogEntry,
  TaskFilter,
  UpsertResult,
} from '../ports/store.ts';

/** 内存存储的可序列化快照。版本号用于将来做迁移。 */
export interface MemoryStoreSnapshot {
  version: 1;
  accounts: PlatformAccount[];
  courses: UnifiedCourse[];
  tasks: UnifiedTask[];
  cursors: SyncCursor[];
  reminders: SentReminder[];
  syncLog: SyncLogEntry[];
}

/** 内存存储：单元测试、演练模式、以及浏览器端（无文件系统）用。 */
export class MemoryStore implements HubStore {
  #accounts = new Map<string, PlatformAccount>();
  #courses = new Map<string, UnifiedCourse>();
  #tasks = new Map<string, UnifiedTask>();
  #cursors = new Map<string, SyncCursor>();
  #reminders = new Map<string, SentReminder>();
  #syncLog: SyncLogEntry[] = [];

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  /**
   * 导出全量数据。
   *
   * 存在的意义不只是测试：浏览器端（Android WebView）没有文件系统，
   * 存储实现就是「MemoryStore + 定期把 snapshot 写进 localStorage」。
   * 与其再写一份 HubStore 实现，不如让内存实现支持序列化。
   */
  snapshot(): MemoryStoreSnapshot {
    return {
      version: 1,
      accounts: [...this.#accounts.values()],
      courses: [...this.#courses.values()],
      tasks: [...this.#tasks.values()],
      cursors: [...this.#cursors.values()],
      reminders: [...this.#reminders.values()],
      syncLog: this.#syncLog.slice(-500),
    };
  }

  /** 从 snapshot 恢复（会覆盖当前内容）。字段缺失时按空处理，兼容旧版本。 */
  restore(snap: MemoryStoreSnapshot | undefined): void {
    if (!snap) return;
    this.#accounts = new Map((snap.accounts ?? []).map((x) => [x.id, x]));
    this.#courses = new Map((snap.courses ?? []).map((x) => [x.id, x]));
    this.#tasks = new Map((snap.tasks ?? []).map((x) => [x.id, x]));
    this.#cursors = new Map((snap.cursors ?? []).map((x) => [`${x.accountId}|${x.kind}`, x]));
    this.#reminders = new Map((snap.reminders ?? []).map((x) => [x.key, x]));
    this.#syncLog = snap.syncLog ?? [];
  }

  static fromSnapshot(snap: MemoryStoreSnapshot | undefined): MemoryStore {
    const store = new MemoryStore();
    store.restore(snap);
    return store;
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.#accounts.values()];
  }

  async getAccount(id: string): Promise<PlatformAccount | undefined> {
    return this.#accounts.get(id);
  }

  async upsertAccount(account: PlatformAccount): Promise<void> {
    this.#accounts.set(account.id, account);
  }

  async removeAccount(id: string): Promise<void> {
    this.#accounts.delete(id);
    for (const [k, c] of this.#courses) if (c.accountId === id) this.#courses.delete(k);
    for (const [k, t] of this.#tasks) if (t.accountId === id) this.#tasks.delete(k);
    for (const [k, r] of this.#reminders) if (r.accountId === id) this.#reminders.delete(k);
    // 游标必须一起清掉。真机踩过：账号被移除后游标仍在，
    // 重新添加同一个账号时会「继承」旧的跳过清单（course-exclude /
    // course-crawl / full-diagnostics），表现为新账号莫名其妙跳过某些课。
    // 移除就是移除 —— 属于这个账号的一切状态都不该留下。
    for (const [k, c] of this.#cursors) if (c.accountId === id) this.#cursors.delete(k);
  }

  async listCourses(accountIds?: string[]): Promise<UnifiedCourse[]> {
    const all = [...this.#courses.values()];
    return accountIds ? all.filter((c) => accountIds.includes(c.accountId)) : all;
  }

  async upsertCourses(courses: UnifiedCourse[]): Promise<void> {
    for (const c of courses) {
      const prev = this.#courses.get(c.id);
      this.#courses.set(c.id, prev ? { ...prev, ...c } : c);
    }
  }

  async listTasks(filter?: TaskFilter): Promise<UnifiedTask[]> {
    let all = [...this.#tasks.values()];
    if (filter?.accountIds) all = all.filter((t) => filter.accountIds!.includes(t.accountId));
    if (filter?.platformIds) all = all.filter((t) => filter.platformIds!.includes(t.platformId));
    if (!filter?.includeDeleted) all = all.filter((t) => !t.deletedAt);
    return all;
  }

  async getTask(id: string): Promise<UnifiedTask | undefined> {
    return this.#tasks.get(id);
  }

  async upsertTasks(tasks: UnifiedTask[]): Promise<UpsertResult> {
    // ---- 指纹索引：只从「进入本批之前就存在的任务」构建 ----
    //
    // 为什么批次内的新任务不能加进来（真机踩过，这是「拉取 84 条但只显示几条」
    // 的根因）：同一批数据是「平台当前状态的快照」，里面的每一条都是**独立任务**。
    // 若允许批内互相认领，同一门课里标题归一化后相同的多条作业
    // （如「信安第三次作业(1)」与「信安第三次作业（王班）」——normalizeTitle
    // 会把结尾括号备注去掉，两者指纹相同）就会互相覆盖。
    // 实测：传入 5 条，最终只留下 2 条，且是被最后一条覆盖的内容。
    const byFp = new Map<string, string>();
    for (const t of this.#tasks.values()) {
      byFp.set(`${t.accountId}|${t.courseId}|${t.fingerprint}`, t.id);
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let merged = 0;

    for (const incoming of tasks) {
      // ① 平台给了稳定 id → 以 id 为准（id 是权威标识）
      let key = this.#tasks.has(incoming.id) ? incoming.id : undefined;

      // ② 指纹兜底：**只认领「原本就没有稳定 id」的任务**。
      //    id 里带 fp_ 说明上次是拿指纹当 id 用的，这次平台给了真 id
      //    （或仍然没给）—— 此时按指纹认领是安全的。
      //    反过来，两条各有真实 id、只是标题重名的作业绝不能被并成一条。
      if (!key) {
        const cand = byFp.get(`${incoming.accountId}|${incoming.courseId}|${incoming.fingerprint}`);
        if (cand && cand.includes(':fp_')) key = cand;
      }

      if (!key) {
        this.#tasks.set(incoming.id, incoming);
        created += 1;
        continue;
      }

      const prev = this.#tasks.get(key)!;
      this.#tasks.set(key, { ...incoming, id: key });
      if (key !== incoming.id) merged += 1;
      if (prev.revision === incoming.revision && prev.lastSeenAt === incoming.lastSeenAt) unchanged += 1;
      else updated += 1;
    }

    return { created, updated, unchanged, merged };
  }

  async softDeleteTasks(ids: string[], at: string): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const t = this.#tasks.get(id);
      if (!t || t.deletedAt) continue;
      this.#tasks.set(id, { ...t, deletedAt: at });
      n += 1;
    }
    return n;
  }

  async hardDeleteTasks(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) if (this.#tasks.delete(id)) n += 1;
    return n;
  }

  async getCursor(accountId: string, kind: string): Promise<SyncCursor | undefined> {
    return this.#cursors.get(`${accountId}|${kind}`);
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    this.#cursors.set(`${cursor.accountId}|${cursor.kind}`, cursor);
  }

  async hasReminder(key: string): Promise<boolean> {
    return this.#reminders.has(key);
  }

  async recordReminders(reminders: SentReminder[]): Promise<void> {
    for (const r of reminders) this.#reminders.set(r.key, r);
  }

  async listReminders(accountId?: string): Promise<SentReminder[]> {
    const all = [...this.#reminders.values()];
    return accountId ? all.filter((r) => r.accountId === accountId) : all;
  }

  async clearRemindersForTask(taskId: string): Promise<number> {
    let n = 0;
    for (const [k, r] of this.#reminders) {
      if (r.taskId === taskId) {
        this.#reminders.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    this.#syncLog.push(entry);
    // 只保留最近 N 条：日志含诊断文本，长期跑会无限增长，
    // 而持久层是「整个 store 序列化后落盘」—— 无限增长最终会拖慢写入、撑大存储。
    if (this.#syncLog.length > 200) {
      this.#syncLog.splice(0, this.#syncLog.length - 200);
    }
  }

  async listSyncLog(accountId?: string, limit = 20): Promise<SyncLogEntry[]> {
    const all = accountId ? this.#syncLog.filter((e) => e.accountId === accountId) : this.#syncLog;
    return all.slice(-limit).reverse();
  }
}
