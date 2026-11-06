/** 统一课程模型。课程比任务稳定得多，可以做较长 TTL 缓存，减少对平台的请求量。 */
/**
 * 任务点（章节点）完成情况。
 *
 * 为什么挂在课程上、而不是塞进 `UnifiedTask`：
 * 任务点没有 deadline，它是**累积型指标**（这门课 30 个点、完成 18 个），
 * 而待办页的分组轴是时间（逾期 / 24 小时内 / 三天内 …）。同一个实体放进去，
 * 要么撑坏时间轴，要么永远落在「截止未知」里 —— 两条路都在毁掉待办的价值。
 *
 * 判据：一条数据该不该进待办，看它**有没有"要行动的时刻"**。
 * 任务点回答的是"还差多少"，那是课程页面该回答的问题。
 */
/**
 * 任务点数据的形状版本。
 *
 * **每次给 `CourseTaskPointProgress` 加字段都必须 +1。**
 * 因为这份数据有 24h 刷新 TTL：老记录在一整天里都不会被重抓，
 * 新字段于是永远补不上 —— 界面上表现成"新功能没生效"，
 * 而看代码怎么都对（真机 2026-11-02：升级后看不到章节开放期，
 * 用户以为是坏了，其实是读了 0.2.31 抓的旧数据）。
 *
 * 前端拿这个值和自己手里的记录版本比较，落后就强制重抓一次。
 * 代价是升级后的第一次打开多花十几秒，换的是"新字段一定出现"。
 *
 * 1 = 只有 total/done（v0.2.31）
 * 2 = 增加章节开放窗口 nextWindow（v0.2.32 起）
 * 3 = 增加已关闭时间 lastClosedAt + hasOpenNow（v0.2.35：区分"还能补/已错过/还没开"）
 * 4 = hasOpenNow 的判据扩到「有待完成任务点的章节」（v0.2.39）
 * 5 = 认第二种窗口写法 （v0.2.39）。
 *     旧数据里这类章节的窗口全丢了，必须重抓才能补上。
 * 6 = 增加「现在可做」的条数 availableNow（v0.2.44）。
 *     旧数据没有这个数，必须重抓才能补上。
 */
export const TASK_POINT_SCHEMA = 6;

export interface CourseTaskPointProgress {
  /** 数据形状版本，见 `TASK_POINT_SCHEMA`。缺失视为 1 */
  schema?: number;
  /** 平台口径的任务点总数。0 表示这门课没有任务点（不显示卡片） */
  total: number;
  /** 已完成数 */
  done: number;
  /**
   * 最近一个**还没结束**的章节开放期。
   *
   * 语义要说准：这不是"作业截止时间"，是**这一章的开放窗口**（超星原话
   * 「开放时间：2026-11-08 23:00 至 2026-11-29 23:00」）。窗口关闭之后就看不成了，
   * 所以它对用户等价于"11/29 前得看完"，但文案不能写「截止」——
   * 那会让人以为可以提交什么东西。
   *
   * 只在**该窗口还没过期**时才写这个键。全部过期 = 这门课已经没有可做的任务点，
   * 那是"进度不再变化"的解释，不是"还有事要做"。
   */
  nextWindow?: TaskPointWindow;
  /**
   * 最近一个已经关闭的窗口的关闭时刻（ISO）。
   *
   * 它回答的是「还差的那几个，是不是已经做不了了」：
   * 有它 + `done < total` + 没有 nextWindow = **逾期**。
   * 没有它的话，界面只能说"还差 2 个"，而用户分不清是"还能补"还是"已经错过"。
   */
  lastClosedAt?: string;
  /**
   * 此刻有没有开放中的章节。
   *
   * 缺了它就分不清「现在能做，11/29 关」和「现在一章都没开，11/8 才开」——
   * 前者该去刷，后者去也白去。
   */
  hasOpenNow?: boolean;
  /**
   * 此刻**还能做**的任务点条数（只算已经开放、且还有未完成点的章节）。
   *
   * 与 `hasOpenNow` 的分工：布尔值只回答"现在有没有事可做"，这个数回答"有多少"。
   * 分阶段开放的课（部分章节已开、部分要等下次开放）里，两者完全不同：
   *   - `done/total` 是全课程的累计进度，其中可能含未开放/已关闭的章节；
   *   - 这个数只统计**现在点进去就能做**的那部分，是行动依据。
   *
   * 取不到 / 无法可靠归属到章节时**不写这个键**（宁可不显示，也不给一个错的数）。
   */
  availableNow?: number;
  /**
   * 抓取时刻（ISO）。
   *
   * 只用于展示"数据是几分钟前/几天前的" —— **不要拿它做刷新判定**，
   * 刷新节奏由游标控制（引擎侧）。混在一起会让"改了系统时间"变成一次全量重抓。
   */
  fetchedAt: string;
}

/** 章节的开放窗口（起止都是绝对时刻，ISO）。 */
export interface TaskPointWindow {
  /** 章节名（带序号，如「2.1 什么是真理？」）—— 用户靠它定位是哪一章 */
  chapter: string;
  opensAt: string;
  closesAt: string;
}

export interface UnifiedCourse {
  id: string;
  platformId: string;
  accountId: string;
  platformCourseId: string;
  /** 平台给的课程名。**同步会覆盖它** —— 它是和平台比对用的原始值，不要往里写用户的改名。 */
  name: string;
  /**
   * 用户自定义的显示名（可选）。
   *
   * 与 name 的分工：name 是**数据键的一部分**（比对、去重、日志都靠它），
   * displayName 只影响给人看的那一行字。所以同步**永不覆盖**它 ——
   * 平台改课程名时，用户起的名字应该留着。
   *
   * 清空（undefined）表示恢复平台原名。
   */
  displayName?: string;
  teacher?: string;
  term?: string;
  sourceUrl?: string;
  /**
   * 任务点完成情况（可选）。不写这个键 = 没抓过 / 该平台没有这个概念。
   *
   * ⚠️ 课程同步（upsertCourses）是 `{...prev, ...next}` 合并写入，所以
   * **拼 mapped 时绝不能写 `taskPoints: undefined`** —— 那会把上一轮抓到的进度抹掉。
   */
  taskPoints?: CourseTaskPointProgress;
  /**
   * 用户不想在任务点页看到这门课（任务点不计入成绩时）。
   *
   * 默认显示 —— 漏掉一门要刷的课代价是挂科，多显示一门只是列表长一点，
   * 这个不对称决定了默认值。
   *
   * 与「不再同步」(`course-mute` 游标) 是两个维度：那门课该同步照常同步，
   * 作业考试照常收，只是不参与任务点统计。
   * ⚠️ 同步永不许覆盖它（与 displayName 同一条规矩）。
   */
  taskPointHidden?: boolean;
  lastSeenAt: string;
  raw?: unknown;
}

export interface PlatformCourse {
  platformCourseId: string;
  name: string;
  teacher?: string;
  term?: string;
  sourceUrl?: string;
  raw?: unknown;
}

/** 平台账号。一个平台可以有多个账号（比如两个学校的学习通）。 */
export interface PlatformAccount {
  id: string;
  platformId: string;
  /** 展示名，默认取用户名脱敏形式 */
  label: string;
  username: string;
  enabled: boolean;
  createdAt: string;
  lastSyncAt?: string;
  lastSyncStatus?: 'ok' | 'partial' | 'failed' | 'auth-required';
  lastSyncMessage?: string;
}

export function maskUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length <= 2) return `${trimmed[0] ?? ''}*`;
  if (trimmed.length <= 6) return `${trimmed[0]}***${trimmed.at(-1)}`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-2)}`;
}

/** 显示给用户看的课程名：用户改过就用改过的，否则用平台原名。 */
export function courseTitle(c: { name: string; displayName?: string }): string {
  const custom = c.displayName?.trim();
  return custom && custom.length > 0 ? custom : c.name;
}
