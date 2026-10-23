/**
 * Android 原生 HTTP 桥：让引擎在 WebView 里发出的请求走原生网络栈。
 *
 * ── 为什么必须这么做 ──
 * WebView 里的 fetch 受同源策略（CORS）限制。学习通/雨课堂的接口
 * 不会给 https://appassets.androidplatform.net 发 CORS 头，
 * 所以从页面直接 fetch 平台接口 100% 会被浏览器拦掉 ——
 * 而且 fetch 的 CORS 失败是**静默返回空**，正好是本项目最忌讳的失败形态。
 *
 * 原生请求（HttpURLConnection）不受 CORS 约束，而且能和 WebView 共享
 * CookieManager —— 用户在 App 内的 WebView 里正常登录平台，
 * 之后原生请求自动带上那份 cookie。
 *
 *   页面（引擎）→ 桥 → HttpURLConnection + CookieManager → 平台
 *
 * 这也是「不影响登录态」在手机上的最优解：
 * 登录就是你本人在官方网页上登录，我们既不接触密码，也拿不到 Cookie
 * （Cookie 一直待在 Android 的 CookieManager 里，从不进入 JS）。
 *
 * ── 协议 ──
 *   JS  → 原生：Android.httpRequest(id, method, url, headersJson, body)
 *   原生 → JS ：window.__hhBridge.resolve(id, resultJson)
 *               window.__hhBridge.reject(id, messageJson)
 * 原生通过 evaluateJavascript 回调，所以整个桥是异步的，
 * 不会阻塞 WebView 的 JS 线程。
 */
import { HubError, netError } from '#core';
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '#core';

/**
 * 原生侧（Android）暴露给页面的接口。
 * 这里是整个桥的唯一契约声明 —— 其他模块不要再 declare global 同一批成员，
 * 否则 TS 会因为「同名属性类型不一致」直接报错。
 */
interface AndroidBridgeHost {
  /** 发起 HTTP 请求（异步回调 __hhBridge.resolve/reject） */
  httpRequest?: (id: string, method: string, url: string, headersJson: string, body: string | null) => void;
  /** 在同一个 WebView 里打开平台的登录页（url 由 JS 侧从适配器的 homepage 取，避免 Java 里再维护一份平台清单） */
  openLogin?: (url: string, platformId: string) => void;
  /** 发系统通知 */
  notify?: (title: string, body: string) => void;
  /** 上报日志到 logcat，便于真机排查 */
  log?: (level: string, message: string) => void;
}

interface BridgeResult {
  status: number;
  url: string;
  headers?: Record<string, string>;
  setCookies?: string[];
  text?: string;
  /** 二进制响应（图片等）的 base64 原样字节 —— 文本解码会破坏它们 */
  binaryBase64?: string;
  /** 响应体超过原生侧上限被截断 */
  truncated?: boolean;
  /** 原生侧解码失败等情况的说明 */
  error?: string;
}

const MAX_RESPONSE_HINT = 8 * 1024 * 1024;

declare global {
  interface Window {
    Android?: AndroidBridgeHost;
    __hhBridge?: {
      resolve: (id: string, resultJson: string) => void;
      reject: (id: string, messageJson: string) => void;
    };
  }
}

/**
 * 把待处理请求挂在全局，供原生侧回调（原生只能调用全局函数）。
 *
 * 导出是因为：模块加载时可能还没有 window（Node 里跑测试、
 * 或者宿主环境晚于模块初始化才注入桥）。所以做成幂等的、可重复调用的。
 */
export function ensureBridgeCallbacks(): void {
  if (typeof window === 'undefined') return;
  if (window.__hhBridge) return;

  window.__hhBridge = {
    resolve: (id: string, resultJson: string) => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(resultJson) as BridgeResult);
      } catch (e) {
        pending.reject(new Error(`原生桥返回了无法解析的结果：${(e as Error).message}`));
      }
    },
    reject: (id: string, messageJson: string) => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      let message = messageJson;
      try {
        const parsed = JSON.parse(messageJson) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        /* 原生侧传了非 JSON，直接用原文 */
      }
      pending.reject(new Error(message));
    },
  };
}

interface Pending {
  resolve: (r: BridgeResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, Pending>();
let nextId = 1;

ensureBridgeCallbacks();

export interface BridgeHttpOptions {
  timeoutMs?: number;
}

export function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.Android?.httpRequest === 'function';
}

export class BridgeHttpClient implements HttpClient {
  readonly #timeoutMs: number;

  constructor(opts: BridgeHttpOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 25_000;
  }

  async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
    const host = typeof window !== 'undefined' ? window.Android : undefined;
    if (typeof host?.httpRequest !== 'function') {
      throw new HubError(
        'NOT_SUPPORTED',
        '当前环境没有原生 HTTP 桥。这个内核需要在 HomeworkHub 的 Android 应用里运行；' +
          '在电脑上请用 apps/web/src/server.ts。',
      );
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { ...req.headers };

    // body 三种形态统一成字符串，并补默认 Content-Type
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === 'string' ? req.body : undefined;
    } else if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (req.form !== undefined) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) p.append(k, String(v));
      body = p.toString();
      if (!hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    const id = String(nextId++);
    const timeoutMs = req.timeoutMs ?? this.#timeoutMs;

    let result: BridgeResult;
    try {
      result = await new Promise<BridgeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`请求超时（${timeoutMs}ms）：${method} ${req.url}`));
        }, timeoutMs);
        pendingRequests.set(id, { resolve, reject, timer });
        try {
          host.httpRequest!(id, method, req.url, JSON.stringify(headers), body ?? null);
        } catch (e) {
          clearTimeout(timer);
          pendingRequests.delete(id);
          reject(e as Error);
        }
      });
    } catch (e) {
      throw netError(meta.platformId, e);
    }

    if (result.error) {
      throw new HubError('UPSTREAM', `原生请求失败：${result.error}`, { platformId: meta.platformId });
    }

    // 响应被截断 = 请求打到了非预期的地址（大文件/流式端点）。
    // 显式报错并带上 URL：否则截断的响应会一路传到解析层，
    // 表现为一个完全指不到原因的怪错误（真机上表现为 Invalid string length）。
    if (result.truncated) {
      throw new HubError(
        'UPSTREAM',
        `响应体超过 ${Math.round(MAX_RESPONSE_HINT / 1024 / 1024)}MB 被截断，请求可能打到了非预期地址：${req.url}`,
        { platformId: meta.platformId },
      );
    }

    const text = result.text ?? '';
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.headers ?? {})) normalizedHeaders[k.toLowerCase()] = v;

    return {
      status: result.status,
      headers: normalizedHeaders,
      url: result.url || req.url,
      // Cookie 由原生侧直接写进 CookieManager，不回传 JS ——
      // 这正是「凭据不过手」：JS 侧从头到尾看不到会话 cookie。
      setCookies: [],
      text: async () => text,
      json: async <T>() => JSON.parse(text) as T,
      bytes: async () => {
        // 二进制响应走原生 base64 通道；按文本解码再编码会把图片变成废字节
        if (result.binaryBase64) {
          const bin = atob(result.binaryBase64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
          return out;
        }
        return new TextEncoder().encode(text);
      },
    };
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((h) => h.toLowerCase() === name);
}
