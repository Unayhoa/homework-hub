/**
 * 韧性 HTTP 管道：限流 + 退避重试 + 统计。
 *
 * 关键设计是把这一层做成「包装器」而不是让适配器自己处理：
 * 适配器作者只需要写业务逻辑，网络层面的重试/限流/日志自动生效，
 * 不可能漏掉，也不可能各写各的。
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import type { Limiter } from '../ports/limiter.ts';
import type { Logger } from '../ports/logger.ts';
import { HubError, describe, netError, rateLimited } from '../domain/errors.ts';

export interface RetryPolicy {
  /** 总尝试次数（含首次） */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
};

export interface HttpStats {
  requests: number;
  retries: number;
  throttledMs: number;
  statusCounts: Record<string, number>;
  lastError?: string;
}

export interface ResilientHttpOptions {
  platformId: string;
  limiter: Limiter;
  logger: Logger;
  retry?: RetryPolicy;
  stats?: HttpStats;
}

/** 全抖动的指数退避：避免多个账号在同一时刻齐步重试，形成新的尖峰。 */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}

function retryAfterMs(res: HttpResponse): number | undefined {
  const raw = res.headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(raw).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** 这些状态码不该重试：重试也不会变好，只会浪费请求额度。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createResilientHttpClient(base: HttpClient, opts: ResilientHttpOptions): HttpClient {
  const policy = opts.retry ?? DEFAULT_RETRY;
  const stats: HttpStats = opts.stats ?? {
    requests: 0,
    retries: 0,
    throttledMs: 0,
    statusCounts: {},
  };
  const log = opts.logger.child({ platformId: opts.platformId, layer: 'http' });

  return {
    async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
      let lastError: unknown;

      for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
        const waited = await opts.limiter.acquire(1, meta.signal);
        stats.throttledMs += waited;
        stats.requests += 1;

        try {
          const res = await base.request(req, meta);
          stats.statusCounts[String(res.status)] = (stats.statusCounts[String(res.status)] ?? 0) + 1;

          if (res.status === 429) {
            const after = retryAfterMs(res) ?? backoffDelay(attempt, policy);
            // 把上游的惩罚回灌给限流器，后续请求自动降速
            opts.limiter.penalize(after);
            lastError = rateLimited(opts.platformId, after);
            log.warn('被上游限流，进入冷却', { url: req.url, retryAfterMs: after, attempt });
            if (attempt === policy.attempts) throw lastError;
            stats.retries += 1;
            continue;
          }

          if (res.status >= 500 && attempt < policy.attempts) {
            lastError = new HubError('UPSTREAM', `${opts.platformId} 返回 ${res.status}`, {
              platformId: opts.platformId,
              retryable: true,
            });
            const delay = backoffDelay(attempt, policy);
            log.warn('上游 5xx，退避重试', { url: req.url, status: res.status, delay, attempt });
            stats.retries += 1;
            await sleep(delay);
            continue;
          }

          // 401/403 之类的交给适配器判断（不同平台对未登录的返回码不一致），管道不擅自处理
          if (isRetryableStatus(res.status) && attempt === policy.attempts) {
            throw new HubError('UPSTREAM', `${opts.platformId} 返回 ${res.status}，已重试 ${policy.attempts} 次`, {
              platformId: opts.platformId,
              retryable: true,
            });
          }

          return res;
        } catch (e) {
          if (e instanceof HubError && !e.retryable) throw e;
          lastError = e;
          stats.lastError = describe(e);

          if (attempt >= policy.attempts) break;
          const delay = backoffDelay(attempt, policy);
          stats.retries += 1;
          log.warn('请求失败，重试中', { url: req.url, delay, attempt, error: describe(e) });
          await sleep(delay);
        }
      }

      if (lastError instanceof HubError) throw lastError;
      throw netError(opts.platformId, lastError);
    },
  };
}

export function createHttpStats(): HttpStats {
  return { requests: 0, retries: 0, throttledMs: 0, statusCounts: {} };
}

/** 简单的并发池：用于并发同步多个账号，同时限制总并发避免带宽/CPU 打满。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(limit, 1), Math.max(items.length, 1)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
