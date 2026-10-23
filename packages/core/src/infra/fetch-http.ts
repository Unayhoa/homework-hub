/**
 * HTTP 客户端实现（基于 Node 内置 fetch）。
 *
 * 这个文件里有两处「不得不自己写」的细节：
 *
 * 1. 手动跟随重定向。
 *    Node fetch 自动跟随重定向时，中间跳转收到的 Set-Cookie 会被丢掉，
 *    而超星/雨课堂的登录链路恰恰是「POST 登录 → 302 到主页 → 主页下发会话 cookie」。
 *    自动跟随会拿到一个「登录成功但没有会话」的诡异状态，所以必须自己接管。
 *
 * 2. 跨请求累积 Cookie。
 *    我们把 cookie 字典交给适配器持有（存在 Session 里），
 *    这里只负责把本次响应里的 Set-Cookie 全部收集起来返回，
 *    由适配器决定哪些要持久化 —— 因为有的平台会下发一堆分析用的无关 cookie。
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import { netError } from '../domain/errors.ts';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Node 20+ 才有 headers.getSetCookie()，这里做兼容降级。 */
function readSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function buildBody(req: HttpRequest): { body?: BodyInit; contentType?: string } {
  if (req.body !== undefined) return { body: req.body as BodyInit };
  if (req.json !== undefined) {
    return { body: JSON.stringify(req.json), contentType: 'application/json' };
  }
  if (req.form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) {
      if (v === undefined) continue;
      params.append(k, String(v));
    }
    return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  return {};
}

export interface FetchHttpOptions {
  /** 默认请求头，比如统一 UA */
  defaultHeaders?: Record<string, string>;
  defaultTimeoutMs?: number;
  /** 调试用：打印每个请求（含重定向链）。会泄露 cookie，仅本地调试开启。 */
  trace?: boolean;
}

export class FetchHttpClient implements HttpClient {
  readonly #opts: FetchHttpOptions;

  constructor(opts: FetchHttpOptions = {}) {
    this.#opts = opts;
  }

  async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
    const { body, contentType } = buildBody(req);
    const headers: Record<string, string> = {
      // 默认 UA 用真实的 Chrome UA。很多高校平台对未知 UA 直接返回
      // 一个「请使用推荐浏览器」的静态页面，解析器会莫名其妙地拿到 0 条数据。
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      ...this.#opts.defaultHeaders,
      ...req.headers,
    };
    if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = contentType;
    }

    const timeoutMs = req.timeoutMs ?? this.#opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const collectedCookies: string[] = [];
    let currentUrl = req.url;
    // 用 string 而不是字面量联合：重定向后方法会变成 GET，
    // 且这里还要显式判断 HEAD（HttpRequest.method 的联合类型里没有 HEAD）。
    let method: string = req.method ?? 'GET';
    let currentBody: BodyInit | undefined = body;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (meta.signal?.aborted) throw new Error('请求已取消');

        const signal = meta.signal ?? AbortSignal.timeout(timeoutMs);
        const res = await fetch(currentUrl, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : currentBody,
          redirect: 'manual',
          signal,
        });

        collectedCookies.push(...readSetCookies(res.headers));
        if (this.#opts.trace) {
          console.error(`[http] ${method} ${currentUrl} -> ${res.status}`);
        }

        const isRedirect = res.status >= 300 && res.status < 400;
        const location = res.headers.get('location');
        if (!isRedirect || !location || req.redirect === 'manual') {
          return this.#wrap(res, collectedCookies, currentUrl);
        }

        // 302 转 GET 是浏览器的既定行为，很多登录流程依赖这一点
        currentUrl = new URL(location, currentUrl).toString();
        if (res.status === 303 || (res.status === 301 && method === 'POST') || res.status === 302) {
          method = 'GET';
          currentBody = undefined;
        }
      }
      throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，可能存在登录死循环`);
    } catch (e) {
      throw netError(meta.platformId, e);
    }
  }

  #wrap(res: Response, setCookies: string[], finalUrl: string): HttpResponse {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      headers,
      url: finalUrl,
      setCookies,
      text: () => res.text(),
      json: async <T>() => (await res.json()) as T,
      bytes: async () => new Uint8Array(await res.arrayBuffer()),
    };
  }
}
