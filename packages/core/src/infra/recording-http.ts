/**
 * 录制型 HTTP 客户端：把经过的请求/响应记成 HAR。
 *
 * 它是「零流量路线」的第一半。用法是包在真实传输外面：
 *
 *   引擎 → 只读守卫 → 限流重试 → [RecordingHttpClient] → fetch → 平台
 *
 * 一轮同步跑完，`toHar()` 就得到一份可回放的抓包文件。三个用途：
 *
 *   1. **首次导入**：用户在平台上正常操作一次，导出的 HAR 就能离线解析出
 *      全部作业 —— 我们从头到尾没有向平台发过一个请求。
 *   2. **适配器开发**：把真实响应固化下来，改解析器时可以反复回放，
 *      不用反复用真实账号去请求（那才是真正容易触发风控的行为）。
 *   3. **回归测试**：平台改版时，把新抓的 HAR 和旧的对比，
 *      能立刻看出是哪几个接口变了。
 *
 * ⚠️ 脱敏是默认行为且不可关闭（只能追加要脱敏的头）：
 * HAR 里天然包含 Cookie 与 Authorization，那是完整登录凭证。
 * 留在文件里等于把账号密码写进一个会被随手转发的 JSON。
 * 回放根本不需要这些头（只需要响应体），所以没有任何理由保留它们。
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import {
  SENSITIVE_REQUEST_HEADERS,
  SENSITIVE_RESPONSE_HEADERS,
  serializeHar,
} from './har.ts';
import type { HarEntry, HarNameValuePair } from './har.ts';

export interface RecordingHttpOptions {
  /**
   * 额外需要脱敏的请求头（小写）。
   * Cookie / Authorization / csrf 类默认必脱敏，这里用于平台特有的敏感头。
   */
  extraRedactHeaders?: string[];
  /** 是否把响应体一起记录（默认 true；关掉则只记录状态与头，无法用于回放） */
  includeBody?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
}

export class RecordingHttpClient implements HttpClient {
  readonly #base: HttpClient;
  readonly #opts: Required<RecordingHttpOptions>;
  readonly #entries: HarEntry[] = [];
  readonly #redactSet: Set<string>;

  constructor(base: HttpClient, opts: RecordingHttpOptions = {}) {
    this.#base = base;
    this.#opts = {
      extraRedactHeaders: (opts.extraRedactHeaders ?? []).map((h) => h.toLowerCase()),
      includeBody: opts.includeBody ?? true,
    };
    this.#redactSet = new Set([...SENSITIVE_REQUEST_HEADERS, ...this.#opts.extraRedactHeaders]);
  }

  get entries(): readonly HarEntry[] {
    return this.#entries;
  }

  /** 已录制的请求数。 */
  get count(): number {
    return this.#entries.length;
  }

  async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await this.#base.request(req, meta);
    } catch (e) {
      // 失败的请求也记录下来 —— 排查「为什么同步失败」时，
      // 知道发过哪些请求比只知道报错更有用。
      this.#entries.push(this.#entry(req, undefined));
      throw e;
    }

    // Response 的 text() 只能读一次，读出来缓存，同时给上层和 HAR 用
    const text = await res.text();

    this.#entries.push(
      this.#entry(req, {
        status: res.status,
        headers: Object.entries(res.headers).map(([name, value]) => ({ name, value })),
        text,
        contentType: res.headers['content-type'],
      }),
    );

    // 重新包一层，保证上层还能再读（底层 Response 已经被消费掉了）
    return {
      status: res.status,
      headers: res.headers,
      url: res.url,
      setCookies: res.setCookies,
      text: async () => text,
      json: async <T>() => JSON.parse(text) as T,
      bytes: async () => new TextEncoder().encode(text),
    };
  }

  #entry(
    req: HttpRequest,
    response: { status: number; headers: HarNameValuePair[]; text: string; contentType?: string } | undefined,
  ): HarEntry {
    const method = (req.method ?? 'GET').toUpperCase();

    const requestHeaders: HarNameValuePair[] = Object.entries(req.headers ?? {})
      .filter(([name]) => !this.#redactSet.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: `<已脱敏 len=${value.length}>` }));

    // body 里也可能有机密（密码登录的表单），统一标记
    let bodyText: string | undefined;
    if (req.body !== undefined) bodyText = typeof req.body === 'string' ? req.body : '<二进制>';
    else if (req.form !== undefined) bodyText = '<表单已脱敏>';
    else if (req.json !== undefined) bodyText = '<JSON 已脱敏>';

    const harResponse = response
      ? {
          status: response.status,
          statusText: '',
          headers: response.headers.filter(
            (h) => !SENSITIVE_RESPONSE_HEADERS.includes(h.name.toLowerCase().trim()),
          ),
          content: this.#opts.includeBody
            ? {
                size: response.text.length,
                mimeType: response.contentType ?? 'application/octet-stream',
                text: response.text,
              }
            : { size: 0, mimeType: 'x-omitted' },
        }
      : { status: 0, statusText: 'REQUEST_FAILED', headers: [], content: { size: 0 } };

    return {
      startedDateTime: new Date().toISOString(),
      request: {
        method,
        url: req.url,
        headers: requestHeaders,
        ...(bodyText !== undefined ? { postData: { text: bodyText } } : {}),
      } as HarEntry['request'],
      response: harResponse,
    };
  }

  /** 导出为 HAR 字符串（已脱敏）。 */
  toHar(): string {
    return serializeHar(this.#entries);
  }

  /** 生成给用户看的摘要：录了哪些接口、各多少次。 */
  summary(): Array<{ method: string; path: string; status: number }> {
    return this.#entries.map((e) => {
      let path = e.request.url;
      try {
        const u = new URL(e.request.url);
        path = `${u.pathname}${u.search}`;
      } catch {
        /* 保留原始串 */
      }
      return { method: e.request.method, path, status: e.response.status };
    });
  }

  /** 供测试与审计：确认没有任何敏感头漏出去。 */
  containsSensitiveHeaders(): boolean {
    const all = this.#entries.flatMap((e) => [
      ...(e.request.headers ?? []),
      ...(e.response.headers ?? []),
    ]);
    return all.some((h) => {
      const n = h.name.toLowerCase();
      return (
        SENSITIVE_REQUEST_HEADERS.includes(n) ||
        SENSITIVE_RESPONSE_HEADERS.includes(n) ||
        this.#redactSet.has(n)
      );
    });
  }
}
