/**
 * CDP（Chrome DevTools Protocol）附着型传输：借用用户**已经登录**的浏览器发请求。
 *
 * ─────────────────────────────────────────────────────────────
 * 这是「不影响正常登录状态」这条路上工程上最优雅的一条：
 *
 *   引擎 → 只读守卫 → 限流重试 → [CdpHttpClient] → WebSocket → 你的浏览器 → 平台
 *
 * 请求是从用户自己的浏览器标签页里发出的，用的是浏览器自己的会话。
 * 我们：
 *   - 不创建任何新会话（不会有「新设备登录」提示，不会顶掉任何客户端）
 *   - 不接触、不存储任何凭证 —— cookie 根本不经过我们，
 *     浏览器自动附带，我们连读都读不到（HttpOnly 对页面 JS 不可见）
 *   - 请求的频率/节奏完全由我们控制，但身份 100% 是用户本人
 *
 * 这也是 iSmart 这类「客户端是套壳 Chromium」的平台唯一现实的只读路径 ——
 * 社区的 iSmartAuto 就是这么发现客户端可以加 --remote-debugging-port 的。
 * 区别在于：他们用它提交答案，我们只用它读取作业。
 * ─────────────────────────────────────────────────────────────
 *
 * 两个必须想清楚的坑：
 *
 *   坑 1｜CORS。请求是在页面上下文里 fetch 的，所以只能到达
 *          「那个页面自己也能到达」的接口。如果你附着到了错误的标签页，
 *          请求会被浏览器拦掉 —— 而且 fetch 的 CORS 失败会静默返回空，
 *          这正是本项目最忌讳的「静默返回空」。
 *          对策：pickTargetForOrigin() 按请求的 origin 自动挑标签页，
 *          挑不到就显式报错并告诉用户该打开哪个页面。
 *
 *   坑 2｜HttpOnly。这是优点也是边界：因为 cookie 对页面 JS 不可见，
 *          我们也读不到它（好事，凭据不过手）；
 *          但这也意味着「登录态是否有效」只能靠响应状态码判断，
 *          不能靠读 cookie 过期时间。
 *
 * 用户的准备工作（一次性）：
 *   给浏览器快捷方式加 --remote-debugging-port=9222，正常登录平台，保持标签页开着。
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import { HubError, describe, netError } from '../domain/errors.ts';
import { splitResponseHeaders } from './har.ts';

// ---------------------------------------------------------------- CDP 报文（纯函数，可独立测试）

/** CDP 目标（一个可附着的标签页 / 页面）。 */
export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

export interface PageFetchConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * 构造在页面里执行的表达式。
 *
 * 用 JSON.stringify 注入参数而不是字符串拼接 ——
 * URL 和头里可能有引号、换行，拼接必然产生注入或语法错误。
 */
export function buildPageFetchExpression(req: PageFetchConfig): string {
  const cfg = JSON.stringify({
    url: req.url,
    method: (req.method ?? 'GET').toUpperCase(),
    headers: req.headers ?? {},
    body: req.body,
  });
  return (
    `(async () => {` +
    ` const cfg = ${cfg};` +
    ` const res = await fetch(cfg.url, {` +
    ` method: cfg.method,` +
    ` headers: cfg.headers,` +
    ` body: cfg.body,` +
    // 关键：把浏览器里的 cookie 带上。同源请求本来就带，
    // 跨源时只有 include 才带 —— 这是「凭据不过手」的核心。
    ` credentials: 'include'` +
    ` });` +
    ` const text = await res.text();` +
    ` const headers = {};` +
    ` res.headers.forEach((v, k) => { headers[k] = v; });` +
    ` return JSON.stringify({ status: res.status, url: res.url, text, headers });` +
    `})()`
  );
}

export type CdpFrame =
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'event'; method: string }
  | { kind: 'unknown'; reason: string };

export function parseCdpFrame(raw: string): CdpFrame {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown', reason: `无法解析 CDP 消息：${raw.slice(0, 120)}` };
  }

  const id = typeof msg.id === 'number' ? msg.id : undefined;
  if (id === undefined) {
    const method = typeof msg.method === 'string' ? msg.method : 'unknown';
    return { kind: 'event', method };
  }

  if (msg.error !== undefined && msg.error !== null) {
    const err = msg.error as { message?: string };
    return { kind: 'response', id, ok: false, error: err.message ?? 'CDP 返回错误但未说明原因' };
  }

  const result = msg.result as
    | {
        result?: { value?: unknown };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }
    | undefined;
  if (result?.exceptionDetails) {
    const d = result.exceptionDetails;
    return {
      kind: 'response',
      id,
      ok: false,
      error: d.exception?.description ?? d.text ?? '页面脚本执行出错',
    };
  }

  return { kind: 'response', id, ok: true, value: result?.result?.value };
}

/** 构造 Runtime.evaluate 调用报文。 */
export function buildEvaluateMessage(expression: string, id: number): string {
  return JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, userGesture: false },
  });
}

/**
 * 从候选目标里挑出「与请求同源」的那个。
 *
 * 为什么必须同源：请求是在页面上下文里 fetch 的，跨源会被 CORS 拦掉。
 * 而且这些平台的页面本来就只会调用自己域下的接口 ——
 * 所以「按 origin 挑标签页」既是对的做法，也是唯一可行的做法。
 */
export function pickTargetForOrigin(targets: CdpTarget[], requestUrl: string): CdpTarget | undefined {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return undefined;
  }
  return targets.find((t) => {
    if (t.type !== 'page') return false;
    if (!t.webSocketDebuggerUrl) return false;
    try {
      return new URL(t.url).origin === origin;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------- WebSocket 抽象（为了可测试）

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onerror: ((e: Error) => void) | null;
  onclose: (() => void) | null;
}

export type WsFactory = (url: string) => Promise<WsLike>;

/** Node 22 内置的 WHATWG WebSocket 客户端，零依赖。 */
export function nodeWebSocketFactory(): WsFactory {
  return (url) =>
    new Promise<WsLike>((resolve, reject) => {
      const ws = new WebSocket(url) as unknown as WsLike;
      const timer = setTimeout(() => reject(new Error(`连接 CDP 超时：${url}`)), 10_000);
      const originalOnOpen = ws.onopen;
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onopen = originalOnOpen;
        resolve(ws);
      };
      const originalOnError = ws.onerror;
      ws.onerror = (e) => {
        clearTimeout(timer);
        ws.onerror = originalOnError;
        reject(new Error(`无法连接 CDP：${e?.message ?? '未知错误'}`));
      };
    });
}

// ---------------------------------------------------------------- 连接

export interface CdpConnectionOptions {
  wsFactory?: WsFactory;
  timeoutMs?: number;
}

export class CdpConnection {
  readonly #ws: WsLike;
  readonly #timeoutMs: number;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #closed = false;

  private constructor(ws: WsLike, timeoutMs: number) {
    this.#ws = ws;
    this.#timeoutMs = timeoutMs;

    ws.onmessage = (data: string) => {
      const frame = parseCdpFrame(data);
      if (frame.kind !== 'response') return; // 事件（如页面跳转）直接忽略
      const p = this.#pending.get(frame.id);
      if (!p) return;
      this.#pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.value);
      else p.reject(new Error(frame.error));
    };
    ws.onclose = () => {
      this.#closed = true;
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP 连接已关闭（浏览器标签页可能被关闭了）'));
      }
      this.#pending.clear();
    };
  }

  static async connect(wsUrl: string, opts: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const factory = opts.wsFactory ?? nodeWebSocketFactory();
    const ws = await factory(wsUrl);
    return new CdpConnection(ws, opts.timeoutMs ?? 20_000);
  }

  /** 在页面里执行一段表达式并返回结果值。 */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    if (this.#closed) throw new Error('CDP 连接已关闭');
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.#timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 调用超时（${ms}ms）。页面可能卡住或已被关闭。`));
      }, ms);

      this.#pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      try {
        this.#ws.send(buildEvaluateMessage(expression, id));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`CDP 发送失败：${describe(e)}`));
      }
    });
  }

  close(): void {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* 忽略 */
    }
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP 连接已关闭'));
    }
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------- 发现目标

/**
 * 列出可附着的标签页。CDP 的发现接口是普通 HTTP（GET /json/list），
 * 不需要 WebSocket，所以这一步可以独立测试。
 */
export async function discoverCdpTargets(debugBase: string): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`${debugBase.replace(/\/$/, '')}/json/list`, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    throw new HubError(
      'NOT_SUPPORTED',
      `无法连接到浏览器的调试端口 ${debugBase}：${describe(e)}。` +
        '请确认浏览器已带 --remote-debugging-port=9222 启动，并且没有用 --headless。',
      { requiresUserAction: true },
    );
  }
  if (!res.ok) {
    throw new HubError('NOT_SUPPORTED', `浏览器调试接口返回 ${res.status}`, { requiresUserAction: true });
  }
  const list = (await res.json()) as CdpTarget[];
  return Array.isArray(list) ? list : [];
}

// ---------------------------------------------------------------- HttpClient 适配

export interface CdpHttpOptions {
  debugBase?: string;
  connection?: CdpConnection;
  /** 手动指定附着哪个标签页（按 URL 关键词），不填则按请求 origin 自动挑 */
  targetUrlMatch?: string | RegExp;
  timeoutMs?: number;
}

export class CdpHttpClient implements HttpClient {
  readonly #opts: CdpHttpOptions;
  #conn: CdpConnection | undefined;

  constructor(opts: CdpHttpOptions = {}) {
    this.#opts = opts;
  }

  async #connectionFor(requestUrl: string): Promise<CdpConnection> {
    if (this.#opts.connection) return this.#opts.connection;
    if (this.#conn) return this.#conn;

    const debugBase = this.#opts.debugBase ?? 'http://127.0.0.1:9222';
    const targets = await discoverCdpTargets(debugBase);
    if (targets.length === 0) {
      throw new HubError('NOT_SUPPORTED', '浏览器调试接口没有返回任何标签页', { requiresUserAction: true });
    }

    let target: CdpTarget | undefined;
    if (this.#opts.targetUrlMatch !== undefined) {
      const match = this.#opts.targetUrlMatch;
      target = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && (typeof match === 'string' ? t.url.includes(match) : match.test(t.url)),
      );
    } else {
      target = pickTargetForOrigin(targets, requestUrl);
    }

    if (!target) {
      const pages = targets
        .filter((t) => t.type === 'page')
        .map((t) => `  ${t.title} — ${t.url}`)
        .join('\n');
      throw new HubError(
        'NOT_SUPPORTED',
        `没有找到与 ${requestUrl} 同源且已登录的标签页。\n当前打开的标签页：\n${pages}\n` +
          `请在浏览器里打开对应平台的页面后重试。`,
        { requiresUserAction: true },
      );
    }

    this.#conn = await CdpConnection.connect(target.webSocketDebuggerUrl!, {
      timeoutMs: this.#opts.timeoutMs,
    });
    return this.#conn;
  }

  async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
    let conn: CdpConnection;
    try {
      conn = await this.#connectionFor(req.url);
    } catch (e) {
      if (e instanceof HubError) throw e;
      throw new HubError('NOT_SUPPORTED', `CDP 附着失败：${describe(e)}`, {
        platformId: meta.platformId,
        requiresUserAction: true,
      });
    }

    // body 的三种形态统一成字符串
    let body: string | undefined;
    if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : undefined;
    else if (req.json !== undefined) body = JSON.stringify(req.json);
    else if (req.form !== undefined) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) p.append(k, String(v));
      body = p.toString();
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const expression = buildPageFetchExpression({
      url: req.url,
      method,
      headers: req.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });

    let raw: unknown;
    try {
      raw = await conn.evaluate(expression, req.timeoutMs ?? this.#opts.timeoutMs);
    } catch (e) {
      // CORS 失败在页面里表现为 fetch reject，会以异常形式传回来。
      // 必须把它翻译成可操作的提示，否则用户只会看到一句「脚本执行出错」。
      const msg = describe(e);
      if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
        throw new HubError(
          'NOT_SUPPORTED',
          `浏览器拒绝了这次跨源请求（CORS）：${msg}。` +
            `请确认浏览器里打开的是 ${new URL(req.url).origin} 下的页面，` +
            `并已登录对应平台。`,
          { platformId: meta.platformId, requiresUserAction: true },
        );
      }
      throw netError(meta.platformId, e);
    }

    if (typeof raw !== 'string') {
      throw new HubError('UPSTREAM', `CDP 返回了意外类型：${typeof raw}`, { platformId: meta.platformId });
    }

    let parsed: { status: number; url: string; text: string; headers: Record<string, string> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new HubError('UPSTREAM', `CDP 返回内容无法解析：${raw.slice(0, 160)}`, { platformId: meta.platformId });
    }

    const { headers, setCookies } = splitResponseHeaders(
      Object.entries(parsed.headers ?? {}).map(([name, value]) => ({ name, value })),
    );

    return {
      status: parsed.status,
      headers,
      url: parsed.url ?? req.url,
      // 浏览器不会把 Set-Cookie 暴露给页面 JS —— 这正是「凭据不过手」的体现。
      // 我们也不需要它：后续请求同样由浏览器自动附带 cookie。
      setCookies,
      text: async () => parsed.text,
      json: async <T>() => JSON.parse(parsed.text) as T,
      bytes: async () => new TextEncoder().encode(parsed.text),
    };
  }

  close(): void {
    this.#conn?.close();
    this.#conn = undefined;
  }
}
