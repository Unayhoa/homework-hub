/**
 * 时钟抽象。
 *
 * 同步引擎里到处都要「现在几点」，但直接调 Date.now() 会让
 * 「截止前 2 小时提醒」这类逻辑无法测试 —— 你没法等到凌晨去跑测试。
 * 所以所有时间获取都走 Clock，测试注入 FakeClock 就能把时间「拨」到任意时刻。
 */
export interface Clock {
  now(): Date;
  /** 毫秒时间戳，用于计算耗时 */
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** 测试用：可手动推进的时钟。 */
export class FakeClock implements Clock {
  #current: number;

  constructor(start: Date | number | string = '2026-09-22T12:00:00+08:00') {
    this.#current = start instanceof Date ? start.getTime() : typeof start === 'number' ? start : new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#current);
  }

  nowMs(): number {
    return this.#current;
  }

  /** 前进指定毫秒，返回自身以便链式调用。 */
  advance(ms: number): this {
    this.#current += ms;
    return this;
  }

  advanceDays(days: number): this {
    return this.advance(days * 86_400_000);
  }

  set(at: Date | number | string): this {
    this.#current = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : new Date(at).getTime();
    return this;
  }
}
