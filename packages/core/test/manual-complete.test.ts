/**
 * 手动标记「已完成」+「平台优先」规则。
 *
 * 这个文件守的是三条线：
 *   1. `effectiveStatus` 是全应用唯一的状态判定入口 —— 它的四条分支必须各自钉死。
 *      以前「什么是终态」散在四处各写一遍，加一条规则要改四个地方，必然漂移。
 *   2. 用户手写的话同步不许抹掉（与 userDeletedAt 同一条原则）。
 *   3. 被平台优先规则压住时必须**如实告知**，不能静默什么都不做。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { completionOrigin, effectiveStatus, isTerminalStatus, canMarkCompleted } from '../src/index.ts';
import { needsManualCompletion } from '../src/index.ts';
import { materializeTask } from '../src/index.ts';
import { makeEngine, makeStubAdapter, type StubControl } from './relogin.test.ts';

type Src = 'platform' | 'inferred';

function task(opts: {
  status?: 'pending' | 'submitted' | 'graded' | 'expired' | 'unknown';
  statusSource?: Src;
  userCompletedAt?: string;
}) {
  const t = materializeTask({
    platformId: 'stub',
    accountId: 'stub::u1',
    platformTask: {
      platformTaskId: 'w1',
      courseId: 'C1',
      courseName: '课程一',
      kind: 'homework',
      title: '作业一',
      status: opts.status ?? 'pending',
      ...(opts.statusSource ? { statusSource: opts.statusSource } : {}),
      deadline: '2026-10-20 23:59',
    },
    now: new Date('2026-10-01T00:00:00Z'),
  });
  return { ...t, ...(opts.userCompletedAt ? { userCompletedAt: opts.userCompletedAt } : {}) };
}

const MARK = '2026-10-11T12:00:00.000Z';

describe('effectiveStatus：平台优先的四条分支', () => {
  it('没手动标记时，原样返回平台状态', () => {
    assert.equal(effectiveStatus(task({ status: 'pending' })), 'pending');
    assert.equal(effectiveStatus(task({ status: 'graded' })), 'graded');
  });

  it('平台明确说「未完成」→ 压制手动标记（这是"平台优先"的核心）', () => {
    const t = task({ status: 'pending', statusSource: 'platform', userCompletedAt: MARK });
    assert.equal(effectiveStatus(t), 'pending');
    assert.equal(completionOrigin(t), null, '被压制时不算"已完成"');
  });

  it('平台沉默（inferred）→ 手动标记生效，显示为已提交', () => {
    // 雨课堂章节树的真实处境：完成态字段根本不存在，是我们推的 pending
    const t = task({ status: 'pending', statusSource: 'inferred', userCompletedAt: MARK });
    assert.equal(effectiveStatus(t), 'submitted');
    assert.equal(completionOrigin(t), 'manual', '必须标成 manual，不能让本地数据伪装成平台数据');
  });

  it('平台只说了「过期」→ 不压制手动标记（过期是时间断言，不是"你交没交"）', () => {
    const t = task({ status: 'expired', statusSource: 'platform', userCompletedAt: MARK });
    assert.equal(effectiveStatus(t), 'submitted');
    assert.equal(completionOrigin(t), 'manual');
  });

  it('平台给了终态 → 听平台，并把来源标成 platform', () => {
    const t = task({ status: 'graded', statusSource: 'platform', userCompletedAt: MARK });
    assert.equal(effectiveStatus(t), 'graded');
    assert.equal(completionOrigin(t), 'platform');
  });

  it('statusSource 缺省视同"平台说的"（保守：老数据不该被自动放行）', () => {
    const t = task({ status: 'pending', userCompletedAt: MARK });
    assert.equal(effectiveStatus(t), 'pending');
  });
});

describe('needsManualCompletion：哪条任务必须用户自己标', () => {
  // 这条判据的唯一消费者是任务卡片上那句「XX 不报完成状态 · 做完点 ✓ 自己标」。
  // 它判错是双向静默：多给 → 每张卡多一行噪音（用户不知道哪些平台真需要标）；
  // 少给 → 做完了卡片永远不清，用户以为 App 坏了。所以三条分支逐个钉死。

  it('平台沉默（inferred）+ 没标过 → true（雨课堂的真实处境）', () => {
    assert.equal(needsManualCompletion(task({ status: 'pending', statusSource: 'inferred' })), true);
  });

  it('平台报状态 → false（超星 / iSmart / PTA 不该多出任何提示）', () => {
    assert.equal(needsManualCompletion(task({ status: 'pending', statusSource: 'platform' })), false);
  });

  it('statusSource 缺省（老数据）→ false：保守处理，不乱教用户', () => {
    // 与 effectiveStatus 同一条口径：undefined 视同"平台说的"
    assert.equal(needsManualCompletion(task({ status: 'pending' })), false);
  });

  it('已经标过完成 / 不用交 → false（别再啰嗦）', () => {
    assert.equal(
      needsManualCompletion(task({ status: 'pending', statusSource: 'inferred', userCompletedAt: MARK })),
      false,
    );
    const skipped = { ...task({ status: 'pending', statusSource: 'inferred' }), userSkippedAt: MARK };
    assert.equal(needsManualCompletion(skipped), false);
  });

  it('过了截止时间也一样要标 —— 平台沉默是平台的属性，不随这条任务的状态变', () => {
    // 雨课堂的作业逾期后仍留在「已逾期」分组里，用户还是得自己标掉它
    assert.equal(needsManualCompletion(task({ status: 'expired', statusSource: 'inferred' })), true);
  });
});

describe('手动标记的端到端行为', () => {
  const base = (taskStatus: 'pending', statusSource?: Src): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
    taskStatus,
    ...(statusSource ? { statusSource } : {}),
  });

  it('平台沉默时：标记生效 → 出待办、进已完成（带 manual 来源），且同步抹不掉', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(base('pending', 'inferred')));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      await engine.syncAll({});
      const id = (await engine.upcoming())[0]!.id;

      const r = await engine.setTaskCompleted(id, true);
      assert.equal(r.applied, true);
      assert.equal(r.suppressedByPlatform, false);

      assert.equal((await engine.upcoming()).length, 0, '标记后应离开待办');
      const done = await engine.completed();
      assert.equal(done.length, 1, '标记后应进已完成');
      assert.equal(completionOrigin(done[0]!), 'manual');

      // 关键：再同步一轮，用户手写的标记不能被平台报文抹掉
      await engine.syncAll({});
      const after = await engine.completed();
      assert.equal(after.length, 1, '同步不能把用户标的"已完成"抹掉');
      assert.ok(after[0]!.userCompletedAt, 'userCompletedAt 必须还在');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('平台明确说未完成时：不生效，但**如实告知**，且任务留在待办', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(base('pending')));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      await engine.syncAll({});
      const id = (await engine.upcoming())[0]!.id;

      const r = await engine.setTaskCompleted(id, true);
      assert.equal(r.applied, false);
      assert.equal(r.suppressedByPlatform, true, '"点了没反应"必须可解释');
      assert.equal((await engine.upcoming()).length, 1, '被压制时仍留在待办');

      // 用户的话仍然留着（平台哪天改口了自然生效），但当前被压制
      const stored = (await engine.completed()).length;
      assert.equal(stored, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('撤销：把标记清掉，任务回到待办', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(base('pending', 'inferred')));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      await engine.syncAll({});
      const id = (await engine.upcoming())[0]!.id;

      await engine.setTaskCompleted(id, true);
      assert.equal((await engine.upcoming()).length, 0);

      const back = await engine.setTaskCompleted(id, false);
      assert.equal(back.applied, true);
      assert.equal(back.task.userCompletedAt, undefined, '撤销必须真的把字段清掉');
      assert.equal((await engine.upcoming()).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('标记不存在的任务 → 响亮报错，不静默成功', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(base('pending', 'inferred')));
    try {
      await assert.rejects(() => engine.setTaskCompleted('stub::nope', true), /任务不存在/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isTerminalStatus 的边界', () => {
  it('过期算终态（会进已完成栏），未知不算', () => {
    assert.equal(isTerminalStatus('expired'), true);
    assert.equal(isTerminalStatus('submitted'), true);
    assert.equal(isTerminalStatus('graded'), true);
    assert.equal(isTerminalStatus('pending'), false);
    assert.equal(isTerminalStatus('unknown'), false);
  });
});

describe('canMarkCompleted：按钮只出现在"点了真能生效"的条目上', () => {
  it('平台沉默（雨课堂）→ 有按钮', () => {
    assert.equal(canMarkCompleted(task({ status: 'pending', statusSource: 'inferred' })), true);
  });
  it('平台明确说未完成（超星/雨课堂以外）→ 不给按钮（死按钮比没按钮更糟）', () => {
    assert.equal(canMarkCompleted(task({ status: 'pending', statusSource: 'platform' })), false);
  });
  it('状态未知 → 给按钮（平台等于没说，用户说了算）', () => {
    assert.equal(canMarkCompleted(task({ status: 'unknown', statusSource: 'platform' })), true);
  });
  it('已是终态 → 不给按钮（没什么可标的）', () => {
    assert.equal(canMarkCompleted(task({ status: 'submitted' })), false);
    assert.equal(canMarkCompleted(task({ status: 'expired' })), false);
  });
  it('判据与生效规则同源：有按钮 ⇒ 标了必然生效', () => {
    const cases: Array<Parameters<typeof task>[0]> = [
      { status: 'pending', statusSource: 'inferred' },
      { status: 'pending', statusSource: 'platform' },
      { status: 'unknown', statusSource: 'platform' },
      { status: 'expired', statusSource: 'platform' },
    ];
    for (const c of cases) {
      const t = task(c);
      if (!canMarkCompleted(t)) continue;
      const marked = { ...t, userCompletedAt: MARK };
      assert.equal(effectiveStatus(marked), 'submitted', `有按钮就必须能生效：${JSON.stringify(c)}`);
    }
  });
});

describe('新字段回填：老记录必须能拿到新加的元数据', () => {
  const base = (): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
    taskStatus: 'pending',
    statusSource: 'inferred',
  });

  it('库里缺 statusSource 的老任务：下一轮同步补上，且不算"变更"、不动 revision', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(base()));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      await engine.syncAll({});

      // 模拟"这个任务是在 statusSource 这个字段存在之前入库的"
      const before = (await store.listTasks())[0]!;
      await store.upsertTasks([{ ...before, statusSource: undefined }]);
      const stripped = (await store.listTasks())[0]!;
      assert.equal(stripped.statusSource, undefined);
      const revBefore = stripped.revision;

      await engine.syncAll({});

      const after = (await store.listTasks())[0]!;
      assert.equal(after.statusSource, 'inferred', '新字段必须落到老记录上（否则手动标记会被误压制）');
      assert.equal(after.revision, revBefore, '回填不是内容变更，不能惊动用户');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('已有值绝不被回填覆盖', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(base()));
    try {
      await engine.registerOfflineAccount('stub', 'browser', {});
      await engine.syncAll({});
      const before = (await store.listTasks())[0]!;
      await store.upsertTasks([{ ...before, statusSource: 'platform' }]);

      await engine.syncAll({});

      const after = (await store.listTasks())[0]!;
      assert.equal(after.statusSource, 'platform', '回填只补缺，绝不覆盖已有值');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
