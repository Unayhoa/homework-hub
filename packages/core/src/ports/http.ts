/**
 * HTTP 端口。适配器只依赖这个接口，不直接碰 fetch。
 *
 * 为什么值得多一层：真实项目里你需要给每个平台注入不同的
 * 代理、UA、Cookie 策略、超时、重试、请求日志。把这些放在适配器里
 * 会重复 N 遍，放在这一层只写一遍。
 */
export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** 表单（application/x-www-form-urlencoded） */
  form?: Record<string, string | number | boolean | undefined>;
  /** JSON body */
  json?: unknown;
  /** 原始 body，优先级最高 */
  body?: string | Uint8Array;
  timeoutMs?: number;
  /** 默认 follow；登录重定向检测需要 manual */
  redirect?: 'follow' | 'manual';
}

export interface HttpResponse {
  status: number;
  /** header 名统一小写 */
  headers: Record<string, string>;
  /** 最终 URL（跟随重定向后） */
  url: string;
  /** 响应中的所有 Set-Cookie 原始串（跨重定向会累积多个） */
  setCookies: string[];
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export interface RequestMeta {
  platformId: string;
  /** 用于日志与限流分桶 */
  accountId?: string;
  signal?: AbortSignal;
}

export interface HttpClient {
  request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse>;
}

/** 极简 Cookie 工具：适配器持有 cookie 字典，进出请求时做序列化。 */
export function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** 解析 Set-Cookie，只取 name=value，忽略 Path/HttpOnly 等属性。 */
export function parseSetCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 一个 header 里可能塞了多个 cookie，用逗号分隔（但 Expires 里也有逗号，需排除）
  const parts = header.split(/,(?=\s*[^;=,\s]+\s*=)/);
  for (const part of parts) {
    const first = part.split(';')[0];
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name && !/^(expires|max-age|path|domain|secure|httponly|samesite)$/i.test(name)) {
      out[name] = value;
    }
  }
  return out;
}

export function mergeSetCookies(jar: Record<string, string>, setCookies: string[]): Record<string, string> {
  for (const sc of setCookies) Object.assign(jar, parseSetCookie(sc));
  return jar;
}
