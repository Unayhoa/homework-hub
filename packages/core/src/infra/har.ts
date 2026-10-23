/**
 * HAR（HTTP Archive）的最小子集与工具。
 *
 * 为什么选 HAR 而不是自造格式：
 *   1. 它是 DevTools「导出 HAR」按钮的直接产物 —— 用户在超星/雨课堂的页面上
 *      按一下就能拿到，不需要装任何东西；
 *   2. Chrome / Edge / Firefox 都支持，格式有事实标准；
 *   3. 它天然包含「请求 + 响应 + 头 + 内容」，足够让适配器离线解析。
 *
 * 这里只声明我们实际用到的字段，其余忽略。
 * 注意 HAR 里**必然包含 Cookie 与 Set-Cookie** —— 这是敏感数据，
 * 所以导出方（RecordingHttpClient）默认会脱敏，见那边的说明。
 */

export interface HarNameValuePair {
  name: string;
  value: string;
}

export interface HarCreator {
  name: string;
  version: string;
}

export interface HarRequest {
  method: string;
  url: string;
  headers?: HarNameValuePair[];
  /** HAR 1.2 里还有 queryString / cookies / postData，这里用不到 */
}

export interface HarContent {
  size?: number;
  mimeType?: string;
  text?: string;
  /** base64（二进制内容） */
  encoding?: 'base64' | 'text';
}

export interface HarResponse {
  status: number;
  statusText?: string;
  headers?: HarNameValuePair[];
  content?: HarContent;
  /** 重定向目标 URL，可用来判断是否发生过跳转 */
  redirectURL?: string;
}

export interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request: HarRequest;
  response: HarResponse;
  /** HAR 1.2 有 pageref / _resourceType 等扩展字段，我们忽略 */
}

export interface HarLog {
  log: {
    version: string;
    creator: HarCreator;
    pages?: unknown[];
    entries: HarEntry[];
  };
}

export const HAR_CREATOR: HarCreator = { name: 'HomeworkHub', version: '0.1.0' };

/**
 * 导出前必须脱敏的头。
 *
 * HAR 的价值在于「离线回放」，而回放只需要响应体 ——
 * 请求头里的 Cookie / Authorization 对回放毫无用处，
 * 却是完整的登录凭证。留在这份文件里等于把账号密码写进了一个
 * 会被随手转发的 JSON。
 */
export const SENSITIVE_REQUEST_HEADERS = ['cookie', 'authorization', 'x-csrftoken', 'x-xsrf-token'];

/** 响应侧需要剥离的头（会泄露会话与用户身份）。 */
export const SENSITIVE_RESPONSE_HEADERS = ['set-cookie', 'authorization'];

function isSensitive(name: string, list: readonly string[]): boolean {
  return list.includes(name.toLowerCase().trim());
}

/** 把一组请求/响应头压成小写键的字典（HAR 存的是 name/value 数组）。 */
export function headerPairsToMap(pairs: HarNameValuePair[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) out[p.name.toLowerCase()] = p.value;
  return out;
}

/** 把响应头拆成「普通头」与 Set-Cookie 列表（HttpResponse 的形态）。 */
export function splitResponseHeaders(pairs: HarNameValuePair[] | undefined): {
  headers: Record<string, string>;
  setCookies: string[];
} {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const p of pairs ?? []) {
    if (p.name.toLowerCase() === 'set-cookie') {
      setCookies.push(p.value);
      continue;
    }
    headers[p.name.toLowerCase()] = p.value;
  }
  return { headers, setCookies };
}

export function serializeHar(entries: HarEntry[]): string {
  const log: HarLog = {
    log: { version: '1.2', creator: HAR_CREATOR, entries },
  };
  return JSON.stringify(log, null, 2);
}

/** 解析 HAR，并在结构明显不对时给出可操作的错误，而不是让上层 undefined 到处飞。 */
export function parseHar(json: string): HarEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`无法解析 HAR 文件（不是合法 JSON）：${(e as Error).message}`);
  }
  const log = (parsed as { log?: { entries?: unknown } }).log;
  if (!log || !Array.isArray(log.entries)) {
    throw new Error(
      '这不是 HAR 文件（缺少 log.entries）。' +
        '请在浏览器 DevTools 的 Network 面板里右键 →「Save all as HAR with content」导出。',
    );
  }
  return log.entries as HarEntry[];
}

/** 去掉 hash 与末尾斜杠，用于请求匹配。 */
export function normalizeUrlForMatching(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url.split('#')[0] ?? url;
  }
}

/** 只取 origin + path（不含 query），作为精确匹配失败后的兜底键。 */
export function urlPathKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}
