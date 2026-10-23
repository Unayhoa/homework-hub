/** 限流端口。实现见 infra/token-bucket.ts。 */
export interface Limiter {
  /** 取一个令牌，必要时等待。返回实际等待毫秒数。 */
  acquire(weight?: number, signal?: AbortSignal): Promise<number>;
  /** 被上游 429 时调用，临时收紧配额 */
  penalize(ms: number): void;
  /** 当前可用令牌数，仅用于诊断 */
  available(): number;
}

export interface LimiterOptions {
  /** 每秒补充的令牌数 */
  ratePerSecond: number;
  /** 桶容量（允许的突发量） */
  burst: number;
}
