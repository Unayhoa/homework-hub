/**
 * 提醒调度引擎。
 *
 * 表面上是「截止前 2 小时提醒我」，实际要解决三个问题：
 *
 * 问题 1｜幂等。同步每 30 分钟跑一次，如果只按「是否进入 24 小时窗口」判断，
 *   用户会在一天内被提醒 48 次。所以每个提醒有唯一 key = (任务, 规则, 触发窗口)，
 *   发过就记档。
 *
 * 问题 2｜改期。老师把截止时间从周五改到下周一，旧提醒已失效，新提醒必须能发。
 *   把截止时间的归一化值编进 key，改期后 key 自然不同，不需要额外的重置逻辑。
 *
 * 问题 3｜补发风暴。一个作业是昨天晚上发的、今晚就截止，而用户今天才第一次同步。
 *   此时 T-7d、T-1d、T-3h 三个窗口全都「已满足」，如果逐个补发，
 *   用户会瞬间收到三条重复通知。所以每轮每任务最多只发「最紧的那一条」，
 *   并把更宽松的窗口一起标记为已消费。
 */
import type { DeadlineUnit } from '../domain/deadline.ts';
import { deadlineKey, effectiveInstant } from '../domain/deadline.ts';
import { makeReminderKey } from '../domain/ids.ts';
import { isActionable } from '../domain/task.ts';
import type { TaskKind, UnifiedTask } from '../domain/task.ts';

export interface ReminderRule {
  id: string;
  label: string;
  /** 适用的任务类型；空数组表示全部 */
  kinds: TaskKind[];
  /** 提前量列表，按「从宽到紧」排列更易读，但代码不依赖顺序 */
  offsets: Array<{ value: number; unit: DeadlineUnit }>;
  /** 同一规则内，低于此优先级的任务不提醒（预留：可按课程权重过滤） */
  minScoreRatio?: number;
}

const DAY = { unit: 'day' as DeadlineUnit };
const HOUR = { unit: 'hour' as DeadlineUnit };

/** 默认规则集：考试更早提醒，作业稍晚。可在设置里覆盖。 */
export const DEFAULT_REMINDER_RULES: ReminderRule[] = [
  {
    id: 'exam',
    label: '考试提醒',
    kinds: ['exam'],
    offsets: [
      { value: 7, ...DAY },
      { value: 3, ...DAY },
      { value: 1, ...DAY },
      { value: 2, ...HOUR },
    ],
  },
  {
    id: 'homework',
    label: '作业提醒',
    kinds: ['homework', 'quiz'],
    offsets: [
      { value: 2, ...DAY },
      { value: 1, ...DAY },
      { value: 3, ...HOUR },
      { value: 1, ...HOUR },
    ],
  },
  {
    id: 'task-point',
    label: '任务点提醒',
    kinds: ['task-point', 'discussion'],
    offsets: [
      { value: 3, ...DAY },
      { value: 1, ...DAY },
    ],
  },
];

const UNIT_MS: Record<DeadlineUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export interface PlannedReminder {
  key: string;
  taskId: string;
  accountId: string;
  platformId: string;
  ruleId: string;
  /** 例如 'T-1d' */
  windowId: string;
  title: string;
  body: string;
  /** 计划发送时刻（本轮同步时刻，因为提醒是同步后批量投递的） */
  fireAt: string;
  dueAt: string;
  /** 本次同步一并消费掉的其他窗口 key，防止后续补发 */
  consumedKeys: string[];
}

export interface PlanRemindersOptions {
  rules?: ReminderRule[];
  /** 已发送过的 reminder key */
  sentKeys: Set<string>;
  /** 是否包含已逾期但未完成的任务（默认 true，逾期提醒同样重要） */
  includeOverdue?: boolean;
  /** 逾期多少天后不再提醒，防老任务刷屏 */
  overdueGraceDays?: number;
}

function windowId(value: number, unit: DeadlineUnit): string {
  const suffix = unit === 'day' ? 'd' : unit === 'hour' ? 'h' : 'm';
  return `T-${value}${suffix}`;
}

/**
 * 纯函数：给定任务集合与已发送记录，算出本轮该发哪些提醒。
 * 不访问数据库、不发送通知 —— 便于测试。
 */
export function planReminders(
  tasks: UnifiedTask[],
  now: Date,
  opts: PlanRemindersOptions,
): PlannedReminder[] {
  const rules = opts.rules ?? DEFAULT_REMINDER_RULES;
  const includeOverdue = opts.includeOverdue ?? true;
  const overdueGraceMs = (opts.overdueGraceDays ?? 3) * UNIT_MS.day;
  const planned: PlannedReminder[] = [];

  for (const task of tasks) {
    if (!isActionable(task)) continue;

    // 用锚定后的时刻，而不是「当前时刻 + 相对时长」——
    // 否则「还剩 3 天」的任务永远进不了任何提醒窗口。
    const due = effectiveInstant(task.deadline, task.deadlineAt, now);
    // open / unknown 的截止时间无法做时间轴提醒。
    // 这类任务改由「新任务即时通知」覆盖，不在这里处理。
    if (!due) continue;

    const remainMs = due.getTime() - now.getTime();
    if (remainMs < 0) {
      if (!includeOverdue) continue;
      if (-remainMs > overdueGraceMs) continue;
    }

    const applicable = rules.filter((r) => r.kinds.length === 0 || r.kinds.includes(task.kind));
    const dKey = deadlineKey(task.deadline);

    // 收集所有「已进入窗口」的 (规则, 窗口)
    type Candidate = { rule: ReminderRule; value: number; unit: DeadlineUnit; remainAtThreshold: number; key: string; window: string };
    const candidates: Candidate[] = [];

    for (const rule of applicable) {
      for (const off of rule.offsets) {
        const thresholdMs = off.value * UNIT_MS[off.unit];
        if (remainMs > thresholdMs) continue; // 还没到
        const window = windowId(off.value, off.unit);
        candidates.push({
          rule,
          value: off.value,
          unit: off.unit,
          remainAtThreshold: thresholdMs,
          window,
          key: makeReminderKey(task.id, `${rule.id}:${window}`, dKey),
        });
      }
    }

    const unsent = candidates.filter((c) => !opts.sentKeys.has(c.key));
    if (unsent.length === 0) continue;

    // 取「最紧」的一条：阈值最小的窗口离截止最近。
    unsent.sort((a, b) => a.remainAtThreshold - b.remainAtThreshold);
    const chosen = unsent[0]!;
    const consumed = unsent.filter((c) => c !== chosen).map((c) => c.key);

    planned.push({
      key: chosen.key,
      taskId: task.id,
      accountId: task.accountId,
      platformId: task.platformId,
      ruleId: chosen.rule.id,
      windowId: chosen.window,
      title: buildTitle(task, chosen.window),
      body: buildBody(task, remainMs, now),
      fireAt: now.toISOString(),
      dueAt: due.toISOString(),
      consumedKeys: consumed,
    });
  }

  return planned;
}

function kindLabel(kind: TaskKind): string {
  switch (kind) {
    case 'exam':
      return '考试';
    case 'homework':
      return '作业';
    case 'quiz':
      return '测验';
    case 'task-point':
      return '任务点';
    case 'discussion':
      return '讨论';
    default:
      return '待办';
  }
}

function buildTitle(task: UnifiedTask, window: string): string {
  const prefix = window.startsWith('T-') ? `【${window.slice(2)}】` : '';
  return `${prefix}${kindLabel(task.kind)}：${task.title}`;
}

function buildBody(task: UnifiedTask, remainMs: number, now: Date): string {
  const overdue = remainMs < 0;
  const abs = Math.abs(remainMs);
  const d = Math.floor(abs / UNIT_MS.day);
  const h = Math.floor((abs % UNIT_MS.day) / UNIT_MS.hour);
  const m = Math.floor((abs % UNIT_MS.hour) / UNIT_MS.minute);

  let timeText: string;
  if (d > 0) timeText = `${d} 天${h > 0 ? ` ${h} 小时` : ''}`;
  else if (h > 0) timeText = `${h} 小时${m > 0 ? ` ${m} 分钟` : ''}`;
  else timeText = `${Math.max(m, 1)} 分钟`;

  const line = overdue ? `已逾期 ${timeText}` : `还剩 ${timeText}`;
  const due = effectiveInstant(task.deadline, task.deadlineAt, now);
  const dueText = due ? `（${due.toLocaleString('zh-CN')} 截止）` : '';
  return `${task.courseName} · ${line}${dueText}`;
}
