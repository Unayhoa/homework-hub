/**
 * 「缺信息不覆盖已知信息」。
 *
 * 真机症状（2026-11-01）：同一份作业的截止时间在「有值」和 `unknown` 之间来回跳，
 * 变更历史里 `10/30 11:59 → unknown` 和 `unknown → 10/30 23:59` 交替出现。
 * 用户连续同步三次，三次分别显示不同的作业"有更新"，而他什么都没做。
 *
 * 根因不是"值变了"，而是**某一轮页面没渲染出日期**，我们把这个当成"平台改了"。
 * 这两件事在数据上都表现为 unknown，但含义相反：
 *   · 「平台取消了截止时间」—— 极罕见，平台会明说
 *   · 「这次没解析到」—— 很常见，尤其页面分段渲染时
 *
 * 所以规则是：**新的解析结果缺失时，保留库里已有的值**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffTask, keepKnownFields } from '../src/engine/merge.ts';
import { materializeTask } from '../src/index.ts';
import type { PlatformTask } from '../src/domain/task.ts';

const NOW = new Date('2026-11-01T10:00:00.000Z');

function make(patch: Partial<PlatformTask>) {
  return materializeTask({
    platformId: 'chaoxing',
    accountId: 'acc-1',
    now: NOW,
    platformTask: {
      platformTaskId: 'w-1',
      courseId: 'c-1',
      courseName: '数据结构',
      kind: 'homework',
      title: '第一次上机',
      status: 'pending',
      deadline: '2026-11-05 15:15',
      ...patch,
    },
  });
}

describe('keepKnownFields：这轮没解析到 ≠ 平台改了', () => {
  it('新的一轮没有截止时间 → 保留库里已有的，不产生"改期"', () => {
    const prev = make({});
    const next = make({ deadline: undefined });
    assert.equal(next.deadline.kind, 'unknown', '前提：这一轮确实没解析到');

    const merged = keepKnownFields(prev, next);
    assert.deepEqual(merged.deadline, prev.deadline, '保留已知的截止时间');
  });

  it('状态 unknown 也不覆盖已交/待完成', () => {
    const prev = make({ status: 'submitted' });
    const next = make({ status: undefined });
    assert.equal(next.status, 'unknown');

    assert.equal(keepKnownFields(prev, next).status, 'submitted');
  });

  it('但新的**有效**值照常覆盖 —— 真改期不能被这条规则吞掉', () => {
    const prev = make({});
    const next = make({ deadline: '2026-11-12 23:59', status: 'submitted' });

    const merged = keepKnownFields(prev, next);
    assert.deepEqual(merged.deadline, next.deadline);
    assert.equal(merged.status, 'submitted');
  });

  it('平台原话也跟着保留（否则卡片会退回默认文案）', () => {
    const prev = make({ status: 'pending', statusRaw: '未开放' });
    const next = make({ status: undefined });
    assert.equal(keepKnownFields(prev, next).statusRaw, '未开放');
  });

  it('「不限时」（open）是明确信息，不能被 unknown 顶掉', () => {
    // open = 平台明说"没有截止时间"，这是有信息量的一种状态，和"不知道"不同
    const prev = { ...make({}), deadline: { kind: 'open' as const } };
    const next = make({ deadline: undefined });
    assert.equal(keepKnownFields(prev, next).deadline.kind, 'open');
  });
});

describe('抖动期间不再写变更历史', () => {
  it('同一字段 24 小时内变 3 次后，第 4 次不再记（值仍然更新）', () => {
    // 真机：连续同步三次，三次都提示"有作业信息更新"，每次还是不同的作业。
    // 两个都是"有效值"（10/22 和 11/5），所以"缺失不覆盖"那条规则拦不住。
    const mkChange = (h: number) => ({
      field: 'deadline' as const,
      from: '2026-10-22 23:50',
      to: '2026-11-05 15:15',
      at: new Date(Date.now() - h * 3_600_000).toISOString(),
    });
    const prev = { ...make({}), history: [mkChange(1), mkChange(2), mkChange(3)] };
    const next = make({ deadline: '2026-12-01 23:59' });

    const changes = diffTask(prev, next);
    assert.equal(
      changes.some((c) => c.field === 'deadline'),
      false,
      '已经在抖了，不该再刷一条历史 —— 噪音会淹没真改期',
    );
  });

  it('但只变过 1 次时，第二次照常记 —— 别把真改期当抖动吞掉', () => {
    const prev = {
      ...make({}),
      history: [
        { field: 'deadline' as const, from: '2026-10-22 23:50', to: '2026-11-05 15:15', at: new Date(Date.now() - 3_600_000).toISOString() },
      ],
    };
    const next = make({ deadline: '2026-12-01 23:59' });
    const changes = diffTask(prev, next);
    assert.ok(changes.some((c) => c.field === 'deadline'));
  });
});
