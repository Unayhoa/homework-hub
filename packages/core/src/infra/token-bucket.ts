/**
 * 令牌桶限流器。
 *
 * 为什么必须要有：学习通/雨课堂这类平台对非官方客户端有主动风控。
 * 一次同步可能发几十个请求，如果全速打过去，轻则返回验证码，
 * 重则账号被临时封禁。所以所有出站请求都必须先取令牌。
 *
 * 选令牌桶而不是「固定间隔 sleep」的原因：突发场景（比如用户手动点同步）
 * 允许在桶容量内快速响应，长期平均速率又受控 —— 体验和安全性兼顾。
 */
import type { Limiter, LimiterOptions } from '../ports/limiter.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TokenBucket implements Limiter {
  readonly #ratePerMs: number;
  readonly #burst: number;
  #tokens: number;
  #lastRefill: number;
  /** 被上游惩罚（429）时的静默截止时刻 */
  #penaltyUntil = 0;

  constructor(opts: LimiterOptions) {
    if (opts.ratePerSecond <= 0) throw new Error('ratePerSecond 必须大于 0');
    if (opts.burst <= 0) throw new Error('burst 必须大于 0');
    this.#ratePerMs = opts.ratePerSecond / 1000;
    this.#burst = opts.burst;
    this.#tokens = opts.burst;
    this.#lastRefill = Date.now();
  }

  #refill(): void {
    const now = Date.now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#ratePerMs);
    this.#lastRefill = now;
  }

  available(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  penalize(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.#penaltyUntil) this.#penaltyUntil = until;
    // 惩罚期间清空桶，强制进入冷却
    this.#tokens = 0;
    this.#lastRefill = Date.now();
  }

  async acquire(weight = 1, signal?: AbortSignal): Promise<number> {
    if (weight > this.#burst) throw new Error(`请求权重 ${weight} 超过桶容量 ${this.#burst}`);
    let waited = 0;

    for (;;) {
      if (signal?.aborted) throw new Error('请求已取消');

      const now = Date.now();
      if (now < this.#penaltyUntil) {
        const wait = this.#penaltyUntil - now;
        await sleep(wait);
        waited += wait;
        continue;
      }

      this.#refill();
      if (this.#tokens >= weight) {
        this.#tokens -= weight;
        return waited;
      }

      const deficit = weight - this.#tokens;
      // 至少等 5ms，避免浮点误差导致死循环空转
      const wait = Math.max(5, Math.ceil(deficit / this.#ratePerMs));
      await sleep(wait);
      waited += wait;
    }
  }
}

/**
 * 平台默认限流档位。
 * 数值是保守估计，宁可慢也别触发验证码 —— 用户能接受同步慢 10 秒，
 * 不能接受账号被封一天。
 */
export const DEFAULT_PLATFORM_LIMITS: Record<string, LimiterOptions> = {
  // 学习通：2026-11-14 实测一次同步**只有 46 个请求**（课程页签名 15 + 作业列表 15
  // + 考试列表 15 + 会话探测 1）—— 因为把「先试 plain 再试 stuenc」「空课程再打一次
  // 无enc」这些纯浪费都砍掉了。原来写 4 rps 是按"一次 80~186 个请求"估的；
  // 请求数降到 46 后，4 rps 仍然要 (46-8)/4 ≈ 9.5 秒，**限流成了唯一瓶颈**。
  // 为什么敢提到 8：真机「超星查询能力测试」A1→B3 全过，其中 A3 = 8 rps / 并发 1 /
  // **40 个真实列表请求**、B3 = 8 rps / 并发 4。真实负载 46 个与测试的 40 个几乎同量级，
  // 所以 8 rps 不是猜的更高值，而是**已在该量级验证过的档位**。12/16 没有实测支撑，不采用。
  chaoxing: { ratePerSecond: 8, burst: 12 },
  // 雨课堂 / 长江雨课堂：一次同步要过百个请求（逐课程逐课次），
  // 限得太死用户要等好几分钟（真机实测）。5 rps 对云平台是礼貌值。
  yuketang: { ratePerSecond: 5, burst: 12 },
  'yuketang-changjiang': { ratePerSecond: 5, burst: 12 },
  ismart: { ratePerSecond: 1, burst: 3 },
  zhihuishu: { ratePerSecond: 1, burst: 3 },
  mock: { ratePerSecond: 50, burst: 50 },
};

export function defaultLimitsFor(platformId: string): LimiterOptions {
  return DEFAULT_PLATFORM_LIMITS[platformId] ?? { ratePerSecond: 2, burst: 4 };
}
