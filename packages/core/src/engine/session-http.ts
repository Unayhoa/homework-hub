/**
 * 会话感知的 HTTP 封装 —— 所有适配器共用的基础设施。
 *
 * 把「带 cookie 发请求 → 收 Set-Cookie → 合并回会话」这套动作收在一处，
 * 否则每个适配器都要写一遍，而且必然有人漏掉合并那一步，
 * 表现为「登录成功但第二次请求就 401」这种极难排查的 bug。
 */
import type { AdapterContext } from '../ports/adapter.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../ports/http.ts';
import { mergeSetCookies, serializeCookies } from '../ports/http.ts';
import type { Session } from '../ports/vault.ts';
import { HubError } from '../domain/errors.ts';

export interface JsonResult<T> {
  status: number;
  body: T;
  raw: HttpResponse;
}

export class SessionHttpClient {
  readonly #ctx: AdapterContext;
  readonly #session: Session;
  readonly #platformId: string;
  readonly #accountId: string;

  constructor(ctx: AdapterContext, session: Session) {
    this.#ctx = ctx;
    this.#session = session;
    this.#platformId = session.platformId;
    this.#accountId = session.accountId;
  }

  get session(): Session {
    return this.#session;
  }

  /** 会话 cookie 是否发生过变化（用于决定是否需要重新落盘）。 */
  #cookieSnapshot = '';

  snapshotCookies(): void {
    this.#cookieSnapshot = JSON.stringify(this.#session.cookies);
  }

  cookiesChanged(): boolean {
    return this.#cookieSnapshot !== JSON.stringify(this.#session.cookies);
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...this.#session.headers, ...req.headers };
    const cookieHeader = serializeCookies(this.#session.cookies);
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const client: HttpClient = this.#ctx.http;
    const res = await client.request({ ...req, headers }, {
      platformId: this.#platformId,
      accountId: this.#accountId,
    });

    if (res.setCookies.length > 0) {
      mergeSetCookies(this.#session.cookies, res.setCookies);
    }
    return res;
  }

  /**
   * 发请求并解析 JSON。
   *
   * 这里的 401/403 处理是关键：不同平台对「未登录」的返回码不一致
   * （有的 401，有的 200 + 业务错误码，有的直接重定向到登录页），
   * 所以适配器可以传 `onUnauthorized` 来自定义判定。
   */
  async json<T>(req: HttpRequest, opts: { onUnauthorized?: (res: HttpResponse, body: unknown) => boolean } = {}): Promise<JsonResult<T>> {
    const raw = await this.request(req);
    const text = await raw.text();

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // 返回了 HTML —— 大概率是被风控拦到了验证码页或登录页。
      // 直接把片段放进错误信息里，这是排查线上问题的关键线索。
      if (raw.status === 401 || raw.status === 403) {
        throw new HubError('AUTH_REQUIRED', `${this.#platformId} 返回 ${raw.status}，需要重新登录`, {
          platformId: this.#platformId,
          requiresUserAction: true,
        });
      }
      if (/login|登录|verify|验证|captcha/i.test(text.slice(0, 2000))) {
        throw new HubError('CAPTCHA_REQUIRED', `${this.#platformId} 疑似返回登录/验证页面`, {
          platformId: this.#platformId,
          requiresUserAction: true,
        });
      }
      throw new HubError('UPSTREAM', `${this.#platformId} 返回非 JSON 内容：${text.slice(0, 200)}`, {
        platformId: this.#platformId,
      });
    }

    if (opts.onUnauthorized?.(raw, body)) {
      throw new HubError('AUTH_REQUIRED', `${this.#platformId} 业务层返回未登录`, {
        platformId: this.#platformId,
        requiresUserAction: true,
      });
    }

    if (raw.status === 401 || raw.status === 403) {
      throw new HubError('AUTH_REQUIRED', `${this.#platformId} 返回 ${raw.status}，需要重新登录`, {
        platformId: this.#platformId,
        requiresUserAction: true,
      });
    }

    return { status: raw.status, body: body as T, raw };
  }

  async postForm<T>(url: string, form: Record<string, string | number | boolean | undefined>, opts?: { headers?: Record<string, string>; onUnauthorized?: (res: HttpResponse, body: unknown) => boolean }): Promise<JsonResult<T>> {
    return this.json<T>(
      {
        url,
        method: 'POST',
        form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...opts?.headers },
      },
      opts,
    );
  }

  async getJson<T>(url: string, opts?: { headers?: Record<string, string>; onUnauthorized?: (res: HttpResponse, body: unknown) => boolean }): Promise<JsonResult<T>> {
    return this.json<T>({ url, method: 'GET', headers: opts?.headers }, opts);
  }
}
