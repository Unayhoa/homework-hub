/**
 * 截止时刻的统一折算。
 *
 * 这个函数存在的唯一理由，是一个真实 bug（2026-10-28）：
 * `Deadline` 是联合类型，绝对时间在 `at` 里，相对时间只有 value/unit。
 * 界面层想比较"两条作业是否同时截止"，就 `new Date(task.deadline)` ——
 * 那是个对象，得到 Invalid Date，`NaN <= 3600000` 恒为 false。
 * 于是条件永远不成立、功能静默失效，而代码看起来完全正确。
 *
 * 判据只能有一处，而且必须可测。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deadlineToMs } from '../src/domain/deadline.ts';

describe('deadlineToMs：三种截止形态都要能折算', () => {
  it('绝对时间取 at', () => {
    const ms = deadlineToMs({ kind: 'absolute', at: '2026-10-28T15:59:00.000Z' });
    assert.equal(ms, Date.parse('2026-10-28T15:59:00.000Z'));
  });

  it('相对时间用调用方折算好的 fallbackAt', () => {
    const ms = deadlineToMs({ kind: 'relative', value: 3, unit: 'day' }, '2026-10-31T23:59:00.000Z');
    assert.equal(ms, Date.parse('2026-10-31T23:59:00.000Z'));
  });

  it('相对时间但没给 fallback → null（不知道具体时刻，不能瞎猜）', () => {
    assert.equal(deadlineToMs({ kind: 'relative', value: 3, unit: 'day' }), null);
  });

  it('open / unknown / 缺失 → null', () => {
    assert.equal(deadlineToMs({ kind: 'open' }), null);
    assert.equal(deadlineToMs({ kind: 'unknown', raw: '待定' }), null);
    assert.equal(deadlineToMs(undefined), null);
  });

  it('绝不返回 NaN —— 这是本函数的核心承诺', () => {
    // NaN 会静默穿过所有比较（NaN <= x 恒为 false），是这类 bug 的根源
    for (const d of [
      { kind: 'absolute', at: '2026-10-28T15:59:00.000Z' },
      { kind: 'open' } as const,
      { kind: 'unknown', raw: 'x' } as const,
      undefined,
    ]) {
      const ms = deadlineToMs(d as never);
      assert.ok(ms === null || Number.isFinite(ms), `返回了非有限数：${String(ms)}`);
    }
  });
});
