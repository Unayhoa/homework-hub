/**
 * 统一任务模型 —— 所有平台的数据最终都收敛到这里。
 *
 * 设计取舍说明：
 * - 用「平台原始字段全量保留」而不是「只留我们认识的字段」：
 *   平台改版时，你还能靠 raw 排查问题；只留认识的字段则等于永久丢失线索。
 * - revision / firstSeenAt / absentCount 这三个是同步引擎的元数据，
 *   不是业务数据。它们让「老师改了截止时间」和「翻页失败导致任务消失」可区分。
 */
import type { Deadline } from './deadline.ts';
import { effectiveInstant } from './deadline.ts';

export type TaskKind =
  | 'homework' // 作业：可提交，有截止时间
  | 'exam' // 考试：时间窗固定，通常不可补交
  | 'quiz' // 章节测验 / 随堂小测
  | 'task-point' // 超星特有的「任务点」：看视频、读文档
  | 'discussion' // 讨论区发帖
  | 'other';

export type TaskStatus =
  | 'pending' // 待完成（未提交）
  | 'submitted' // 已提交，未出分
  | 'graded' // 已出分
  | 'expired' // 已过期且不可提交
  | 'skipped' // 用户判定「这条与我无关」（小组由别人交 / 免修 / 换课）
  | 'unknown';

/**
 * 一条变更记录说的是「哪个字段变了」。
 *
 * 注意 `'created'` 不是一个**字段**，而是一个**事件**：这条任务第一次出现在库里。
 * 把它放进同一个联合类型，是因为对用户来说两者是同一类信息
 * （「变更历史」要回答的是"这里发生过什么"，而不是"哪个属性被改过"）。
 *
 * 为什么必须有它：以前只有字段 diff 会进历史，于是**新增任务在变更历史里完全不可见** ——
 * 同步提示写着「新增 3」，变更历史却写着「最近 30 天没有变更记录」，
 * 两个界面互相矛盾，用户只能认为这页坏了。
 */
export type ChangeField = 'created' | 'title' | 'deadline' | 'status' | 'score' | 'course' | 'kind';

export interface TaskChange {
  field: ChangeField;
  from: string | null;
  to: string | null;
  at: string;
}

/**
 * 题目级进度。只有能拿到「每道题状态」的平台才有（目前是 PTA）。
 *
 * 为什么要有它：有些平台的「一份作业」是由 N 道题组成的，完成度不是一个布尔值。
 * 而 `status` 只能表达「交没交」，表达不了「交了几题、过了几题」。
 *
 * **它与 status 是两个维度，不是替代关系**：
 *   status 回答「还要不要催我」（按"交"算）
 *   progress 回答「我做到哪了」（按题算）
 * 混在一起就会丢掉一边 —— 比如「全交了但只 AC 了一半」，两种语义都装不下。
 */
export interface TaskProgress {
  /** 已有提交记录的题数（AC、WA、编译错误都算交过） */
  submitted: number;
  /** 其中通过的题数 */
  accepted: number;
  total: number;
}

/**
 * 单题摘要，供「点开看每题」用。
 * 刻意只留判断需要的三样 —— 题干、答案、测试数据一律不存（那是平台的内容，不是我们的）。
 */
export interface TaskSubtask {
  /** 题号：A / B / C… 或平台给的序号 */
  label: string;
  score: number;
  /** 平台原始状态码（如 PROBLEM_ACCEPTED），翻译留给界面 */
  status: string;
}

export interface UnifiedTask {
  /** 全局主键，形如 `chaoxing:work_123456` */
  id: string;
  platformId: string;
  /** 平台内 ID；平台没给稳定 ID 时退化为指纹 */
  platformTaskId: string;
  /** 产生此任务的账号（登录用户名摘要），用于多账号区分 */
  accountId: string;
  courseId: string;
  courseName: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  deadline: Deadline;
  /**
   * 首次观测时对 deadline 锚定的绝对时刻。
   * 只有相对型截止时间（「还剩 3 天」）需要它 —— 否则任务永远到不了期。
   * 见 domain/deadline.ts 的 effectiveInstant()。
   */
  deadlineAt?: string;
  /** 发布时间，部分平台不提供 */
  publishedAt?: string;
  score?: number;
  totalScore?: number;
  /**
   * 题目级进度（可选）。给了它，界面就能画进度条、回答「还有几题」；
   * 没给（超星 / iSmart / 雨课堂）则一切照旧，行为与加这个字段之前完全一致。
   */
  progress?: TaskProgress;
  /** 每题摘要（可选）。只在用户点开详情时要，不在列表里渲染。 */
  subtasks?: TaskSubtask[];
  /** 直接跳转到平台页面的深链，聚合型 app 的「点进去做」就靠它 */
  sourceUrl?: string;
  /**
   * 平台显示名 —— **只有手动添加的任务**会用到（用户自己填的文字，不限于已知平台）。
   *
   * 为什么不让手动任务借用 platformId：platformId 是「来源实现的标识」，
   * 拿它装用户输入的文字（"雨课堂"、"教务处通知"…）会让两件事混在一起 ——
   * 上游同步要按 platformId 找适配器，而手动任务根本没有适配器。
   * 所以来源恒为 'manual'，用户填的名字放这里，界面优先显示它。
   */
  platformLabel?: string;
  /** 内容指纹，平台无稳定 ID 时作为兜底主键 */
  fingerprint: string;
  /** 关键字段每变化一次 +1，用于「这个作业改过」的提示与提醒重置 */
  revision: number;
  /** 变更历史，只保留最近 N 条，避免无限增长 */
  history: TaskChange[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** 连续多少轮同步没在上游看到它。达到阈值才软删除，防翻页抖动误删。 */
  absentCount: number;
  /** 软删除时间；有值表示已从列表隐藏但保留记录（可能被上游恢复） */
  deletedAt?: string;
  /**
   * 用户手动删除的墓碑。与 deletedAt 的区别：deletedAt 是同步层「上游不见了」，
   * 上游恢复时会自动复活；userDeletedAt 是用户明确说「我不要这条」，
   * 合并层见到它就不再写入 —— 同步多少次都不会复活。
   */
  userDeletedAt?: string;
  /**
   * 用户手动标记「已完成」的时刻。
   *
   * 规则（用户 2026-10-11 定的「**平台优先**」）：平台**明确断言过未完成**时以平台为准，
   * 手动标记不生效；平台沉默、或平台只说了「过期」这类非完成性断言时，手动标记生效。
   * 判定集中在 {@link effectiveStatus} —— 全应用只此一处。
   *
   * 刻意**永不自动清除**：平台改口只是让它暂时被压制，不是删除用户说过的话。
   * 哪天平台风向又变回来，标记自然重新生效。
   */
  userCompletedAt?: string;
  /**
   * 用户判定「这条不用我交」的时刻。
   *
   * 为什么它必须是**独立状态**、而不是借用「已完成」：
   *   completed 回答的是「我交没交」，skipped 回答的是「这条适不适用」。
   * 典型场景：小组作业平台给每个组员都推一条待办，但实际只需组长提交。
   * 标成"已完成"是在撒谎（我没交），标成"不用交"才是实情。
   *
   * 也正因为它是**另一个维度**，所以它不受「平台优先」限制：
   * 平台说 pending 只否定了"我交了"，从没说过"这条需要你交"。
   * （与 expired 那个论证同源：过期是关于时间的断言，不是关于交没交的断言。）
   *
   * 与 userCompletedAt 互斥：标一个会清掉另一个。
   */
  userSkippedAt?: string;
  /**
   * 这个 status 是「平台报告的」还是「我们推断的」。
   *
   * 为什么必须区分（2026-10-11 真机教训）：雨课堂的章节树**根本没有完成态字段**
   * （见 yuketang 适配器的字段取证），我们按 deadline 推了个「待完成」出来 ——
   * 界面于是在**替平台断言**「你还没交」。而用户手动标完成时，必须先知道
   * 平台到底说没说，否则「平台优先」这条规则根本无法定义。
   *
   * 默认按 'platform' 处理（undefined 视同平台说的，见 effectiveStatus），
   * 只有确实在推断的路径才显式标 'inferred'。
   */
  statusSource?: 'platform' | 'inferred';
  /** 平台原话，只用于展示；不参与任何判定（见 PlatformTask.statusRaw） */
  statusRaw?: string;
  /** 开考时刻（ISO）。只对考试有意义，见 PlatformTask.startsAt */
  startsAt?: string;
  /** 平台原始数据，排查问题用 */
  raw?: unknown;
}

/** 由平台适配器产出的「未归一化」任务，engine 负责补 id/fingerprint/revision 等元数据。 */
export interface PlatformTask {
  platformTaskId?: string;
  courseId: string;
  courseName?: string;
  kind: TaskKind;
  title: string;
  status?: TaskStatus;
  /**
   * status 是平台报告的，还是适配器推断的？默认 'platform'。
   * 只有「平台确实没给状态、我们自己算了一个」的路径才标 'inferred'。
   */
  statusSource?: 'platform' | 'inferred';
  /**
   * 平台**原话**（「未开放作答」「进行中」「待批阅」…），只用于界面展示。
   *
   * 为什么要它（2026-11-01 用户反馈）：超星把"未开放作答"的作业也报成"未交"，
   * 我们按语义归到 `pending`，界面于是显示「待完成」—— 用户以为现在就该做，
   * 实际还没到开放时间。分类没错，缺的是"平台到底怎么说的"这一层。
   *
   * 它**不参与任何判定**（状态机只看 `status`），所以没有"两份判据"的风险。
   */
  statusRaw?: string;
  /** 任意形态，交给 normalizeDeadline 处理 */
  deadline?: unknown;
  /**
   * 开考时刻（只对考试有意义）。
   *
   * 为什么和 deadline 分开存（2026-11-02 用户要求）：
   * 考试真正要"行动"的时刻是**开考**（10:00 到考场），而不是结束（11:40）。
   * 所以界面显示和分组都该按 startsAt；但"是否已逾期"必须按 deadline ——
   * 否则考试一开始就被标成逾期，那是错的（还在考）。
   *
   * 超星的考试列表页只给结束时间（`goTest(...)` 第 4 参），
   * 开始时间只在详情页 `examnotes?examId=` 里，所以要多一个请求（有上限）。
   */
  startsAt?: string;
  publishedAt?: unknown;
  score?: number;
  totalScore?: number;
  /** 题目级进度（可选，见 UnifiedTask.progress） */
  progress?: TaskProgress;
  /** 每题摘要（可选，见 UnifiedTask.subtasks） */
  subtasks?: TaskSubtask[];
  sourceUrl?: string;
  raw?: unknown;
}

/** 平台报的状态算不算「终态」（进了已完成栏） */
export function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'submitted' ||
    status === 'graded' ||
    status === 'expired' ||
    status === 'skipped'
  );
}

/**
 * 手动标记在这条任务上**能不能起作用**（「平台优先」的判据本身）。
 *
 * 抽出来是为了让"能不能标"和"标了显示什么"用同一条判据 ——
 * 两处各写一遍，迟早会出现"按钮在、点了没用"。
 */
function manualMarkApplies(task: UnifiedTask): boolean {
  if (task.statusSource === 'inferred') return true; // 平台沉默，用户说了算
  if (task.status === 'pending') return false; // 平台明确说"你还没交"→ 听平台
  if (task.status === 'submitted' || task.status === 'graded') return false; // 平台已给终态
  return true; // 平台只说了过期 / 状态未知 —— 不是"交没交"的断言，用户说了算
}

/**
 * 生效状态 —— 全应用**唯一**的状态判定入口。
 *
 * 以前「什么是终态」这个判断散在四处各写一遍（upcoming / completed / 诊断 / 提醒），
 * 每加一条规则就要改四个地方 —— 必然漂移。收成一个函数。
 *
 * 规则（「平台优先」，用户 2026-10-11 定）：见 {@link manualMarkApplies}。
 * 特别地，`expired` 不压制手动标记 —— 它是关于**时间**的断言，
 * 不是关于**你交没交**的断言，拿它去否决用户手写的"我交了"是越界。
 */
export function effectiveStatus(task: UnifiedTask): TaskStatus {
  // 「不用交」优先于一切 —— 包括「已完成」。
  // 它不是对平台的覆盖，而是补上平台不知道的一个维度（这条适不适用）。
  if (task.userSkippedAt) return 'skipped';
  if (!task.userCompletedAt) return task.status;
  return manualMarkApplies(task) ? 'submitted' : task.status;
}

/**
 * 这条任务该不该显示「标记完成」按钮。
 *
 * 不要给**标了也没用**的条目配按钮 —— 死按钮比没有按钮更糟：
 * 用户点了没反应，只会怀疑是自己没点对或应用坏了。
 * 判据与 {@link effectiveStatus} 完全一致，所以"能看见按钮"就必然"点了有效"。
 */
export function canMarkCompleted(task: UnifiedTask): boolean {
  if (isTerminalStatus(task.status)) return false; // 已经是终态，没什么可标
  return manualMarkApplies(task);
}

/**
 * 这条任务的完成状态**只能靠用户自己标** —— 平台根本没报（`statusSource: 'inferred'`）。
 *
 * 与 {@link canMarkCompleted} 的分工（两个问法，不是同一件事）：
 *   canMarkCompleted  → 「此刻**能不能**标」（会被平台优先规则压住）
 *   needsManualCompletion → 「这条**必须你标**才会消掉」（平台的属性，与是否过期无关）
 *
 * 为什么要这个函数、而不让界面自己判 `statusSource === 'inferred'`：
 * 这条判据决定要不要在卡片上教用户"点 ✓"，判错一边就是噪音（平台明明报状态、
 * 却让他去标），判错另一边就是静默失败（他做完了、卡片永远不清）。
 * 判据一旦写进前端，就变成"core 一套、UI 一套"，迟早漂移 —— 见 LESSONS 第 2 条。
 *
 * 已标过（完成 / 不用交）就不再啰嗦：那时卡片已经不在待办里，提示没有意义。
 * **注意不判 status 是否终态**：平台沉默是平台的属性，不是这条任务当前状态的属性；
 * 雨课堂的作业过了截止时间也一样需要用户自己去标。
 */
export function needsManualCompletion(task: UnifiedTask): boolean {
  if (task.statusSource !== 'inferred') return false;
  return !task.userCompletedAt && !task.userSkippedAt;
}

/**
 * 这条任务的「已完成」是谁给的？
 * 界面靠它标出「手动」—— 本地数据绝不能伪装成平台数据（口径洁癖）。
 */
export function completionOrigin(
  task: UnifiedTask,
): 'platform' | 'manual' | 'skipped' | null {
  const eff = effectiveStatus(task);
  if (!isTerminalStatus(eff)) return null;
  if (eff === 'skipped') return 'skipped';
  if (eff === 'submitted' && task.status !== 'submitted') return 'manual';
  return 'platform';
}

/**
 * 能不能标「不用交」。
 *
 * 判据故意比 {@link canMarkCompleted} **宽** —— 不受「平台优先」限制。
 * 理由见 userSkippedAt 的注释：这是另一个维度的事。
 * 唯一的例外是"已经是终态"（已完成 / 已过期 / 已标不用交），那时没什么可标的。
 */
export function canSkip(task: UnifiedTask): boolean {
  return !isTerminalStatus(effectiveStatus(task));
}

export function isActionable(task: UnifiedTask): boolean {
  if (task.deletedAt || task.userDeletedAt) return false;
  const s = effectiveStatus(task);
  return s === 'pending' || s === 'unknown';
}

export function isOverdue(task: UnifiedTask, now: Date): boolean {
  const at = effectiveInstant(task.deadline, task.deadlineAt, now);
  return at ? at.getTime() < now.getTime() : false;
}

/**
 * 「题全交了，但还没全 AC，而且还没过期」—— 第三种状态。
 *
 * 为什么它必须是独立判断，而不是硬塞进 status：
 *   `status` 回答「还要不要催我」（按**交没交**算）
 *   `progress` 回答「我做到哪了」（按**题**算）
 * 混成一个值就会丢一边 —— 「全交了但只 AC 一半」在二值状态里无处安放：
 * 标成 submitted 就离开了待办（想刷 AC 的人再也找不到它），
 * 标成 pending 就又进了紧急分组（已经交了的作业还在催）。
 *
 * 所以它留在待办页，但：**不排提醒**（isActionable 只看 status，天然为 false）、
 * **不进已完成栏**（completed 排除它）、**排在同组末尾**（位置就是注意力）。
 *
 * 用户手动标过「已完成 / 不用交」的不算 —— 用户说过的话优先。
 */
export function hasPendingAc(task: UnifiedTask, now: Date): boolean {
  const p = task.progress;
  if (!p || p.total <= 0) return false;
  if (task.userCompletedAt || task.userSkippedAt) return false;
  if (p.submitted < p.total) return false; // 还没交完 → 普通待办，该催
  if (p.accepted >= p.total) return false; // 全 AC → 真完成
  // 过期之后平台就不收提交了，再显示「待 AC」只会让人白跑一趟
  return !isOverdue(task, now);
}
