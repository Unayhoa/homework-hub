/**
 * JSON 文件存储的参考实现。
 *
 * 选它作为默认实现而不是 SQLite，理由很实际：
 * 零依赖、可直接被任何宿主读取（Tauri/Electron/RN 都能读文件）、
 * 方便调试（出问题直接看 JSON）。
 *
 * 数据量评估：一个学生一学期大概 200~800 条任务，
 * 序列化后不到 1 MB。这个量级下「整文件读入内存 + 原子写回」完全够用。
 * 超过 ~1 万条再换 SQLite —— 那时只需实现同一个 HubStore 接口，引擎零改动。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

interface StateFile {
  version: 1;
  accounts: Record<string, PlatformAccount>;
  courses: Record<string, UnifiedCourse>;
  tasks: Record<string, UnifiedTask>;
  cursors: Record<string, SyncCursor>;
  reminders: Record<string, SentReminder>;
  syncLog: SyncLogEntry[];
}

const emptyState = (): StateFile => ({
  version: 1,
  accounts: {},
  courses: {},
  tasks: {},
  cursors: {},
  reminders: {},
  syncLog: [],
});

const MAX_SYNC_LOG = 200;

export class JsonFileStore implements HubStore {
  readonly #file: string;
  #state: StateFile = emptyState();
  #dirty = false;
  /** 串行化写入，防止并发同步多个账号时互相覆盖 */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#file = filePath;
  }

  get filePath(): string {
    return this.#file;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      this.#state = {
        ...emptyState(),
        ...parsed,
        version: 1,
        accounts: parsed.accounts ?? {},
        courses: parsed.courses ?? {},
        tasks: parsed.tasks ?? {},
        cursors: parsed.cursors ?? {},
        reminders: parsed.reminders ?? {},
        syncLog: parsed.syncLog ?? [],
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await this.#flush(true);
        return;
      }
      // 文件损坏时备份而不是直接丢弃，否则用户的历史记录就永久没了
      const backup = `${this.#file}.corrupt-${Date.now()}`;
      await rename(this.#file, backup).catch(() => {});
      this.#state = emptyState();
      await this.#flush(true);
      throw new Error(`状态文件解析失败，已备份到 ${backup}：${(e as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.#writeChain;
    if (this.#dirty) await this.#flush();
  }

  /** 原子写：先写临时文件再 rename。避免进程被 kill 时留下半截 JSON。 */
  async #flush(force = false): Promise<void> {
    if (!this.#dirty && !force) return;
    const payload = JSON.stringify(this.#state, null, 2);
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.#file);
    this.#dirty = false;
  }

  /** 排到写入链尾部，保证顺序性。 */
  #schedule(): Promise<void> {
    this.#dirty = true;
    this.#writeChain = this.#writeChain.then(() => this.#flush()).catch(() => {});
    return this.#writeChain;
  }

  // ---- 账号 ----
  async listAccounts(): Promise<PlatformAccount[]> {
    return Object.values(this.#state.accounts);
  }

  async getAccount(id: string): Promise<PlatformAccount | undefined> {
    return this.#state.accounts[id];
  }

  async upsertAccount(account: PlatformAccount): Promise<void> {
    this.#state.accounts[account.id] = account;
    await this.#schedule();
  }

  async removeAccount(id: string): Promise<void> {
    delete this.#state.accounts[id];
    for (const [k, c] of Object.entries(this.#state.courses)) {
      if (c.accountId === id) delete this.#state.courses[k];
    }
    for (const [k, t] of Object.entries(this.#state.tasks)) {
      if (t.accountId === id) delete this.#state.tasks[k];
    }
    for (const [k, r] of Object.entries(this.#state.reminders)) {
      if (r.accountId === id) delete this.#state.reminders[k];
    }
    // 游标一起清掉：账号被移除后若残留游标，重新添加同一账号时会
    // 「继承」旧的跳过清单（course-exclude / course-crawl），
    // 表现为新账号莫名其妙跳过某些课。（与 MemoryStore 保持一致）
    for (const [k, c] of Object.entries(this.#state.cursors)) {
      if (c.accountId === id) delete this.#state.cursors[k];
    }
    await this.#schedule();
  }

  // ---- 课程 ----
  async listCourses(accountIds?: string[]): Promise<UnifiedCourse[]> {
    const all = Object.values(this.#state.courses);
    return accountIds ? all.filter((c) => accountIds.includes(c.accountId)) : all;
  }

  async upsertCourses(courses: UnifiedCourse[]): Promise<void> {
    for (const c of courses) {
      const prev = this.#state.courses[c.id];
      this.#state.courses[c.id] = prev ? { ...prev, ...c } : c;
    }
    await this.#schedule();
  }

  async deleteCourses(ids: string[]): Promise<void> {
    for (const id of ids) delete this.#state.courses[id];
    await this.#schedule();
  }

  // ---- 任务 ----
  async listTasks(filter?: TaskFilter): Promise<UnifiedTask[]> {
    let all = Object.values(this.#state.tasks);
    if (filter?.accountIds) all = all.filter((t) => filter.accountIds!.includes(t.accountId));
    if (filter?.platformIds) all = all.filter((t) => filter.platformIds!.includes(t.platformId));
    if (!filter?.includeDeleted) all = all.filter((t) => !t.deletedAt);
    return all;
  }

  async getTask(id: string): Promise<UnifiedTask | undefined> {
    return this.#state.tasks[id];
  }

  /**
   * 幂等写入。
   * 同时按 id 与 fingerprint 建索引：id 匹配不到时用 fingerprint 兜底，
   * 这样即使平台换了 ID，本地也不会多出一条重复任务。
   */
  async upsertTasks(tasks: UnifiedTask[]): Promise<UpsertResult> {
    // 指纹索引只从「进入本批之前就存在的任务」构建 —— 批次内的新任务不加入，
    // 否则同一门课里标题归一化后相同的多条作业会互相覆盖。
    // （与 MemoryStore 保持完全一致；详见那边的注释与真机复现）
    const byFingerprint = new Map<string, string>();
    for (const t of Object.values(this.#state.tasks)) {
      byFingerprint.set(`${t.accountId}|${t.courseId}|${t.fingerprint}`, t.id);
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let merged = 0;

    for (const incoming of tasks) {
      // ① id 是权威标识
      let existingId = this.#state.tasks[incoming.id] ? incoming.id : undefined;

      // ② 指纹兜底：只认领「原本就没有稳定 id」的任务（id 形如 ...:fp_xxx）
      if (!existingId) {
        const cand = byFingerprint.get(`${incoming.accountId}|${incoming.courseId}|${incoming.fingerprint}`);
        if (cand && cand.includes(':fp_')) existingId = cand;
      }

      if (!existingId) {
        this.#state.tasks[incoming.id] = incoming;
        created += 1;
        continue;
      }

      const prev = this.#state.tasks[existingId];
      if (!prev) {
        this.#state.tasks[incoming.id] = incoming;
        created += 1;
        continue;
      }

      // 主键保持稳定：即使 incoming.id 不同，也写到已有记录的键上
      this.#state.tasks[existingId] = { ...incoming, id: existingId };
      if (existingId !== incoming.id) merged += 1;
      if (prev.revision === incoming.revision && prev.lastSeenAt === incoming.lastSeenAt) unchanged += 1;
      else updated += 1;
    }

    await this.#schedule();
    return { created, updated, unchanged, merged };
  }

  async softDeleteTasks(ids: string[], at: string): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const t = this.#state.tasks[id];
      if (!t || t.deletedAt) continue;
      this.#state.tasks[id] = { ...t, deletedAt: at };
      n += 1;
    }
    if (n > 0) await this.#schedule();
    return n;
  }

  async hardDeleteTasks(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (this.#state.tasks[id]) {
        delete this.#state.tasks[id];
        n += 1;
      }
    }
    if (n > 0) await this.#schedule();
    return n;
  }

  // ---- 游标 ----
  async getCursor(accountId: string, kind: string): Promise<SyncCursor | undefined> {
    return this.#state.cursors[`${accountId}|${kind}`];
  }

  async setCursor(cursor: SyncCursor): Promise<void> {
    this.#state.cursors[`${cursor.accountId}|${cursor.kind}`] = cursor;
    await this.#schedule();
  }

  // ---- 提醒 ----
  async hasReminder(key: string): Promise<boolean> {
    return key in this.#state.reminders;
  }

  async recordReminders(reminders: SentReminder[]): Promise<void> {
    if (reminders.length === 0) return;
    for (const r of reminders) this.#state.reminders[r.key] = r;
    await this.#schedule();
  }

  async listReminders(accountId?: string): Promise<SentReminder[]> {
    const all = Object.values(this.#state.reminders);
    return accountId ? all.filter((r) => r.accountId === accountId) : all;
  }

  async clearRemindersForTask(taskId: string): Promise<number> {
    let n = 0;
    for (const [k, r] of Object.entries(this.#state.reminders)) {
      if (r.taskId === taskId) {
        delete this.#state.reminders[k];
        n += 1;
      }
    }
    if (n > 0) await this.#schedule();
    return n;
  }

  // ---- 同步日志 ----
  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    this.#state.syncLog.push(entry);
    if (this.#state.syncLog.length > MAX_SYNC_LOG) {
      this.#state.syncLog = this.#state.syncLog.slice(-MAX_SYNC_LOG);
    }
    await this.#schedule();
  }

  async listSyncLog(accountId?: string, limit = 20): Promise<SyncLogEntry[]> {
    const all = accountId ? this.#state.syncLog.filter((e) => e.accountId === accountId) : this.#state.syncLog;
    return all.slice(-limit).reverse();
  }
}

/** 便捷工厂：默认落在用户目录下的 .homework-hub/state.json */
export function defaultStorePath(homeDir: string): string {
  return join(homeDir, '.homework-hub', 'state.json');
}
