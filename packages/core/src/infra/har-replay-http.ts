/**
 * HAR 回放型 HTTP 客户端：**一个真实的网络请求都不发**。
 *
 * 这是「不影响正常登录状态」这条路上走到底的形态 ——
 * 不是「少发请求」「低频请求」，而是字面意义上的零请求：
 *
 *   引擎 → 只读守卫 → 限流重试 → [HarReplayHttpClient] ⟶（不联网）⟶ 平台
 *
 * 适配器完全不知道差别：它照常「请求」接口，拿到的是上次真实抓包的响应。
 * 引擎、合并、提醒、只读守卫全部照常工作。
 *
 * 这条路线的真实用途：
 *
 *   1. **首次导入**。用户在浏览器里正常打开一次作业页面，
 *      DevTools → Network →「Save all as HAR with content」→ 拖进来。
 *      我们从头到尾没有碰过他的登录态，连一个 GET 都没有。
 *
 *   2. **适配器离线开发**。我手上没有学习通/雨课堂的真实账号，
 *      有了回放，解析器可以对着真实响应反复调试 ——
 *      这比「拿真实账号反复试」安全得多，后者才是最容易触发风控的行为。
 *
 *   3. **平台改版回归测试**。新旧 HAR 对比，立刻知道哪几个接口变了。
 *
 * 局限（必须说清楚）：
 *   - 它是快照。回放拿到的永远是录制那一刻的数据，不会看到老师今天新布置的作业。
 *     所以它是「导入」路线，不是「持续同步」路线；持续同步仍需要共享会话的路线。
 *   - 只能回放录制时见过的 URL。请求一个没录过的地址会显式报
 *     CAPTURE_MISS，并列出所有已录制的 URL 帮你定位 —— 绝不静默返回空。
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import { HubError } from '../domain/errors.ts';
import { parseHar, normalizeUrlForMatching, urlPathKey, splitResponseHeaders } from './har.ts';
import type { HarEntry } from './har.ts';

export interface ReplayStats {  /** HAR 里的条目总数 */
  total: number;
  /** 精确匹配（方法 + 完整 URL 含 query）次数 */
  exactHits: number;
  /** 兜底匹配（方法 + 路径，忽略 query）次数 */
  pathHits: number;
  /** 未命中次数。正常运行时应恒为 0 */
  misses: number;
  /** 已录制的请求清单，用于排错 */
  recorded: Array<{ method: string; url: string; status: number }>;
}

export function createReplayStats(entries: HarEntry[]): ReplayStats {
  return {
    total: entries.length,
    exactHits: 0,
    pathHits: 0,
    misses: 0,
    recorded: entries.map((e) => ({
      method: (e.request.method ?? 'GET').toUpperCase(),
      url: e.request.url,
      status: e.response?.status ?? 0,
    })),
  };
}

export interface HarReplayOptions {  /**
   * 是否跳过非 2xx 的录制条目。
   * 默认 true：回放的目的是「拿到上次成功的数据」，
   * 如果录制时这个接口本来就失败了（登录页、验证码页），
   * 回放它只会让适配器误判成改版。
   */
  skipFailures?: boolean;
}

export class HarReplayHttpClient implements HttpClient {  readonly #exact = new Map<string, HarEntry>();
  readonly #byPath = new Map<string, HarEntry[]>();
  readonly #consumed = new Set<HarEntry>();
  readonly #opts: Required<HarReplayOptions>;
  readonly #stats: ReplayStats;

  constructor(harJson: string, opts: HarReplayOptions = {}) {
    this.#opts = { skipFailures: opts.skipFailures ?? true };
    const entries = parseHar(harJson).filter((e) => {
      if (!this.#opts.skipFailures) return true;
      const status = e.response?.status ?? 0;
      // 0 = 从未收到响应（录制时请求失败），300-399 = 重定向中间态
      return status >= 200 && status < 300;
    });
    this.#stats = createReplayStats(entries);

    for (const entry of entries) {
      const method = (entry.request.method ?? 'GET').toUpperCase();
      const url = entry.request.url;
      const exactKey = `${method} ${normalizeUrlForMatching(url)}`;
      if (!this.#exact.has(exactKey)) this.#exact.set(exactKey, entry);

      const pathKey = `${method} ${urlPathKey(url)}`;
      const bucket = this.#byPath.get(pathKey);
      if (bucket) bucket.push(entry);
      else this.#byPath.set(pathKey, [entry]);
    }
  }

  static async fromFile(path: string): Promise<HarReplayHttpClient> {
    // 动态且用变量作说明符：这样这个文件在浏览器构建里也能通过类型检查
    // （node:fs 只是运行时才需要，而浏览器端永远不会走到 fromFile）。
    const specifier = 'node:fs/promises';
    const fs = (await import(specifier)) as { readFile(p: string, enc: string): Promise<string> };
    return new HarReplayHttpClient(await fs.readFile(path, 'utf8'));
  }

  get stats(): ReplayStats {
    return this.#stats;
  }

  async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url;

    // 第一优先：方法 + 完整 URL（含 query）。
    // 适配器对同一接口的不同页会带不同 query，必须区分开。
    const exactKey = `${method} ${normalizeUrlForMatching(url)}`;
    const exact = this.#exact.get(exactKey);
    if (exact) {
      this.#stats.exactHits += 1;
      return this.#serve(exact, url);
    }

    // 第二优先：方法 + 路径（忽略 query）。
    // 真实抓包里 query 经常带时间戳 / csrf / 随机数，每次都不同，
    // 只按精确匹配会大量漏配。兜底时优先取还没被用过的那条，
    // 这样分页接口（同一个 path 不同 cursor）能按顺序对上。
    const pathKey = `${method} ${urlPathKey(url)}`;
    const bucket = this.#byPath.get(pathKey);
    if (bucket && bucket.length > 0) {
      const fresh = bucket.find((e) => !this.#consumed.has(e));
      const chosen = fresh ?? bucket[0]!;
      this.#stats.pathHits += 1;
      return this.#serve(chosen, url);
    }

    this.#stats.misses += 1;
    const recorded = this.#stats.recorded
      .slice(0, 12)
      .map((r) => `  ${r.method} ${r.url} → ${r.status}`)
      .join('\n');
    throw new HubError(
      'CAPTURE_MISS',
      `回放文件里没有这条请求：${method} ${url}\n` +
        `已录制的请求（前 12 条）：\n${recorded}\n` +
        `请在平台上重新操作一次并导出 HAR，确保覆盖这个页面。`,
      { platformId: meta.platformId, requiresUserAction: true },
    );
  }

  #serve(entry: HarEntry, requestedUrl: string): HttpResponse {
    this.#consumed.add(entry);
    const { headers, setCookies } = splitResponseHeaders(entry.response?.headers);
    const content = entry.response?.content;
    let text = content?.text ?? '';
    if (content?.encoding === 'base64') {
      // 用 atob 而不是 Buffer —— WebView 里没有 Buffer，而 atob 两边都有
      try {
        text = decodeBase64(text);
      } catch {
        text = '';
      }
    }

    return {
      status: entry.response?.status ?? 0,
      headers,
      // 回放时「最终 URL」就是请求 URL —— 没有真正的重定向发生过
      url: requestedUrl,
      setCookies,
      text: async () => text,
      json: async <T>() => JSON.parse(text) as T,
      bytes: async () => new TextEncoder().encode(text),
    };
  }
}

/**
 * 解码 base64 为 UTF-8 字符串。
 * 用 atob + TextDecoder 而不是 Buffer —— WebView 里没有 Buffer，
 * 而这三个 API（atob / TextDecoder / TextEncoder）Node 和浏览器都有。
 */
function decodeBase64(text: string): string {
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
