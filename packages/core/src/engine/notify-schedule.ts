/**
 * 截止提醒的「排期」计算 —— 通知栏那条链路。
 *
 * ── 与 reminder.ts 的分工（两者都叫"提醒"，但不是一回事）──
 *   reminder.ts  ：App **内**提醒框。同步的那一刻判断「哪些窗口刚被满足」，
 *                  即时投递到界面上的提醒列表。解决的是「我打开 App 时该看到什么」。
 *   本文件        ：**系统通知栏**。算出**未来**所有该弹通知的时刻，交给原生用
 *                  系统闹钟注册。解决的是「我没打开 App 时怎么被叫醒」。
 *
 * ── 为什么必须前瞻排期，而不能"同步时顺手发" ──
 * 提醒的时刻（截止前 24 小时）用户几乎肯定没打开 App，而引擎跑在 WebView 的 JS 里：
 * App 被划掉后 JS 定时器根本不存在。所以只有系统闹钟能叫醒我们。
 * 因此这里输出的是**未来时刻清单**，而不是"现在要发什么"。
 *
 * ── 三条容易踩的规则 ──
 * 坑 1｜夜里弹通知等于没弹。
 *   很多平台把截止时间设成 23:59，那么"截止前 24 小时"正好是**前一天深夜 23:59**。
 *   用户不会看，甚至会被吵醒。所以有「静默时段」（默认 22:00–08:00）：
 *   落在里面的提醒**顺延到静默结束**（次日 8:00）。顺延后若已经过了截止时间，
 *   这条提醒就丢弃 —— 提醒的唯一价值是"还来得及"，迟到的提醒只会制造焦虑。
 *
 * 坑 2｜排期必须可重入。
 *   每次同步都会重算并整体替换排期（原生侧先撤销旧的全部闹钟）。所以这里
 *   不能依赖"上次排了什么"，必须只由**当前任务集**唯一决定 —— 同样的任务集
 *   永远算出同样的清单（key 稳定、顺序稳定），否则会出现重复或漏掉的闹钟。
 *
 * 坑 3｜已经过去的窗口不补发。
 *   任务 20 小时后截止时，"截止前 24 小时"这个窗口早就过去了。补发它等于
 *   在同步的瞬间突袭用户一条通知，而且每轮同步都会再补一次。所以只排**未来**的。
 */
import { deadlineKey, effectiveInstant } from '../domain/deadline.ts';
import { isActionable } from '../domain/task.ts';
import type { TaskKind, UnifiedTask } from '../domain/task.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 一条待弹的通知。给原生排期用，字段都是**不可再推断**的最小集。 */
export interface ScheduledNotification {
  /** 稳定标识：原生用它做闹钟的 requestCode 与取消匹配 */
  key: string;
  /** 关联任务；每日汇总不对应任何任务，为 undefined */
  taskId?: string;
  /** 'task' = 某条任务的截止提醒；'daily' = 每日汇总 */
  kind?: 'task' | 'daily';
  title: string;
  body: string;
  /** 期望触发时刻（ISO） */
  fireAt: string;
  /** 截止时刻（ISO），供原生兜底显示；每日汇总等于 fireAt */
  dueAt: string;
}

type Offset = { value: number; unit: 'day' | 'hour' };

/**
 * 一类任务的提醒区间：从「首次」到「最后」，中间均匀分布 times 次。
 *
 * 为什么是「区间 + 次数」而不是「固定的一组提前量」（用户 2026-10-18 的判断）：
 * 原来三档本质上都是"提前一天开始，只是次数不同" —— 用户真正想调的是
 * **什么时候开始、什么时候结束**，次数只是这两端的函数。
 */
export interface RemindSpec {
  /** 首次提醒：提前多少小时 */
  firstHours: number;
  /** 最后一次提醒：提前多少小时 */
  lastHours: number;
  /** 提醒次数（1–3） */
  times: number;
}

/**
 * 相邻两次提醒的最小间隔（小时）。
 *
 * 这个数不是拍脑袋:提醒的意义是"留出行动时间"，一小时内你改变不了什么；
 * 而两次挨着的提醒除了制造焦虑没有新信息。它也顺带是"区间能装几次"的除数 ——
 * 所以"3 小时内提醒 3 次"这类配置会在 specToOffsets 里被直接夹住。
 */
export const MIN_GAP_HOURS = 1;

/** 一条 spec 在当前区间里**最多**能放几次（超过就被夹住）。 */
export function maxTimesFor(spec: Pick<RemindSpec, 'firstHours' | 'lastHours'>): number {
  const span = Math.max(0, spec.firstHours - spec.lastHours);
  return Math.floor(span / MIN_GAP_HOURS) + 1;
}

/**
 * 把「区间 + 次数」展开成具体的提前量。
 *
 * 护栏在这里落地：次数先被夹到 maxTimesFor，再均匀取点、取整、去重。
 * 所以调用方**永远拿到的是合法集合** —— 不需要在下游再检查一遍。
 */
export function specToOffsets(spec: RemindSpec): Offset[] {
  const first = Math.max(1, Math.round(spec.firstHours));
  const last = Math.min(Math.max(0, Math.round(spec.lastHours)), first);
  const span = first - last;
  const n = Math.min(Math.max(1, Math.round(spec.times)), maxTimesFor({ firstHours: first, lastHours: last }));

  if (n === 1) return [{ value: last, unit: 'hour' }];

  const step = span / (n - 1);
  const out: Offset[] = [];
  for (let i = 0; i < n; i += 1) {
    const h = Math.max(0, Math.round(first - step * i));
    // 取整后可能撞车（区间很短时），去重 —— 宁可少一次，也不要同一时刻响两遍
    if (!out.some((o) => o.value === h)) out.push({ value: h, unit: 'hour' });
  }
  return out;
}

/** 预设档位的标识。注意它现在是**预设的键**，不是配置本身 —— 真正的配置是 RemindSpec。 */
export type NotifyLevel = 'loose' | 'standard' | 'tight';

/**
 * 出厂默认值。
 *
 * 刻意**等于升级前的行为**（作业 24h+12h、考试 72h+24h，各 2 次）：
 * "更密"可以是更好的默认，但"升级后行为突变"是更糟的体验 ——
 * 用户已经习惯了这个节奏，要改让他自己在设置里改。
 */
export const DEFAULT_REMIND_SPECS: { task: RemindSpec; exam: RemindSpec } = {
  task: { firstHours: 24, lastHours: 12, times: 2 },
  exam: { firstHours: 72, lastHours: 24, times: 2 },
};

/** 三档预设：点一下就填好两类的区间。它们是"被验证过频率合理"的组合。 */
export const NOTIFY_PRESETS: Record<NotifyLevel, { task: RemindSpec; exam: RemindSpec }> = {
  // 宽松 = 原来的「标准」档（24h/12h、72h/24h）
  loose: {
    task: { firstHours: 24, lastHours: 12, times: 2 },
    exam: { firstHours: 72, lastHours: 24, times: 2 },
  },
  // 标准：提前一天开始，最后一次落在 **2 小时前**，三次
  // 为什么是 2h 而不是 1h：提前 1 小时才响，往往已经来不及做任何事 ——
  // 它只制造焦虑，不提供行动窗口。2 小时是"还来得及"的边界。
  standard: {
    task: { firstHours: 24, lastHours: 2, times: 3 },
    exam: { firstHours: 72, lastHours: 2, times: 3 },
  },
  // 紧凑：更早开始（两天前），同样收到 2 小时前
  tight: {
    task: { firstHours: 48, lastHours: 2, times: 3 },
    exam: { firstHours: 96, lastHours: 2, times: 3 },
  },
};

/**
 * 兼容层：旧代码按「档位 → 提前量数组」查表。
 * 现在由 NOTIFY_PRESETS 推导，保证只有一份真源（否则两处各写一遍必然漂移）。
 */
export const NOTIFY_LEVELS: Record<NotifyLevel, Record<string, Offset[]>> = Object.fromEntries(
  Object.entries(NOTIFY_PRESETS).map(([k, v]) => [
    k,
    { exam: specToOffsets(v.exam), default: specToOffsets(v.task) },
  ]),
) as unknown as Record<NotifyLevel, Record<string, Offset[]>>;

/** 不带档位时的默认值（旧引用保持可用）。 */
export const NOTIFY_OFFSETS = NOTIFY_LEVELS.standard;

/**
 * 用户可配的提醒偏好。存前端，同步时读出来传给这里。
 *
 * `task` / `exam` 是新的区间配置；`level` 只在旧数据里存在（没有 spec 时回落预设）。
 */
export interface NotifyPrefs {
  /** 作业类的区间（作业 / 测验 / 讨论…） */
  task?: RemindSpec;
  /** 考试类的区间 */
  exam?: RemindSpec;
  /** 旧字段：没有 task/exam 时用来回落预设 */
  level?: NotifyLevel;
  /** 每日汇总开关，默认开 */
  daily?: boolean;
  /** 夜间静默顺延开关（默认开）。关掉后提醒按原时间弹，哪怕在深夜 */
  quietEnabled?: boolean;
  /** 静默开始（本地小时，含），默认 22 */
  quietFromHour?: number;
  /** 静默结束（本地小时，不含），默认 8 */
  quietToHour?: number;
  /** 每日汇总的发送小时（本地），默认跟随静默结束 */
  dailyHour?: number;
  /** 每日汇总排未来几天，默认 7（1–14） */
  dailyDays?: number;
}

export interface NotifyScheduleOptions {
  /** 静默时段起（本地小时，含），默认 22 */
  quietFromHour?: number;
  /** 静默时段止（本地小时，不含），默认 8 */
  quietToHour?: number;
  /** 关闭静默顺延（测试用） */
  quiet?: boolean;
  /** 用户偏好（密度档位 / 每日汇总）。缺省 = standard 档 + 每日汇总开 */
  prefs?: NotifyPrefs;
}

const OFFSET_MS: Record<string, number> = { day: DAY_MS, hour: HOUR_MS };

/** 取某一类任务的提前量：优先用用户自己的区间，没有才回落预设档位。 */
function offsetsFor(kind: TaskKind, prefs: NotifyPrefs): Offset[] {
  const spec = kind === 'exam' ? prefs.exam : prefs.task;
  if (spec) return specToOffsets(spec);
  // 没有自己的区间时：有旧 level 就按那个预设，否则用出厂默认。
  // 这两者不能混 —— 预设 standard 现在是更密的那一档，
  // 而什么都不传应该等于升级前的行为。
  if (prefs.level) {
    const preset = NOTIFY_PRESETS[prefs.level] ?? NOTIFY_PRESETS.standard;
    return specToOffsets(kind === 'exam' ? preset.exam : preset.task);
  }
  return specToOffsets(kind === 'exam' ? DEFAULT_REMIND_SPECS.exam : DEFAULT_REMIND_SPECS.task);
}

function mmddhhmm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function windowText(off: Offset): string {
  if (off.unit === 'day') return off.value === 1 ? '还有不到 1 天' : `还有不到 ${off.value} 天`;
  // 内部统一用小时算，但用户不该看到"还有不到 72 小时" —— 能整除就说天
  if (off.value >= 24 && off.value % 24 === 0) {
    const d = off.value / 24;
    return d === 1 ? '还有不到 1 天' : `还有不到 ${d} 天`;
  }
  return `还有不到 ${off.value} 小时`;
}

/**
 * 把时刻挪出静默时段。
 * 返回 null 表示**该丢弃**（挪不动或挪了也没意义）。
 */
function applyQuietHours(
  fire: Date,
  quietFrom: number,
  quietTo: number,
): Date | null {
  const h = fire.getHours();
  const inQuiet = quietFrom > quietTo ? h >= quietFrom || h < quietTo : h >= quietFrom && h < quietTo;
  if (!inQuiet) return fire;
  const shifted = new Date(fire);
  shifted.setMinutes(0, 0, 0);
  if (h >= quietFrom) {
    // 深夜（22、23 点）→ 次日静默结束
    shifted.setDate(shifted.getDate() + 1);
  }
  shifted.setHours(quietTo);
  return shifted;
}

// ---------------------------------------------------------------- 每日汇总

/** 本地日相等。不能用 UTC —— 用户心里的"今天"是本地日。 */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function md(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function hm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 最近一条未来到期的任务。 */
function nextDue(pending: UnifiedTask[], now: Date): { t: UnifiedTask; due: Date } | undefined {
  let best: { t: UnifiedTask; due: Date } | undefined;
  for (const t of pending) {
    const due = effectiveInstant(t.deadline, t.deadlineAt, now);
    if (!due || due.getTime() <= now.getTime()) continue;
    if (!best || due.getTime() < best.due.getTime()) best = { t, due };
  }
  return best;
}

/**
 * 每日汇总 —— 和「截止提醒」是两回事，别混：
 *   截止提醒：某条任务临期时定点响（内容精确，但只有临期那几天才有）
 *   每日汇总：**每天固定一条**，回答"我手上还有多少作业、数据是哪天的"
 *
 * ── 为什么值得单独做（不只是"多一条提醒"）──
 * Android 的 App Standby 分桶按活跃度限制闹钟配额：活跃无限制、
 * 「工作集」每小时 10 次、「常用」2 次、「极少使用」1 次、「受限」**每天 1 次**。
 * 也就是**用户越不打开 App，配额越低** —— 而每日汇总一天只占 1 个配额，
 * 是唯一在「受限」桶下也到得了的形态。
 *
 * ── 措辞为什么分两档（这里最容易做错）──
 * 排期只在**同步那一刻**算一次，之后不自动更新（用户 2026-10-17 定的方案）。
 * 所以越靠后的那几条，被收到时数据越旧。于是：
 *   最近那条（今天剩的 / 明天）：正常措辞，它离同步时刻就差一天以内
 *   更远的那几条：**降级为保守措辞** —— 不说"今天要交"，改说"还有 N 条"，
 *                 并标注"数据截至 X 日"+ 提示去同步
 *
 * 判据是**错误方向**：多报（说"还有 3 条"其实只剩 1 条）无害；
 * **漏报**（说"今天没有"其实有）会让用户错过作业 ——
 * 所以远的那几条绝不下"今天没有"这种断言。
 *
 * 「今天要交几项」是**能精确算的**：某条任务在第 N 天是否到期，
 * 取决于它的截止时间（已知），不取决于数据新旧；
 * 只有"D 日之后新增的任务"看不到 —— 而那部分用户本来也不知道。
 */
function buildDailyDigest(
  tasks: UnifiedTask[],
  now: Date,
  quietTo: number,
  prefs: NotifyPrefs,
): ScheduledNotification[] {
  if (prefs.daily === false) return [];
  const hour = prefs.dailyHour ?? quietTo;
  const span = Math.min(Math.max(Math.round(prefs.dailyDays ?? 7), 1), 14);

  const pending = tasks.filter((t) => isActionable(t));
  const out: ScheduledNotification[] = [];

  for (let i = 0; i <= span; i += 1) {
    const fire = new Date(now);
    fire.setDate(fire.getDate() + i);
    fire.setHours(hour, 0, 0, 0);
    if (fire.getTime() <= now.getTime()) continue; // 今天那条若已过就不排

    const near = i <= 1; // 最近一条用正常措辞
    const dueThatDay = pending
      .map((t) => ({ t, due: effectiveInstant(t.deadline, t.deadlineAt, now) }))
      .filter((x): x is { t: UnifiedTask; due: Date } => Boolean(x.due) && sameLocalDay(x.due!, fire))
      .sort((a, b) => a.due.getTime() - b.due.getTime());

    let title: string;
    let body: string;
    if (pending.length === 0) {
      title = '手上的作业都交完了';
      body = `数据 ${md(now)}`;
    } else if (near && dueThatDay.length > 0) {
      title = `今天要交 ${dueThatDay.length} 项`;
      const shown = dueThatDay
        .slice(0, 2)
        .map((x) => `${x.t.title.slice(0, 12)} ${hm(x.due)}`)
        .join('、');
      body = shown + (dueThatDay.length > 2 ? ` 等 ${dueThatDay.length} 项` : '');
    } else if (near) {
      const next = nextDue(pending, now);
      title = '今天没有要交的';
      body = next
        ? `最近一条：${next.t.title.slice(0, 14)} · ${md(next.due)} ${hm(next.due)}`
        : '手上的作业都交完了';
    } else {
      const next = nextDue(pending, now);
      title = `还有 ${pending.length} 条作业没交`;
      body =
        `数据截至 ${md(now)}（${i} 天前）· 点开同步看最新` +
        (next ? `；最近一条 ${md(next.due)}` : '');
    }

    out.push({
      key: `daily|${dayKey(fire)}|v1`,
      kind: 'daily',
      title,
      body,
      fireAt: fire.toISOString(),
      dueAt: fire.toISOString(),
    });
  }
  return out;
}

/**
 * 纯函数：给定当前全部任务，算出**未来**要弹的通知清单（按触发时刻升序）。
 *
 * @param tasks 全部任务（含手动添加的）。函数自己筛掉不该提醒的。
 * @param now   当前时刻
 */
export function buildNotificationSchedule(
  tasks: UnifiedTask[],
  now: Date,
  opts: NotifyScheduleOptions = {},
): ScheduledNotification[] {
  const prefs = opts.prefs ?? {};
  // 用户偏好优先于调用方默认值：这是设置页里能改的东西
  const quietFrom = prefs.quietFromHour ?? opts.quietFromHour ?? 22;
  const quietTo = prefs.quietToHour ?? opts.quietToHour ?? 8;
  const useQuiet = prefs.quietEnabled !== false && opts.quiet !== false;
  const nowMs = now.getTime();
  const out: ScheduledNotification[] = [];

  for (const task of tasks) {
    if (!isActionable(task)) continue;

    const due = effectiveInstant(task.deadline, task.deadlineAt, now);
    if (!due) continue; // 期限未知无法做时间轴提醒
    const dueMs = due.getTime();
    if (dueMs <= nowMs) continue; // 已逾期：不再打扰（界面上有逾期分组）

    const offsets = offsetsFor(task.kind, prefs);
    /** 同一任务可能有两个窗口被顺延到同一时刻，只保留最宽的那个（文字更准确）。 */
    const byFireMs = new Map<number, ScheduledNotification>();

    // 宽 → 紧 依次处理，先写入的（更宽）在撞车时胜出
    for (const off of offsets) {
      const raw = new Date(dueMs - off.value * OFFSET_MS[off.unit]!);
      let fire = useQuiet ? applyQuietHours(raw, quietFrom, quietTo) : raw;
      if (!fire) continue;
      // 迟到的提醒没有价值：顺延后已经来不及做了
      if (fire.getTime() >= dueMs) continue;
      // 已经过去的窗口不补发
      if (fire.getTime() <= nowMs) continue;

      const text = windowText(off);
      const dKey = deadlineKey(task.deadline);
      byFireMs.set(fire.getTime(), {
        key: `${task.id}|${dKey}|T-${off.value}${off.unit === 'day' ? 'd' : 'h'}`,
        taskId: task.id,
        title: `⏰ ${task.title}`,
        body: `${task.courseName} · ${text}截止（${mmddhhmm(due)}）`,
        fireAt: fire.toISOString(),
        dueAt: due.toISOString(),
      });
    }

    out.push(...byFireMs.values());
  }

  // 每日汇总（每天固定一条）—— 与上面的截止提醒并列，不相干
  out.push(...buildDailyDigest(tasks, now, quietTo, prefs));

  out.sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime());
  return out;
}
