/**
 * 「不用交」（skipped）—— 一个独立于「已完成」的人工判定。
 *
 * 为什么它必须独立（这个文件守的就是这个区分）：
 *   completed 回答「我交没交」，skipped 回答「这条适不适用」。
 *   典型场景：小组作业平台给每个组员都推一条待办，但实际只需组长提交。
 *   标成"已完成"是在撒谎（我没交），标成"不用交"才是实情。
 *
 * 也正因为它是另一个**维度**，所以它不受「平台优先」限制 ——
 * 平台说 pending 只否定了"我交了"，从没说过"这条需要你交"。
 * （与 expired 同源：过期是关于时间的断言，不是关于交没交的断言。）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canMarkCompleted,
  canSkip,
  completionOrigin,
  effectiveStatus,
  isActionable,
  isTerminalStatus,
  materializeTask,
} from '../src/index.ts';
import type { UnifiedTask } from '../src/index.ts';

function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function task(
  input: { title?: string; status?: 'pending' | 'submitted'; statusSource?: 'platform' | 'inferred' } = {},
): UnifiedTask {
  return materializeTask({
    platformId: 'chaoxing',
    accountId: 'chaoxing::u1',
    platformTask: {
      platformTaskId: 'work_1',
      courseId: 'C1',
      courseName: '信息安全数学基础',
      kind: 'homework',
      title: input.title ?? '小组作业（组长提交）',
      status: input.status ?? 'pending',
      statusSource: input.statusSource,
      deadline: at(2026, 10, 20, 23, 59).toISOString(),
    },
    now: at(2026, 10, 18),
  });
}

const skippedAt = at(2026, 10, 18, 9, 0).toISOString();

describe('不用交（skipped）', () => {
  it('标了就不算待办：离开待办列表、也不再排提醒', () => {
    const t: UnifiedTask = { ...task(), userSkippedAt: skippedAt };
    assert.equal(effectiveStatus(t), 'skipped');
    assert.equal(isActionable(t), false, '不算待办，提醒自然也不会再排');
    assert.equal(isTerminalStatus('skipped'), true, '算终态，会进记录栏');
  });

  it('**不受「平台优先」限制** —— 平台明确说未完成，照样可以标', () => {
    const base = task(); // 平台说 pending，statusSource 默认 platform
    assert.equal(canMarkCompleted(base), false, '「已完成」被平台优先压住，这是对的');
    assert.equal(canSkip(base), true, '但「不用交」说的是另一个维度，没理由被压');
  });

  it('已经是终态就不再提供标记（没有可标的东西）', () => {
    const t: UnifiedTask = { ...task(), userSkippedAt: skippedAt };
    assert.equal(canSkip(t), false);
    assert.equal(canMarkCompleted(t), false);
  });

  it('「不用交」优先于「已完成」—— 两个都在时以它为准', () => {
    const t: UnifiedTask = {
      ...task(),
      userCompletedAt: at(2026, 10, 17, 20, 0).toISOString(),
      userSkippedAt: skippedAt,
    };
    assert.equal(effectiveStatus(t), 'skipped');
    assert.equal(completionOrigin(t), 'skipped');
  });

  it('界面要能分辨「不用交」与「手动完成」—— 混成一句话就是在撒谎', () => {
    const manual: UnifiedTask = {
      ...task({ status: 'submitted' }),
      userCompletedAt: at(2026, 10, 18, 8, 0).toISOString(),
    };
    const skipped: UnifiedTask = { ...task(), userSkippedAt: skippedAt };
    assert.equal(completionOrigin(skipped), 'skipped');
    assert.notEqual(completionOrigin(manual), 'skipped');
  });

  it('撤销后回到待办（标记只是本地事实，去掉就该回来）', () => {
    const t: UnifiedTask = { ...task(), userSkippedAt: undefined };
    assert.equal(effectiveStatus(t), 'pending');
    assert.equal(isActionable(t), true);
  });
});
