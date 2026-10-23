/**
 * 截止时间归一化。
 *
 * 这是整个项目里最脏、也最值得单独写一层的地方。
 * 各平台对「什么时候截止」的表达方式完全不同：
 *
 *   超星   : `2026-09-25 23:59`            绝对时间
 *   雨课堂 : `endTime: 1758815940000`       epoch 毫秒
 *   雨课堂 : `'还剩 3 天'`                   相对时长
 *   iSmart : 只给 `3` 秒的剩余秒数           纯数字
 *   教务   : `第 4 周 周五 第 3-4 节`         学期周次坐标 → 需要学期日历换算
 *   各种   : `未公布` / `不限时` / 空字符串    开放态
 *
 * 如果不在入口处归一化，后面每一层都要写 if-else，最终必然漏掉某个平台。
 */

export type DeadlineUnit = 'minute' | 'hour' | 'day';

export type Deadline =
  /** 明确的绝对时刻 */
  | { kind: 'absolute'; at: string; raw?: string }
  /** 相对剩余时长（服务器返回时刻已知时也能立刻算成绝对时间） */
  | { kind: 'relative'; value: number; unit: DeadlineUnit; raw?: string }
  /** 显式无期限 / 不限制 */
  | { kind: 'open'; raw?: string }
  /** 平台给了东西但我们看不懂 —— 必须保留 raw 以便排查，不能静默吞掉 */
  | { kind: 'unknown'; raw?: string };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const OPEN_PATTERNS = /^(不限|不限时|无期限|未公布|待定|长期|--|-|—|null|undefined|n\/a)$/i;
const RELATIVE_PATTERN = /(?:还剩|剩余|剩)\s*(\d+(?:\.\d+)?)\s*(天|日|小时|時|时|分钟|分)/;
const RELATIVE_TRAILING_PATTERN = /^(\d+(?:\.\d+)?)\s*(天|日|小时|時|时|分钟|分)$/;
/** 支持 2026-09-25 23:59 / 2026/9/25 23:59:00 / 2026.09.25 / ISO8601 */
const ABSOLUTE_PATTERN =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

function unitOf(label: string): DeadlineUnit {
  if (label === '天' || label === '日') return 'day';
  if (label === '小时' || label === '時' || label === '时') return 'hour';
  return 'minute';
}

/** 把相对时长尽量折算成绝对时刻，折算不了才保留 relative。 */
function relativeToAbsolute(value: number, unit: DeadlineUnit, now: Date): string | undefined {
  const ms = unit === 'day' ? value * DAY_MS : unit === 'hour' ? value * HOUR_MS : value * MINUTE_MS;
  const at = new Date(now.getTime() + ms);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toISOString();
}

/**
 * @param raw  平台原始值（string | number | Date | null | undefined）
 * @param now  当前时刻，由 Clock 注入 —— 不要把 Date.now() 写死在里面，
 *             否则单元测试没法构造「临界时刻」场景。
 */
export function normalizeDeadline(raw: unknown, now: Date): Deadline {
  if (raw === null || raw === undefined) return { kind: 'unknown' };

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? { kind: 'unknown', raw: String(raw) }
      : { kind: 'absolute', at: raw.toISOString() };
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return { kind: 'unknown', raw: String(raw) };
    // 秒级 / 毫秒级 / 纯剩余秒数 三种，用数量级区分
    if (raw > 1e12) return { kind: 'absolute', at: new Date(raw).toISOString() };
    if (raw > 1e9) return { kind: 'absolute', at: new Date(raw * 1000).toISOString() };
    const at = relativeToAbsolute(raw, 'minute', now);
    return at ? { kind: 'relative', value: raw, unit: 'minute', raw: String(raw) } : { kind: 'unknown', raw: String(raw) };
  }

  const text = String(raw).trim();
  if (text === '') return { kind: 'unknown' };
  if (OPEN_PATTERNS.test(text)) return { kind: 'open', raw: text };

  const rel = RELATIVE_PATTERN.exec(text) ?? RELATIVE_TRAILING_PATTERN.exec(text);
  if (rel?.[1] && rel[2]) {
    const value = Number(rel[1]);
    const unit = unitOf(rel[2]);
    return { kind: 'relative', value, unit, raw: text };
  }

  // 显式带时区的 ISO 串（…Z / …+08:00）必须信任其自带的时区，
  // 不能落入下面的「本地墙上时间」分支 —— 否则 UTC+8 用户的 epoch 毫秒
  // 转出来的 ISO 会被再按本地时间解释一次，整体偏移时区（真机踩过：20:00 显示成 12:00）。
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const at = new Date(text);
    if (!Number.isNaN(at.getTime())) return { kind: 'absolute', at: at.toISOString(), raw: text };
  }

  const abs = ABSOLUTE_PATTERN.exec(text);
  if (abs) {
    const [, y, mo, d, h, mi, s] = abs;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = h === undefined ? 23 : Number(h);
    const minute = h === undefined ? 59 : Number(mi);
    const second = s === undefined ? 0 : Number(s);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // 平台给的是「用户所在时区的墙上时间」，所以按本地时间构造。
      // 不要用 Date.UTC()，否则 UTC+8 用户会整体偏移 8 小时。
      const at = new Date(year, month - 1, day, hour, minute, second);
      if (!Number.isNaN(at.getTime())) return { kind: 'absolute', at: at.toISOString(), raw: text };
    }
  }

  return { kind: 'unknown', raw: text };
}

/** 折算成可比大小的绝对时刻；open/unknown 返回 null。 */
export function deadlineInstant(d: Deadline, now: Date): Date | null {
  if (d.kind === 'absolute') {
    const at = new Date(d.at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (d.kind === 'relative') {
    const ms = d.unit === 'day' ? d.value * DAY_MS : d.unit === 'hour' ? d.value * HOUR_MS : d.value * MINUTE_MS;
    return new Date(now.getTime() + ms);
  }
  return null;
}

export function msUntil(d: Deadline, now: Date): number | null {
  const at = deadlineInstant(d, now);
  return at ? at.getTime() - now.getTime() : null;
}

/**
 * 取「生效的绝对时刻」。
 *
 * 为什么需要锚点：有些平台只给倒计时（「还剩 3 天」）。
 * 如果每次都按「当前时刻 + 3 天」重新解释，这个任务永远到不了期 ——
 * 第五天看它还是「还剩 3 天」，提醒永远不会触发，排序也永远是最后。
 * 所以首次观测时把它锚定成一个绝对时刻，之后一直沿用。
 *
 * 绝对型截止时间永远以它自己为准，锚点对它无效 ——
 * 这样即使 deadlineAt 因为某种原因变陈旧，也不会影响判断。
 *
 * @param anchor 首次观测时锚定的 ISO 时刻（UnifiedTask.deadlineAt）
 */
export function effectiveInstant(d: Deadline, anchor: string | undefined, now: Date): Date | null {
  if (d.kind === 'absolute') {
    const t = new Date(d.at).getTime();
    return Number.isFinite(t) ? new Date(t) : null;
  }
  if (d.kind === 'relative' && anchor) {
    const t = new Date(anchor).getTime();
    if (Number.isFinite(t)) return new Date(t);
  }
  return deadlineInstant(d, now);
}

export function formatEffective(d: Deadline, anchor: string | undefined, now: Date): string {
  if (d.kind === 'open') return '不限时';
  if (d.kind === 'unknown') return d.raw ? `截止未知（原始值：${d.raw}）` : '截止未知';
  const at = effectiveInstant(d, anchor, now);
  if (!at) return '截止未知';
  const ms = at.getTime() - now.getTime();
  const text = ms >= 0 ? `还剩 ${humanizeCountdown(ms)}` : `已逾期 ${humanizeCountdown(ms)}`;
  // 相对时长被锚定时，把锚定结果也显示出来，用户才知道到底哪天截止
  return d.kind === 'relative' ? `${text}（锚定 ${at.toLocaleString('zh-CN')}）` : text;
}

/** 人类可读的倒计时，UI 与提醒文案共用，保证口径一致。 */
export function humanizeCountdown(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE_MS) return '不到 1 分钟';
  if (abs < HOUR_MS) return `${Math.floor(abs / MINUTE_MS)} 分钟`;
  if (abs < DAY_MS) {
    const h = Math.floor(abs / HOUR_MS);
    const m = Math.floor((abs % HOUR_MS) / MINUTE_MS);
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(abs / DAY_MS);
  const h = Math.floor((abs % DAY_MS) / HOUR_MS);
  return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
}

export function formatCountdown(d: Deadline, now: Date): string {
  if (d.kind === 'open') return '不限时';
  if (d.kind === 'unknown') return d.raw ? `截止未知（原始值：${d.raw}）` : '截止未知';
  const ms = msUntil(d, now);
  if (ms === null) return '截止未知';
  return ms >= 0 ? `还剩 ${humanizeCountdown(ms)}` : `已逾期 ${humanizeCountdown(ms)}`;
}

export function deadlineKey(d: Deadline): string {
  if (d.kind === 'absolute') return d.at;
  if (d.kind === 'relative') return `rel:${d.value}${d.unit}`;
  return d.kind;
}
