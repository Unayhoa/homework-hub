/** 统一课程模型。课程比任务稳定得多，可以做较长 TTL 缓存，减少对平台的请求量。 */
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
