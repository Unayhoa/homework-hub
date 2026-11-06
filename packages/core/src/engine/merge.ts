/**
 * 幂等合并引擎。
 *
 * 这是「多平台聚合」真正的技术核心，也是最容易写错的地方。
 * 目标：同一个平台任务在 N 次同步后，本地永远只有 1 条记录、revision 只在
 * 内容真变化时递增、老师改截止时间表现为「变更」而不是「新建 + 消失」。
 *
 * 三个坑，逐个说：
 *
 * 坑 1｜主键不稳定。
 *   有的平台 platformTaskId 每次都变。对策：id 匹配失败时回退到 fingerprint 匹配。
 *   注意 fingerprint 必须带上 courseId —— 不同课程下同名作业（比如「第三章作业」）
 *   是常态，不带 courseId 会把两个班的作业合并成一条。
 *
 * 坑 2｜上游抖动被误判成删除。
 *   分页请求失败、临时风控、接口超时，都会让某一轮同步「少看到」一些任务。
 *   如果立刻删库，用户就会看到作业一闪一闪。对策：absentCount 计数，
 *   连续 N 轮（默认 2）缺席才软删除，且只软删除不硬删。
 *
 * 坑 3｜无意义变更刷屏。
 *   平台每次返回的时间戳精度不同（有的到秒、有的到毫秒），直接比较会把
 *   每一轮同步都判定成「截止时间变了」。对策：比较前先归一化到分钟精度。
 */
import type { ChangeField, PlatformTask, TaskChange, TaskSubtask, UnifiedTask } from '../domain/task.ts';
import { normalizeTitle, makeFingerprint, makeTaskId, makeCourseId } from '../domain/ids.ts';
import { deadlineInstant, deadlineKey, normalizeDeadline } from '../domain/deadline.ts';
import type { Deadline, DeadlineUnit } from '../domain/deadline.ts';

/** 时间比较精度：1 分钟。低于这个粒度的差异视为噪音。 */
const TIME_GRAIN_MS = 60_000;

/**
 * 「反复变动」的判据：同一字段在 24 小时内变了 3 次以上。
 *
 * 真机（2026-11-01）：用户连续同步三次，三次都提示「有作业信息更新」，
 * 而每次指的还是不同的作业，他什么都没做。根源是页面渲染不稳定 ——
 * 某轮给了 10/22、某轮给了 11/5，两个都是"有效值"，任何"缺失不覆盖"的规则都拦不住。
 *
 * 真实场景里老师不会一天内改三次截止时间。所以超过这个频率就不是"平台说变了"，
 * 而是"我们每次看到的不一样"。此时**不再写变更历史**（值仍然照实更新）：
 * 噪音的代价是真改期被淹没 —— 那才是这个页面唯一的价值。
 */
const FLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLAP_LIMIT = 3;

function grainIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  return new Date(Math.round(t / TIME_GRAIN_MS) * TIME_GRAIN_MS).toISOString();
}

/** 把适配器产出的「半成品」任务补齐为完整的 UnifiedTask。 */
export function materializeTask(input: {
  platformId: string;
  accountId: string;
  platformTask: PlatformTask;
  now: Date;
  courseNameFallback?: string;
}): UnifiedTask {
  const { platformId, accountId, platformTask, now } = input;
  const at = now.toISOString();

  // 统一课程 ID 带平台 + 账号前缀，跨账号不会撞车
  const courseId = makeCourseId(platformId, accountId, platformTask.courseId);

  const fingerprint = makeFingerprint({
    platformId,
    courseId,
    kind: platformTask.kind,
    title: platformTask.title,
  });

  // 平台没给 ID 就用指纹兜底 —— 仍然是稳定的。
  const platformTaskId = platformTask.platformTaskId?.trim() || `fp_${fingerprint}`;

  // 发布时间也走同一套归一化，但只取绝对时刻；相对时长对「发布时间」没意义。
  const published = normalizeDeadline(platformTask.publishedAt, now);
  const deadline = normalizeDeadline(platformTask.deadline, now);

  return {
    id: makeTaskId(platformId, accountId, platformTaskId),
    platformId,
    platformTaskId,
    accountId,
    courseId,
    courseName: platformTask.courseName ?? input.courseNameFallback ?? '未知课程',
    kind: platformTask.kind,
    title: platformTask.title.trim(),
    status: platformTask.status ?? 'unknown',
    statusSource: platformTask.statusSource ?? 'platform',
    ...(platformTask.statusRaw ? { statusRaw: platformTask.statusRaw } : {}),
    deadline,
    // 锚点只对相对型截止时间有意义：把「还剩 3 天」钉死在首次观测的时刻上。
    // 绝对型截止时间自己就是准的，不需要也不应该记锚点。
    deadlineAt: deadline.kind === 'relative' ? deadlineInstant(deadline, now)?.toISOString() : undefined,
    ...(platformTask.startsAt ? { startsAt: platformTask.startsAt } : {}),
    publishedAt: published.kind === 'absolute' ? published.at : undefined,
    score: platformTask.score,
    totalScore: platformTask.totalScore,
    // 进度是三样可选信息：没给就不写这个键（而不是写 undefined），
    // 这样老任务/老平台的对象形状完全不变。
    ...(platformTask.progress ? { progress: platformTask.progress } : {}),
    ...(platformTask.subtasks ? { subtasks: platformTask.subtasks } : {}),
    sourceUrl: platformTask.sourceUrl,
    fingerprint,
    revision: 1,
    history: [],
    firstSeenAt: at,
    lastSeenAt: at,
    absentCount: 0,
    raw: platformTask.raw,
  };
}

const UNIT_MS: Record<DeadlineUnit, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

function relativeMs(d: Deadline): number {
  return d.kind === 'relative' ? d.value * UNIT_MS[d.unit] : Number.POSITIVE_INFINITY;
}

/** 判断两个字段值是否「实质相同」（含时间粒度和标题归一化）。 */
function sameValue(field: ChangeField, a: unknown, b: unknown): boolean {
  if (field === 'deadline') {
    const da = a as Deadline;
    const db = b as Deadline;
    if (da.kind !== db.kind) return false;
    if (da.kind === 'absolute' && db.kind === 'absolute') return grainIso(da.at) === grainIso(db.at);
    if (da.kind === 'relative' && db.kind === 'relative') {
      if (da.value === db.value && da.unit === db.unit) return true;
      // 关键规则：平台只给倒计时时，剩余量「变小」只是时间自然流逝，
      // 不是老师改期。只有剩余量变大（真正的延后）才算变更。
      // 不这样做的话，每天同步一次就会产生一次假的「截止时间已变更」。
      return relativeMs(db) <= relativeMs(da);
    }
    return deadlineKey(da) === deadlineKey(db);
  }
  if (field === 'title') {
    return (a as string) === (b as string) || normalizeTitle(String(a)) === normalizeTitle(String(b));
  }
  if (field === 'score') {
    const na = a === undefined || a === null ? null : Number(a);
    const nb = b === undefined || b === null ? null : Number(b);
    return na === nb;
  }
  return a === b;
}

/**
 * 决定新记录该用哪个截止时间与锚点。
 *
 * 相对型截止时间在「剩余量变小」时必须沿用原有锚点：
 * 平台的「还剩 3 天」每天都会重算，如果我们跟着重新锚定，
 * 这个作业会永远停在「还剩 3 天」，既不会逾期也不会触发提醒。
 */
function resolveDeadline(
  prev: UnifiedTask,
  next: UnifiedTask,
): { deadline: Deadline; deadlineAt: string | undefined } {
  if (next.deadline.kind === 'absolute') {
    // 绝对型截止时间以自己为准，顺带清掉可能残留的陈旧锚点
    return { deadline: next.deadline, deadlineAt: undefined };
  }

  const decaying =
    prev.deadline.kind === 'relative' &&
    next.deadline.kind === 'relative' &&
    relativeMs(next.deadline) <= relativeMs(prev.deadline);

  if (decaying) return { deadline: prev.deadline, deadlineAt: prev.deadlineAt };

  return { deadline: next.deadline, deadlineAt: next.deadlineAt ?? prev.deadlineAt };
}

function present(field: ChangeField, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (field === 'deadline') return deadlineKey(v as Deadline);
  return String(v);
}

/**
 * 截止时间的「实质变化」下限。
 *
 * 平台返回的截止时间戳会带秒级零头，两次同步可能给出
 * `2026-10-09T15:59:32.200Z` 与 `2026-10-09T15:59:08.786Z` ——
 * 对用户来说这是同一时刻（都是 10/9 23:59），
 * 但按字符串比较就是「截止时间变了」，于是推给用户一条毫无意义的提醒。
 *
 * 这类噪音的真正代价不是难看：**它会训练用户忽略变更提醒**，
 * 等哪天老师真的改了截止时间，用户也会当成噪音划过去。
 *
 * 5 分钟足以滤掉抖动；真实的改期通常以小时或天计，不会被误滤。
 */
const DEADLINE_CHANGE_MIN_MS = 5 * 60 * 1000;

/** 两个截止时间是否算「实质变化」（绝对时间按差值判断，带容差）。 */
export function deadlineChangedEnough(prev: Deadline, next: Deadline): boolean {
  if (prev.kind === 'absolute' && next.kind === 'absolute') {
    const a = new Date(prev.at).getTime();
    const b = new Date(next.at).getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(b - a) >= DEADLINE_CHANGE_MIN_MS;
    }
  }
  return deadlineKey(prev) !== deadlineKey(next);
}

/**
 * 「只补缺、不覆盖」的字段回填。
 *
 * 加字段的前提：它**不是平台内容**（不来自上游、不体现"老师改了什么"），
 * 只是本地对数据的补充说明。这类字段可以在老记录上被静默补上。
 *
 * 为什么需要这个机制：下面幂等分支刻意不写库（防无意义刷盘），
 * 于是**新字段永远到不了老记录** —— 这是"加字段"这类改动必然踩的坑。
 *
 * 现在里面有两个：
 *   statusSource —— 平台报的状态还是我们推断的（0.1.58 加的）
 *   sourceUrl    —— 适配器用「平台 ID」拼出来的跳转地址（0.1.78 加的）
 *                 漏了它 → 老任务内容没变、走幂等分支、永远拿不到深链，
 *                 表现是"只有新同步到的作业能点，旧的点了没反应"。
 *
 * 刻意写成显式赋值而不是遍历一个常量数组：两个字段类型不同
 * （一个是枚举、一个是字符串），泛型写入会逼出 `as never` 这种假类型安全。
 * 加新字段就在下面加一行。
 */
function backfillPatch(prev: UnifiedTask, next: UnifiedTask): Partial<UnifiedTask> {
  const patch: Partial<UnifiedTask> = {};
  if (prev.statusSource === undefined && next.statusSource !== undefined) {
    patch.statusSource = next.statusSource;
  }
  // sourceUrl 特殊：**值变了就跟着更新**，而不是只补缺。
  // 理由：它是我们按平台规则**生成**的地址，不是平台内容 —— 生成逻辑一改（比如补上必需的 enc），
  // 老记录里那个旧地址就成了死链。只补缺的话，老任务永远停在 404 上。
  // 更新它不算『变更』：不动 revision、不记 history（老师那边什么都没做）。
  if (next.sourceUrl && prev.sourceUrl !== next.sourceUrl) patch.sourceUrl = next.sourceUrl;
  return patch;
}

/**
 * 进度 / 每题摘要是否变了。
 *
 * 它们与 `diffTask` 比的那六个字段（标题、截止、状态…）性质不同：
 * 那六个是**平台内容**（老师改了什么），进度是**我做到哪了**。
 * 所以进度变化要落库，但不能产生变更事件、不能动 revision ——
 * 否则你每 AC 一道题，变更历史里就多一条「有更新」，而老师那边什么都没做，
 * 真正值钱的改期记录会被这些噪音淹掉。
 */
function sameProgress(a: UnifiedTask, b: UnifiedTask): boolean {
  const pa = a.progress;
  const pb = b.progress;
  if (!pa || !pb) return !pa && !pb;
  if (pa.submitted !== pb.submitted || pa.accepted !== pb.accepted || pa.total !== pb.total) return false;
  const x = a.subtasks ?? [];
  const y = b.subtasks ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i]!.label !== y[i]!.label || x[i]!.score !== y[i]!.score || x[i]!.status !== y[i]!.status) {
      return false;
    }
  }
  return true;
}

/** 对比新旧记录，产出变更列表。 */
export function diffTask(prev: UnifiedTask, next: UnifiedTask): TaskChange[] {
  const fields: ChangeField[] = ['title', 'deadline', 'status', 'score', 'course', 'kind'];
  const changes: TaskChange[] = [];
  const nowIso = next.lastSeenAt;

  for (const field of fields) {
    // 这个字段最近是不是已经在抖了？抖动的定义见 FLAP_WINDOW_MS。
    // 放在最前面：抖动期间任何值差异都不写历史（但 mergeTasks 仍会用新值落库）。
    const nowMs = new Date(nowIso).getTime();
    const recentSameField = (prev.history ?? []).filter(
      (h) =>
        h.field === field &&
        Number.isFinite(new Date(h.at).getTime()) &&
        nowMs - new Date(h.at).getTime() < FLAP_WINDOW_MS,
    ).length;
    if (recentSameField >= FLAP_LIMIT) continue;

    const a = field === 'course' ? { id: prev.courseId, name: prev.courseName } : (prev as never)[field];
    const b = field === 'course' ? { id: next.courseId, name: next.courseName } : (next as never)[field];
    if (field === 'course') {
      const key = (x: { id: string; name: string }) => `${x.id}|${x.name}`;
      if (key(a as { id: string; name: string }) !== key(b as { id: string; name: string })) {
        changes.push({ field, from: key(a as { id: string; name: string }), to: key(b as { id: string; name: string }), at: nowIso });
      }
      continue;
    }
    if (field === 'deadline') {
      // 秒级零头不算改期（见 DEADLINE_CHANGE_MIN_MS）——
      // 平台每次返回的时间戳可能差几秒，那不是老师改了截止时间。
      if (!deadlineChangedEnough(prev.deadline, next.deadline)) continue;
      changes.push({
        field,
        from: present(field, prev.deadline),
        to: present(field, next.deadline),
        at: nowIso,
      });
      continue;
    }
    if (!sameValue(field, a, b)) {
      changes.push({ field, from: present(field, a), to: present(field, b), at: nowIso });
    }
  }

  return changes;
}

export type TaskEvent =
  | { type: 'created'; task: UnifiedTask }
  | { type: 'updated'; task: UnifiedTask; changes: TaskChange[] }
  | { type: 'restored'; task: UnifiedTask }
  | { type: 'vanished'; task: UnifiedTask; absentCount: number }
  | { type: 'removed'; task: UnifiedTask };

export interface MergePlan {
  /** 需要落库的记录（含 revision/lastSeenAt 更新） */
  writes: UnifiedTask[];
  events: TaskEvent[];
  created: number;
  updated: number;
  unchanged: number;
  vanished: number;
  removed: number;
}

export interface MergeOptions {
  /** 连续缺席多少轮才软删除 */
  absenceThreshold: number;
  /** 变更历史保留条数 */
  historyLimit: number;
  /** 若为 true 则跳过删除判定（例如上游分页提前中止，本轮数据不完整） */
  skipRemovalDetection?: boolean;
}

export const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  absenceThreshold: 2,
  historyLimit: 10,
};

/**
 * 变更字段的中文名 —— 只用于同步日志里那句「本轮更新：某某（标题、截止时间）」。
 *
 * ⚠️ 这是**第二份**字段名映射：面向界面渲染的那份在 `apps/web/public/app.js`
 * 的 `CHANGE_FIELD`（它还要按字段类型格式化值）。两份必然漂移，所以这里刻意
 * **只用于日志文本、不用于渲染**；新增 `ChangeField` 时两处都要改。
 * 为什么不合并：web 是静态页面，import 不到 core 的常量，
 * 而把渲染逻辑挪进 core 会让引擎依赖展示层 —— 那个代价更大。
 */
const CHANGE_FIELD_LABEL: Record<string, string> = {
  created: '新增',
  title: '标题',
  deadline: '截止时间',
  status: '状态',
  score: '成绩',
  course: '课程',
  kind: '类型',
};

/**
 * 把本轮的「更新」事件压成一行人话，给同步日志用。
 *
 * 只报「更新 N」的时候，用户看到「有更新」却不知道该去看哪条，还得另点一页。
 * 真机（2026-11-02）：连续同步三次、每次提示的是**不同**作业，而日志里只有「更新 1」——
 * 那正是两条记录互相顶替的时期，靠"哪个平台 + 几条"根本归不了因。
 *
 * 只写**任务名 + 字段名**，不写值：值的完整翻译在「变更历史」那一页
 * （那里按字段类型格式化了时间和状态）。两处都写等于再分裂一份映射。
 */
export function describeUpdates(events: TaskEvent[], limit = 5): string | null {
  const brief: string[] = [];
  let total = 0;
  for (const ev of events) {
    if (ev.type !== 'updated') continue;
    total += 1;
    if (brief.length < limit) {
      const fields = [...new Set(ev.changes.map((c) => CHANGE_FIELD_LABEL[c.field] ?? c.field))].join('、');
      brief.push(`${ev.task.title}（${fields}）`);
    }
  }
  if (total === 0) return null;
  return (
    `本轮更新 ${total} 条：${brief.join('；')}` +
    (total > brief.length ? `；另有 ${total - brief.length} 条未列出` : '')
  );
}

/**
 * 纯函数合并：输入「库里已有的任务」+「本轮拉到的任务」，输出写入计划。
 * 不碰数据库、不碰网络、不碰时钟 —— 所以可以完整单元测试。
 */
/**
 * 缺信息不覆盖已知信息。
 *
 * 真机（2026-11-01）：同一份作业的截止时间在「有值」和 `unknown` 之间来回跳，
 * 变更历史里 `10/30 11:59 → unknown` 与 `unknown → 10/30 23:59` 交替出现，
 * 用户什么都没做。连续同步三次，每次"有一条更新"，而且是不同的作业轮流。
 *
 * 根源：页面某一轮没把日期/状态渲染出来，我们就把"这次没看到"当成了
 * **"平台改了"**。这两件事在数据上长得一样（都是 unknown），但含义相反。
 *
 * 判据：平台真正"取消截止时间/撤下状态"极罕见，而"某轮没解析到"很常见。
 * 所以新的解析结果**缺失**时，保留库里已有的值 —— 宁可偶尔显示一个过时的时间，
 * 也不要每天把用户的变更历史刷成噪音（噪音的代价是：真改期会被淹没）。
 */
export function keepKnownFields(prev: UnifiedTask, next: UnifiedTask): UnifiedTask {
  let out = next;
  if (next.deadline.kind === 'unknown' && prev.deadline.kind !== 'unknown') {
    out = {
      ...out,
      deadline: prev.deadline,
      ...(prev.deadlineAt ? { deadlineAt: prev.deadlineAt } : {}),
    };
  }
  if (next.status === 'unknown' && prev.status !== 'unknown') {
    out = {
      ...out,
      status: prev.status,
      ...(prev.statusSource ? { statusSource: prev.statusSource } : {}),
      ...(prev.statusRaw ? { statusRaw: prev.statusRaw } : {}),
    };
  }
  return out;
}

/**
 * 平台有没有给出稳定 ID。
 *
 * materializeTask 在 platformTaskId 缺失时用 `fp_<指纹>` 兜底，
 * 所以前缀就是这个判据的唯一真源（不要在别处另写一份规则）。
 */
function lacksStableId(t: { platformTaskId: string }): boolean {
  return t.platformTaskId.startsWith('fp_');
}

export function mergeTasks(
  existing: UnifiedTask[],
  incoming: UnifiedTask[],
  opts: MergeOptions = DEFAULT_MERGE_OPTIONS,
): MergePlan {
  const byId = new Map<string, UnifiedTask>();
  const byFingerprint = new Map<string, UnifiedTask>();
  for (const t of existing) {
    byId.set(t.id, t);
    // 只在同一账号同一课程内用指纹匹配，避免跨课程误合并
    byFingerprint.set(`${t.accountId}|${t.courseId}|${t.fingerprint}`, t);
  }

  const writes: UnifiedTask[] = [];
  const events: TaskEvent[] = [];
  const touched = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  /**
   * 本轮出现过的主键。
   *
   * 一条老记录只要还在被**自己的 ID** 认领（本轮 incoming 里就有它），
   * 就不许别的任务靠指纹抢走 —— 否则两条 incoming 会写同一个 prev，
   * 后写的覆盖前写的，记录在两条任务之间来回易主。
   */
  const presentIds = new Set(incoming.map((t) => t.id));

  for (const incomingTask of incoming) {
    let prev = byId.get(incomingTask.id);
    if (!prev) {
      const cand = byFingerprint.get(
        `${incomingTask.accountId}|${incomingTask.courseId}|${incomingTask.fingerprint}`,
      );
      // 指纹是**兜底**，不是第二条匹配路径。允许它认领的条件，逐条都有具体事故：
      //
      // ① 至少一方没有稳定 ID —— 平台本来就没给主键，指纹是唯一线索。
      // ② 老记录本轮没有出现 —— 「ID 变了 + 指纹相同」最合理的解释就是平台换了主键
      //    （merge 文件头坑 1 描述的那类平台）。
      //
      // 真机事故（2026-11-02）：PTA 的「25级数据结构上机实验（第2次）/（第3次）」
      // 归一化后指纹相同，两条各自带着真实 platformTaskId 的任务因此被融进同一条
      // 记录，标题/进度/跳转地址各来自不同轮次。用户看到「第3次 · 4/4 已交」，
      // 点进去却是第2次 —— 这种错乱靠看界面根本无法归因。
      //
      // 判据：两个任务能不能是同一个，取决于**平台给没给同一个 ID**，
      // 不取决于我们猜"标题像不像"。所以①②都不成立时，标题再像也各自独立。
      if (cand && (lacksStableId(incomingTask) || lacksStableId(cand) || !presentIds.has(cand.id))) {
        prev = cand;
      }
    }

    // 缺信息不覆盖已知信息 —— 只在能对上旧记录时才有意义（见 keepKnownFields）
    const next = prev ? keepKnownFields(prev, incomingTask) : incomingTask;

    if (!prev) {
      // 「新增」本身也要进变更历史 —— 否则这页只记录"已知任务被改"，
      // 而**新同步到的作业根本不出现**。真机上表现成：
      // 同步条写「新增 3」，变更历史写「最近 30 天没有变更记录」，两边互相打架。
      //
      // 只记**今后**新增的任务，不回填老记录：给已存在的任务补一条「新增」
      // 会让人一次看到几十条噪音，把真正值钱的改期记录淹掉。
      const born: TaskChange = {
        field: 'created',
        from: null,
        to: next.title,
        at: next.lastSeenAt,
      };
      const fresh: UnifiedTask = { ...next, history: [born] };
      writes.push(fresh);
      events.push({ type: 'created', task: fresh });
      touched.add(next.id);
      created += 1;
      continue;
    }

    // 用户手动删过的任务：本地墓碑优先。平台再怎么推，都不恢复、不计变更 ——
    // 否则「删掉」会在下一次同步时全部复活，删除功能等于没有。
    if (prev.userDeletedAt) {
      touched.add(prev.id);
      continue;
    }

    const changes = diffTask(prev, next);
    const wasDeleted = Boolean(prev.deletedAt);

    if (changes.length === 0 && !wasDeleted) {
      // 「新加的元数据字段」回填 —— 见下面的 BACKFILL_FIELDS。
      //
      // 真机踩过（2026-10-11，v0.1.57）：statusSource 这个字段加进来之后，
      // 雨课堂那些**老任务**的 statusSource 一直是 undefined，被 effectiveStatus
      // 当成"平台说的"，于是用户手动标记被"平台优先"挡下，界面还写着"平台称未完成"。
      // 根因就是这里：内容没变 → 走幂等分支 → **不写库** → 新字段永远落不到老记录上。
      //
      // 回填**不算变更**：这些字段不是平台内容，不产生变更事件、不动 revision
      // （否则用户会凭空看到一堆"有变更"，而老师其实什么都没改）。
      const patch: Partial<UnifiedTask> = { ...backfillPatch(prev, next) };
      // 平台这次没给 progress 时**不要**抹掉已有的进度 ——
      // 少给一次响应不该让你刚做完的记录凭空消失。
      if (next.progress && !sameProgress(prev, next)) {
        patch.progress = next.progress;
        patch.subtasks = next.subtasks;
        patch.lastSeenAt = next.lastSeenAt;
      }
      if (Object.keys(patch).length > 0) {
        writes.push({ ...prev, ...patch });
      }
      // 幂等命中：内容没变，**通常**不写库 —— 每轮都写会让文件型存储被无意义地刷盘。
      unchanged += 1;
      touched.add(prev.id);
      continue;
    }

    const resolved = resolveDeadline(prev, next);

    const merged: UnifiedTask = {
      ...prev,
      // 平台侧 ID 可能变化，但本地主键一旦确定就不再改 ——
      // 否则 UI 里正在看的详情页会突然找不到记录。
      ...next,
      id: prev.id,
      deadline: resolved.deadline,
      deadlineAt: resolved.deadlineAt,
      revision: prev.revision + 1,
      history: [...changes, ...prev.history].slice(0, opts.historyLimit),
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: next.lastSeenAt,
      absentCount: 0,
      deletedAt: undefined,
      // 用户手动标记是**本地事实**，平台报文里没有它 —— 显式保留。
      // 不显式写也可以（next 里没这个键，...prev 会留下来），但那是靠巧合：
      // 哪天 materializeTask 顺手带上了这个字段，用户的标记就会被每轮同步悄悄抹掉。
      // 与 userDeletedAt 同一个道理：用户说过的话，同步不许覆盖。
      userCompletedAt: prev.userCompletedAt,
    };

    writes.push(merged);
    touched.add(prev.id);
    if (wasDeleted) {
      events.push({ type: 'restored', task: merged });
    } else {
      events.push({ type: 'updated', task: merged, changes });
    }
    updated += 1;
  }

  let vanished = 0;
  let removed = 0;

  if (!opts.skipRemovalDetection) {
    for (const prev of existing) {
      if (touched.has(prev.id) || prev.deletedAt) continue;
      // 只对本轮覆盖到的账号做缺席判定，由调用方保证 existing 已按账号过滤
      const absentCount = prev.absentCount + 1;
      if (absentCount >= opts.absenceThreshold) {
        writes.push({ ...prev, absentCount, deletedAt: prev.lastSeenAt, lastSeenAt: prev.lastSeenAt });
        events.push({ type: 'removed', task: prev });
        removed += 1;
      } else {
        writes.push({ ...prev, absentCount });
        events.push({ type: 'vanished', task: prev, absentCount });
        vanished += 1;
      }
    }
  }

  return { writes, events, created, updated, unchanged, vanished, removed };
}
