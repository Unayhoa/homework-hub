/**
 * 任务点的截止提醒。
 *
 * ## 为什么不能照抄作业提醒
 *
 * 作业的提醒挂在**时刻**上：`T-24h` 提醒"还有一天"，这话对任何作业都成立。
 * 任务是**工作量**：一门还剩 30 个视频的课，提前 24 小时提醒等于通知
 * 「你已经来不及了」—— 那不是提醒，是补刀（用户 2026-11-04 原话）。
 *
 * 所以倒过来算：先估"还差多少活"，再拿它决定提前多久提醒。
 *   还剩 3 个 → 约 1 小时 → 提前 6 小时（下限）
 *   还剩 30 个 → 约 11 小时 → 提前 11 小时
 *   还剩 200 个 → 约 75 小时 → 顶到 48 小时（上限，再早就成了噪音）
 *
 * ## 为什么是估算而不是精确
 *
 * 精确时长确实存在：`GET /ananas/status/{objectid}` 返回 `{"duration":215}`。
 * 但 objectid 只在**每个章节的详情页**里，一门 15 章 50 个任务点的课要
 * 15 + 50 个请求才能算准。为了一个提前量付这个代价不值 ——
 * 而估算错了的代价是"早提醒几小时"或"晚提醒几小时"，不是"错过"。
 *
 * 参数全部可调（见 `TaskPointReminderConfig`），默认值取偏保守的一侧：
 * 宁可早一点催，也不要让人在关窗前才发现。
 */

import type { ScheduledNotification } from './notify-schedule.ts';

export interface TaskPointReminderConfig {
  /**
   * 每个任务点按多少分钟算。
   *
   * 15 分钟的依据：本项目的真机样本里，一个音频任务点 `duration: 215`（3.6 分钟），
   * 文档类通常 10–30 分钟，章节测验 10–20 分钟。取 15 是这三类的中间偏上。
   * **不假设倍速播放** —— 算出来的应该是"要花掉的时间"，不是"视频长度"。
   */
  minutesPerPoint: number;
  /**
   * **每天真实能投入的小时数**（用户在设置页调）。
   *
   * 它把"要花掉多少小时"换算成"要占用多少天"：
   *   净工作量 25 小时、每天投 6 小时 → 需要 4.2 天 → 提前 4.2 天提醒
   *
   * ⚠️ 这个参数**不是**"提前多久"的旋钮。它同时控制两件方向相反的事：
   *   调大 → 提醒更贴截止（少打扰），但也**假设你能突击得更狠**
   * 所以它应该反映真实作息，不是"希望少被打扰"。见方案 §7.6。
   */
  dailyHours: number;
  /**
   * 安全冗余（固定时长，不是系数）。
   *
   * ⚠️ **这里没有"最大提前量"**。2026-11-04 用户指出：给提前量设上限是错的 ——
   * 一门工作量 75 小时的课，上限 48 小时意味着「离截止 48 小时才提醒你」，
   * 而那时已经来不及了。上限把"提醒"变成了"通知你错过"。
   */
  bufferMs: number;
}

export const DEFAULT_TASK_POINT_REMINDER: TaskPointReminderConfig = {
  minutesPerPoint: 15,
  // 6 小时/天：课后时间的一半（2026-11-04 用户定的默认值）。
  dailyHours: 6,
  // 12 小时：留出"看到提醒 → 找到时间坐下来开始"的余量。
  bufferMs: 12 * 60 * 60 * 1000,
};

/** 计算所需的课程切片（不直接吃 UnifiedCourse，方便测试与复用） */
export interface TaskPointCourse {
  /** 内部课程 ID（稳定，用作通知 key 的一部分） */
  id: string;
  name: string;
  total: number;
  done: number;
  /**
   * 这一章什么时候关（ISO）。**只有窗口此刻真的开着才给** ——
   * 没开的窗口关不关与你无关，那不是一个"还敢不敢拖"的期限。
   */
  closesAt?: string;
  /** 此刻能不能做。不能做的课提醒了也没用（去做不了的事只会让人焦虑） */
  hasOpenNow: boolean;
}

export type TaskPointUrgency =
  /** 已经全部完成 */
  | 'done'
  /** 窗口已经关了（逾期） */
  | 'closed'
  /** 还开着，但按估算**现在开始也来不及** */
  | 'impossible'
  /** 还开着，来得及，但已经进入该催的窗口 */
  | 'due-soon'
  /** 还开着，时间还宽裕 */
  | 'ok';

/**
 * 还差多少**净投入时间**（毫秒）。不含冗余。
 *
 * 注意它的含义：假设"从现在开始全时段投入"。这是一个偏乐观的下界 ——
 * 现实里人一天只能挤出几小时。但这个数字的用途是**判断什么时候该提醒**，
 * 不是"承诺你能刷完"：
 *   · 用它算提醒点 → "最早值得提醒的时刻"（再早你也不会开始，只会麻木）
 *   · 用它和剩余时间比 → "现在还来不来得及"
 * 真正的持续保障靠角标，不靠把提醒点无限提前。
 */
export function workloadMs(course: Pick<TaskPointCourse, 'total' | 'done'>, cfg: TaskPointReminderConfig): number {
  const remaining = Math.max(0, course.total - course.done);
  return remaining * cfg.minutesPerPoint * 60_000;
}

/**
 * 该提前多久提醒 = 净工作量换算成的日历时间 + 固定冗余。
 *
 * ```
 * 日历时间 = 净工作量 / 每天可投入
 * 提前量   = 日历时间 + 冗余
 * ```
 *
 * **不设上限**（理由见 `bufferMs`）。也不设下限 —— 常数冗余本身就是下限，
 * 只剩 1 个任务点时提前 12.3 小时，不会变成"提前 20 分钟"那种没用的提醒。
 */
export function leadMs(course: Pick<TaskPointCourse, 'total' | 'done'>, cfg: TaskPointReminderConfig): number {
  const work = workloadMs(course, cfg);
  const days = work / 3_600_000 / Math.max(cfg.dailyHours, 1); // 净小时 → 天数
  return days * 86_400_000 + cfg.bufferMs;
}

/**
 * 这门课现在处于哪种状态。
 *
 * `impossible` 单独成一档，因为它需要**完全不同的话术**：
 * 不是"快点做"，而是"现在开始也悬，先做最要紧的"。
 * 把这两种说法混成一句，两种场景都会说错。
 */
export function urgencyOf(
  course: TaskPointCourse,
  now: Date,
  cfg: TaskPointReminderConfig = DEFAULT_TASK_POINT_REMINDER,
): TaskPointUrgency {
  const remaining = Math.max(0, course.total - course.done);
  if (remaining === 0) return 'done';
  const closes = course.closesAt ? new Date(course.closesAt).getTime() : NaN;
  if (!Number.isFinite(closes)) return 'ok';
  const remainMs = closes - now.getTime();
  if (remainMs <= 0) return 'closed';
  if (workloadMs(course, cfg) > remainMs) return 'impossible';
  // 进入"该提前多久"的那一刻起就算 due-soon
  if (remainMs <= leadMs(course, cfg)) return 'due-soon';
  return 'ok';
}

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把毫秒说成人话：45 分钟 / 3 小时 / 2 天。 */
export function humanDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时`;
  const day = Math.round(hour / 24);
  return `${day} 天`;
}

/**
 * 生成任务点的提醒排期。
 *
 * **只排未来的**：算出来的提醒点如果已经过去（说明本来就该催了），
 * 这里不补发 —— 补发的后果是每次打开 App 都弹一遍。
 * 那部分由角标承担（界面上一直能看到），弹窗只负责"提前告知"。
 */
export function planTaskPointNotifications(
  courses: TaskPointCourse[],
  now: Date,
  cfg: TaskPointReminderConfig = DEFAULT_TASK_POINT_REMINDER,
): ScheduledNotification[] {
  const out: ScheduledNotification[] = [];
  const nowMs = now.getTime();

  for (const c of courses) {
    if (!c.hasOpenNow) continue; // 做不了的事不需要催
    const remaining = Math.max(0, c.total - c.done);
    if (remaining === 0) continue;
    const closes = c.closesAt ? new Date(c.closesAt).getTime() : NaN;
    if (!Number.isFinite(closes)) continue; // 没有期限，排不了

    const fireAt = closes - leadMs(c, cfg);
    if (fireAt <= nowMs + 60_000) continue; // 已过提醒点：交给角标，不重复弹

    const work = workloadMs(c, cfg);
    out.push({
      // key 里带关闭时刻：老师改期后是一个新的提醒，而不是"已经发过就不发了"
      key: `points:${c.id}:${c.closesAt}`,
      kind: 'points',
      title: `${c.name} 的任务点快关了`,
      body: `还差 ${remaining} 个，${fmtLocal(c.closesAt!)} 关闭。按每个 15 分钟估，约需 ${humanDuration(work)}。`,
      fireAt: new Date(fireAt).toISOString(),
      dueAt: new Date(closes).toISOString(),
    });
  }

  return out.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}

/**
 * 待办页「任务点」页签上的角标。
 *
 * 判据：**有几门课已经进入该催的窗口**（含来不及的）。
 * 它和弹窗的分工是：弹窗提前告知一次，角标持续显示"现在还有事"。
 * 所以"已过提醒点"的课不进弹窗、但一定进角标 —— 两边正好互补。
 */
export function taskPointAlertCount(
  courses: TaskPointCourse[],
  now: Date,
  cfg: TaskPointReminderConfig = DEFAULT_TASK_POINT_REMINDER,
): number {
  let n = 0;
  for (const c of courses) {
    if (!c.hasOpenNow) continue;
    const u = urgencyOf(c, now, cfg);
    if (u === 'due-soon' || u === 'impossible') n += 1;
  }
  return n;
}

/**
 * 每日汇总里那一段（用户 2026-11-04 的方案：不新增通知，塞进本来就会发的那条）。
 *
 * 措辞刻意**不说"还剩 X 天"**：每日汇总在排期那一刻就把正文写死了，
 * 到真正弹出时可能已经过了一天。会漂移的说法一律换成"关闭日期"。
 *
 * @param day 这条汇总将在哪一天弹
 */
export function digestLineFor(
  courses: TaskPointCourse[],
  day: Date,
  cfg: TaskPointReminderConfig = DEFAULT_TASK_POINT_REMINDER,
  max = 3,
): string | undefined {
  const dayMs = day.getTime();
  const parts: string[] = [];
  for (const c of courses) {
    if (!c.hasOpenNow) continue;
    const remaining = Math.max(0, c.total - c.done);
    if (remaining === 0) continue;
    const closes = c.closesAt ? new Date(c.closesAt).getTime() : NaN;
    if (!Number.isFinite(closes)) continue;
    // 那天已经关了 → 不再占汇总的版面（它已经变成"过期"，不是"要做的"）
    if (closes <= dayMs) continue;
    // 那天还没进紧急期 → 不提，避免把 7 天后的汇总写成催命符
    if (dayMs < closes - leadMs(c, cfg)) continue;
    parts.push(`${c.name} 还差 ${remaining} 个（${fmtLocal(c.closesAt!)} 关闭）`);
    if (parts.length >= max) break;
  }
  return parts.length > 0 ? `任务点：${parts.join('；')}` : undefined;
}
