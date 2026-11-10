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
    // 【关键】持久化时把 `raw` 收窄成运行时真正需要的几个小字段。
    //
    // `raw` 原本是平台原始响应对象（共享课整条 courseOpenDtos、考试/作业原始行…），
    // 体积远大于其余字段之和，运行时却只用到极少数键（如智慧树的 recruitId/secret，
    // 用来判定"这是共享课"并拼学习页地址）。
    // 真机踩过（2026-11-09）：智慧树接入后 raw 让整个 snapshot 逼近 V8 单字符串上限，
    // `JSON.stringify` 在**落盘这一步**抛 `Invalid string length`，
    // 表现为「同步请求 0 次就失败」，日志看不出任何原因。
    // 【白名单】必须包含各适配器在**后续请求**里真正要用的字段。
    //
    // 这里踩过一个很隐蔽的坑（真机 2026-11-10）：白名单原本只有
    // recruitId/secret/courseId/homepage，把超星的 classId/cpi/enc 也一并丢了。
    // 后果不是"报错"，而是重启 App 后从 snapshot 恢复 → 课程缺 classId →
    // 作业列表请求发不出 classId → 平台回「提示 无效的用户！」+ 1148 字节空页 →
    // 表现为「15 门课全部 0 条」。**同步当场是好的，重启后才坏** ——
    // 因为内存里 raw 是完整的，只有落盘这一趟被裁剪。
    //
    // 判据：字段小、且「丢了以后请求就发不对」的，必须留。
    //   · 超星：classId / cpi / enc（作业与考试列表、任务点全依赖）
    //   · 智慧树：recruitId / secret（判定共享课、拼学习页）
    //   · 通用：courseId / homepage
    const RAW_KEEP = [
      'recruitId',
      'secret',
      'courseId',
      'homepage',
      'classId',
      'cpi',
      'enc',
      'squareUrl',
    ] as const;
    const slimRaw = (raw: unknown): unknown => {
      if (!raw || typeof raw !== 'object') return undefined;
      const out: Record<string, unknown> = {};
      for (const k of RAW_KEEP) {
        const v = (raw as Record<string, unknown>)[k];
        if (v !== undefined) out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const slim = <T extends { raw?: unknown }>(x: T): T => {
      if (!x || typeof x !== 'object') return x;
      const kept = slimRaw(x.raw);
      if (kept === undefined) {
        const { raw: _omit, ...rest } = x as T & { raw?: unknown };
        return rest as T;
      }
      return { ...x, raw: kept };
    };
    // 游标也可能是被污染的巨型字符串（真机 2026-11-09：旧版本把超大内容写进了
    // course-crawl 游标，导致后续 JSON.stringify(crawlMap) 抛 Invalid string length）。
    // 这里对游标值做长度上限，超限的直接丢弃 —— 游标丢了最坏只是多爬一轮，无副作用。
    const CURSOR_MAX = 8192;
    const safeCursor = (c: { cursor?: string }): { cursor: string } | { cursor: undefined } => {
      const v = c.cursor;
      if (typeof v === 'string' && v.length > CURSOR_MAX) return { cursor: undefined };
      return { cursor: v };
    };
    return {
      version: 1,
      accounts: [...this.#accounts.values()],
      courses: [...this.#courses.values()].map(slim),
      tasks: [...this.#tasks.values()].map(slim),
      cursors: [...this.#cursors.values()]
        .map((c) => ({ ...c, ...safeCursor(c) }))
        .filter((c) => c.cursor !== undefined) as MemoryStoreSnapshot['cursors'],
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

  async deleteCourses(ids: string[]): Promise<void> {
    for (const id of ids) this.#courses.delete(id);
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
