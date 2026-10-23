/**
 * 提醒偏好（用户在设置页配的那几项）的读写。
 *
 * ── 为什么单独成文件 ──
 * 配置的**键名与默认值必须只有一处定义**。前端写、引擎读，
 * 如果两边各硬编码一次，就必然漂移 —— 这个项目已经吃过一次同类的亏
 * （"两份平台清单"那回）。所以键名、默认值、合法范围全在这里。
 *
 * ── 为什么只做"纯的"部分 ──
 * 这里不直接碰 `localStorage`：core 要能在 Node、CLI 和测试里跑。
 * 存储由调用方传进来（`PrefsStorage` 只是个结构约束，WebStorage 天然满足）。
 */
import { DEFAULT_REMIND_SPECS } from './notify-schedule.ts';
import type { NotifyLevel, NotifyPrefs, RemindSpec } from './notify-schedule.ts';

/** 存储键。前端不直接用它 —— 走 `/api/settings`，免得又多一处硬编码。 */
export const NOTIFY_PREFS_KEY = 'hh_notify_prefs';

const LEVELS: NotifyLevel[] = ['loose', 'standard', 'tight'];

export const DEFAULT_NOTIFY_PREFS: Required<NotifyPrefs> = {
  level: 'standard',
  // 默认值刻意**保持升级前的行为**（作业 24h+12h、考试 72h+24h，各 2 次）。
  // 调得更密可以是"更好的默认"，但"升级后行为突变"是更糟的体验 ——
  // 用户已经习惯了这个节奏，要改让他自己改。
  task: DEFAULT_REMIND_SPECS.task,
  exam: DEFAULT_REMIND_SPECS.exam,
  daily: true,
  dailyHour: 8,
  dailyDays: 7,
};

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 收敛一个区间配置。
 *
 * 这里只做**合法化**（数字、范围），不做"次数是否合理"的夹取 ——
 * 那是 specToOffsets 的活。两处分工会有一个后果：界面上可能存着
 * "3 小时内 3 次"，但排期时会被夹成 2 次。所以界面必须自己用 maxTimesFor 提示，
 * 否则用户会以为存进去什么就会按什么提醒。
 */
function normalizeSpec(raw: unknown, def: RemindSpec): RemindSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d;
  };
  const firstHours = num(o.firstHours, def.firstHours, 1, 24 * 30);
  const lastHours = num(o.lastHours, def.lastHours, 0, firstHours);
  return { firstHours, lastHours, times: num(o.times, def.times, 1, 3) };
}

/**
 * 把任意输入收敛成一份**可用**的偏好。
 *
 * 用户改的、旧版本留下的、手改过存储的 —— 一律从这里过。
 * 任何一项不认识就回落默认，**绝不因为一个坏字段让整条提醒链路瘫掉**
 * （静默失效在这里的代价特别高：用户会以为"提醒开了"，其实一条都不会来）。
 */
export function normalizeNotifyPrefs(raw: unknown): Required<NotifyPrefs> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const level = LEVELS.includes(o.level as NotifyLevel)
    ? (o.level as NotifyLevel)
    : DEFAULT_NOTIFY_PREFS.level;

  const hourNum = Number(o.dailyHour);
  const dailyHour = Number.isFinite(hourNum)
    ? Math.min(Math.max(Math.round(hourNum), 0), 23)
    : DEFAULT_NOTIFY_PREFS.dailyHour;

  const daysNum = Number(o.dailyDays);
  const dailyDays = Number.isFinite(daysNum)
    ? Math.min(Math.max(Math.round(daysNum), 1), 14)
    : DEFAULT_NOTIFY_PREFS.dailyDays;

  return {
    level,
    task: normalizeSpec(o.task, DEFAULT_NOTIFY_PREFS.task),
    exam: normalizeSpec(o.exam, DEFAULT_NOTIFY_PREFS.exam),
    daily: o.daily === undefined ? DEFAULT_NOTIFY_PREFS.daily : Boolean(o.daily),
    dailyHour,
    dailyDays,
  };
}

/** 读。存储缺失 / 内容损坏 / 读抛错 —— 一律回落默认，不抛。 */
export function readNotifyPrefs(storage?: PrefsStorage): Required<NotifyPrefs> {
  if (!storage) return { ...DEFAULT_NOTIFY_PREFS };
  try {
    const raw = storage.getItem(NOTIFY_PREFS_KEY);
    return normalizeNotifyPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS };
  }
}

/** 写。返回**归一化之后**的值 —— 调用方应当用返回值刷新界面，而不是回显自己传进来的。 */
export function writeNotifyPrefs(storage: PrefsStorage, raw: unknown): Required<NotifyPrefs> {
  // **部分更新**，不是整体替换。
  //
  // 真机踩过（2026-10-23）：设置页每次只发**改动的那几项**（改每日汇总就发 dailyHour，
  // 改提醒密度就发 level/task/exam）。而 normalize 会把缺失字段一律填成默认值 ——
  // 于是"改完每日汇总 21:00，再去改提醒密度"会把 dailyHour 打回 8:00。
  // 用户看到的是"另一个设置自己恢复了默认"，很难联想到是保存语义的问题。
  //
  // 所以先读当前值，再让 patch 覆盖它。`normalizeNotifyPrefs` 仍然负责兜底与夹取，
  // 只是输入从"裸 patch"变成了"当前值 + patch"。
  const prev = readNotifyPrefs(storage);
  const patch = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const next = normalizeNotifyPrefs({ ...prev, ...patch });
  try {
    storage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(next));
  } catch {
    // 写不进去（隐私模式 / 配额满）不该让功能崩：只是这次修改没留住
  }
  return next;
}

/** 档位 → 中文名（界面与通知文案共用，避免两处各写一份）。 */
export const NOTIFY_LEVEL_LABELS: Record<NotifyLevel, string> = {
  loose: '宽松',
  standard: '标准',
  tight: '紧凑',
};
