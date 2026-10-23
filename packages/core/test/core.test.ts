/**
 * 核心库单元测试。
 *
 * 重点覆盖三类「看起来简单、实际极易出错」的逻辑：
 *   1. 截止时间解析（时区、边界、脏格式）
 *   2. 幂等合并（主键漂移、假变更、假删除、相对时间锚定）
 *   3. 提醒窗口（补发风暴、去重、改期重置）
 *
 * 运行：node --test packages/core/test/core.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FakeClock,
  normalizeDeadline,
  deadlineInstant,
  effectiveInstant,
  normalizeTitle,
  makeFingerprint,
  mergeTasks,
  materializeTask,
  planReminders,
  DEFAULT_REMINDER_RULES,
  TokenBucket,
  backoffDelay,
  mapLimit,
  EncryptedVault,
  FileKeyProvider,
  StaticKeyProvider,
  MemoryStore,
  DEFAULT_MERGE_OPTIONS,
  createReadOnlyHttpClient,
  createReadOnlyGuardStats,
  isImportedSession,
  mayReauthenticate,
  HubError,
  RecordingHttpClient,
  HarReplayHttpClient,
  CdpConnection,
  discoverCdpTargets,
  pickTargetForOrigin,
  buildPageFetchExpression,
  parseCdpFrame,
} from '../src/index.ts';
import type { HttpClient, CdpTarget, WsLike } from '../src/index.ts';
import { createServer } from 'node:http';
import type { UnifiedTask, PlatformTask, ReminderRule } from '../src/index.ts';

// ---------------------------------------------------------------- 夹具

const NOW = new Date('2026-09-22T12:00:00+08:00');

function task(overrides: Partial<PlatformTask> & { title: string }): PlatformTask {
  return {
    platformTaskId: overrides.platformTaskId ?? 'w1',
    courseId: overrides.courseId ?? 'C1',
    kind: overrides.kind ?? 'homework',
    status: overrides.status ?? 'pending',
    ...overrides,
  };
}

function mat(p: PlatformTask, now = NOW, accountId = 'acc1', platformId = 'test'): UnifiedTask {
  return materializeTask({ platformId, accountId, platformTask: p, now });
}

// ---------------------------------------------------------------- 截止时间

describe('截止时间归一化', () => {
  test('ISO 风格字符串按本地时区解析（不整体偏移 8 小时）', () => {
    const d = normalizeDeadline('2026-09-25 23:59', NOW);
    assert.equal(d.kind, 'absolute');
    if (d.kind !== 'absolute') return;
    const local = new Date(d.at);
    assert.equal(local.getFullYear(), 2026);
    assert.equal(local.getMonth() + 1, 9);
    assert.equal(local.getDate(), 25);
    assert.equal(local.getHours(), 23);
    assert.equal(local.getMinutes(), 59);
  });

  test('只有日期时补全为当天 23:59', () => {
    const d = normalizeDeadline('2026/9/30', NOW);
    assert.equal(d.kind, 'absolute');
    if (d.kind !== 'absolute') return;
    const local = new Date(d.at);
    assert.equal(local.getDate(), 30);
    assert.equal(local.getHours(), 23);
  });

  test('epoch 毫秒 / epoch 秒 / 纯剩余秒数 三档数量级正确区分', () => {
    const ms = normalizeDeadline(1758815940000, NOW);
    assert.equal(ms.kind, 'absolute');

    const sec = normalizeDeadline(1758815940, NOW);
    assert.equal(sec.kind, 'absolute');
    // 秒级与毫秒级应指向同一时刻
    assert.equal(new Date((ms as { at: string }).at).getTime(), new Date((sec as { at: string }).at).getTime());

    // 1800 远小于 1e9，应判为「剩余 1800 分钟」而不是 1970 年的时间戳
    const remain = normalizeDeadline(1800, NOW);
    assert.equal(remain.kind, 'relative');
    assert.equal((remain as { value: number }).value, 1800);
  });

  test('中文相对时长被识别为 relative', () => {
    for (const [text, value, unit] of [
      ['还剩 3 天', 3, 'day'],
      ['剩余2小时', 2, 'hour'],
      [' 30分钟 ', 30, 'minute'],
      ['5天', 5, 'day'],
    ] as const) {
      const d = normalizeDeadline(text, NOW);
      assert.equal(d.kind, 'relative', text);
      if (d.kind !== 'relative') continue;
      assert.equal(d.value, value, text);
      assert.equal(d.unit, unit, text);
    }
  });

  test('开放态词汇被识别为 open', () => {
    for (const text of ['不限时', '未公布', '无期限', '待定', '-', 'N/A']) {
      assert.equal(normalizeDeadline(text, NOW).kind, 'open', text);
    }
  });

  test('无法识别的值保留原文，绝不静默丢弃', () => {
    const d = normalizeDeadline('下周老师说的时候再定', NOW);
    assert.equal(d.kind, 'unknown');
    if (d.kind === 'unknown') assert.equal(d.raw, '下周老师说的时候再定');
  });

  test('空值与非有限数不会抛异常', () => {
    assert.equal(normalizeDeadline(null, NOW).kind, 'unknown');
    assert.equal(normalizeDeadline(undefined, NOW).kind, 'unknown');
    assert.equal(normalizeDeadline('', NOW).kind, 'unknown');
    assert.equal(normalizeDeadline(Number.NaN, NOW).kind, 'unknown');
    assert.equal(normalizeDeadline(-1, NOW).kind, 'unknown');
    assert.equal(normalizeDeadline(new Date('invalid'), NOW).kind, 'unknown');
  });

  test('相对时长可以折算成绝对时刻', () => {
    const d = normalizeDeadline('还剩 3 天', NOW);
    const at = deadlineInstant(d, NOW);
    assert.ok(at);
    assert.equal(at.getTime() - NOW.getTime(), 3 * 86_400_000);
  });

  test('锚点优先于相对时长的重算 —— 这是「任务永远到不了期」的根因修复', () => {
    const d = normalizeDeadline('还剩 3 天', NOW);
    const anchor = '2026-09-25T04:00:00.000Z';

    // 不传锚点：每次都是「现在 + 3 天」，永远到不了期
    const later = new Date(NOW.getTime() + 5 * 86_400_000);
    const withoutAnchor = effectiveInstant(d, undefined, later);
    assert.equal(withoutAnchor?.getTime(), later.getTime() + 3 * 86_400_000);

    // 传了锚点：固定在首次观测时刻
    const withAnchor = effectiveInstant(d, anchor, later);
    assert.equal(withAnchor?.toISOString(), new Date(anchor).toISOString());
    assert.ok(withAnchor!.getTime() < later.getTime(), '应已逾期');
  });
});

// ---------------------------------------------------------------- 指纹与标题

describe('标题归一化与指纹', () => {
  test('剥离结尾括号备注，让「同一份作业」归一到一起', () => {
    assert.equal(normalizeTitle('第三章作业'), normalizeTitle('第三章作业（第2次）'));
    assert.equal(normalizeTitle('第三章 作业'), normalizeTitle('第三章作业'));
    assert.equal(normalizeTitle('第三章作业【补交】'), normalizeTitle('第三章作业'));
  });

  test('指纹不包含状态与截止时间 —— 交作业、改期都不应产生新指纹', () => {
    const base = { platformId: 'p', courseId: 'c', kind: 'homework', title: '第三章作业' };
    const a = makeFingerprint(base);
    const b = makeFingerprint({ ...base, title: '第三章作业（已修改）' });
    assert.equal(a, b);
  });

  test('指纹包含课程 ID —— 不同课程的同名作业不能合并', () => {
    const a = makeFingerprint({ platformId: 'p', courseId: 'C1', kind: 'homework', title: '第三章作业' });
    const b = makeFingerprint({ platformId: 'p', courseId: 'C2', kind: 'homework', title: '第三章作业' });
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------- 合并

describe('幂等合并', () => {
  test('首次合并全部新建', () => {
    const incoming = [mat(task({ title: 'A', platformTaskId: '1' })), mat(task({ title: 'B', platformTaskId: '2' }))];
    const plan = mergeTasks([], incoming);
    assert.equal(plan.created, 2);
    assert.equal(plan.updated, 0);
    assert.equal(plan.writes.length, 2);
  });

  test('内容不变时既不新建也不更新（幂等）', () => {
    const first = mergeTasks([], [mat(task({ title: 'A', deadline: '2026-09-25 23:59' }))]);
    const second = mergeTasks(first.writes, [mat(task({ title: 'A', deadline: '2026-09-25 23:59' }))]);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(second.writes.length, 0, '内容无变化时不应该产生任何写操作');
  });

  test('毫秒级时间抖动不产生假变更（按分钟对齐比较）', () => {
    const a = mat(task({ title: 'A', deadline: '2026-09-25 23:59:00' }));
    const b = mat(task({ title: 'A', deadline: '2026-09-25 23:59:29' }));
    const plan = mergeTasks([a], [b]);
    assert.equal(plan.updated, 0, '同分钟内的时间差应视为无变化');
    assert.equal(plan.unchanged, 1);
  });

  test('截止时间真变化时递增 revision 并记录变更历史', () => {
    const before = mat(task({ title: 'A', deadline: '2026-09-25 23:59' }));
    const after = mat(task({ title: 'A', deadline: '2026-09-30 23:59' }));
    const plan = mergeTasks([before], [after]);

    assert.equal(plan.updated, 1);
    const merged = plan.writes[0]!;
    assert.equal(merged.revision, before.revision + 1);
    assert.equal(merged.id, before.id, '主键必须保持稳定');
    assert.equal(merged.firstSeenAt, before.firstSeenAt, '首次出现时间不能被覆盖');
    const change = merged.history.find((h) => h.field === 'deadline');
    assert.ok(change, '应记录 deadline 变更');
  });

  test('平台换 ID 时用指纹匹配，不产生重复记录', () => {
    const before = mat(task({ title: 'A', platformTaskId: 'old-id' }));
    const after = mat(task({ title: 'A', platformTaskId: 'new-id' }));
    const plan = mergeTasks([before], [after]);

    assert.equal(plan.created, 0, '换了 ID 也不应新建');
    assert.equal(plan.updated, 0, '内容没变就不算更新');
    assert.equal(plan.unchanged, 1);
  });

  test('无平台 ID 的任务走指纹主键', () => {
    const t = mat(task({ title: '实验报告', platformTaskId: undefined as unknown as string }));
    // platformTaskId 为 undefined 时 materializeTask 用 fp_ 前缀兜底
    const explicit = materializeTask({
      platformId: 'test',
      accountId: 'acc1',
      platformTask: { courseId: 'C1', kind: 'homework', title: '实验报告' },
      now: NOW,
    });
    assert.ok(explicit.platformTaskId.startsWith('fp_'));
    assert.ok(t.id.length > 0);
  });

  test('一次缺席只标记不删除，连续缺席达阈值才软删除', () => {
    const existing = [mat(task({ title: 'A', platformTaskId: '1' }))];

    const first = mergeTasks(existing, [], { ...DEFAULT_MERGE_OPTIONS, absenceThreshold: 2 });
    assert.equal(first.vanished, 1);
    assert.equal(first.removed, 0);
    assert.equal(first.writes[0]!.absentCount, 1);
    assert.equal(first.writes[0]!.deletedAt, undefined);

    const second = mergeTasks(first.writes, [], { ...DEFAULT_MERGE_OPTIONS, absenceThreshold: 2 });
    assert.equal(second.removed, 1);
    assert.ok(second.writes[0]!.deletedAt, '应被软删除');
  });

  test('skipRemovalDetection 时不做删除判定（数据不完整场景）', () => {
    const existing = [mat(task({ title: 'A', platformTaskId: '1' }))];
    const plan = mergeTasks(existing, [], { ...DEFAULT_MERGE_OPTIONS, skipRemovalDetection: true });
    assert.equal(plan.removed, 0);
    assert.equal(plan.vanished, 0);
    assert.equal(plan.writes.length, 0);
  });

  test('重新出现时从软删除状态恢复', () => {
    const existing = [{ ...mat(task({ title: 'A', platformTaskId: '1' })), absentCount: 3, deletedAt: '2026-09-20T00:00:00.000Z' }];
    const plan = mergeTasks(existing, [mat(task({ title: 'A', platformTaskId: '1' }))]);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.writes[0]!.deletedAt, undefined, '应清除删除标记');
    assert.equal(plan.events[0]!.type, 'restored');
  });

  test('「还剩 3 天」的自然衰减不产生假变更，且锚点不被重置', () => {
    const first = materializeTask({
      platformId: 'test',
      accountId: 'acc1',
      platformTask: { courseId: 'C1', kind: 'homework', title: '讨论', platformTaskId: '1', deadline: '还剩 3 天' },
      now: NOW,
    });
    const anchor = first.deadlineAt!;
    assert.ok(anchor, '相对截止时间必须有锚点');

    // 三天零一小时后再同步，平台仍返回「还剩 3 天」
    const later = new Date(NOW.getTime() + 3 * 86_400_000 + 3_600_000);
    const second = materializeTask({
      platformId: 'test',
      accountId: 'acc1',
      platformTask: { courseId: 'C1', kind: 'homework', title: '讨论', platformTaskId: '1', deadline: '还剩 3 天' },
      now: later,
    });

    const plan = mergeTasks([first], [second]);
    assert.equal(plan.updated, 0, '时间自然流逝不是变更');
    assert.equal(plan.writes.length, 0);

    // 锚定后任务确实已经到期，而不是永远「还剩 3 天」
    const dueAt = effectiveInstant(first.deadline, anchor, later);
    assert.ok(dueAt && dueAt.getTime() < later.getTime(), '应已逾期');
  });

  test('平台把倒计时改大（老师延后）时重新锚定并记为变更', () => {
    const first = materializeTask({
      platformId: 'test',
      accountId: 'acc1',
      platformTask: { courseId: 'C1', kind: 'homework', title: '讨论', platformTaskId: '1', deadline: '还剩 1 天' },
      now: NOW,
    });
    const second = materializeTask({
      platformId: 'test',
      accountId: 'acc1',
      platformTask: { courseId: 'C1', kind: 'homework', title: '讨论', platformTaskId: '1', deadline: '还剩 7 天' },
      now: NOW,
    });

    const plan = mergeTasks([first], [second]);
    assert.equal(plan.updated, 1, '倒计时变大是真改期');
    assert.ok(plan.writes[0]!.history.some((h) => h.field === 'deadline'));
  });

  test('跨账号互不干扰 —— 主键必须包含账号维度', () => {
    const a = mat(task({ title: 'A', platformTaskId: '1' }), NOW, 'acc1');
    const b = mat(task({ title: 'A', platformTaskId: '1' }), NOW, 'acc2');
    assert.notEqual(a.id, b.id, '不同账号下同名平台 ID 不能生成同一个主键');

    const plan = mergeTasks([a], [b]);
    assert.equal(plan.created, 1, '同一平台任务 ID 在不同账号下是两条记录');
    assert.equal(plan.updated, 0, '不应把 acc1 的记录当成 acc2 的更新目标');
  });

  test('同一账号内 fingerprint 匹配不会串课程', () => {
    const c1 = mat(task({ title: '第三章作业', platformTaskId: 'x1', courseId: 'C1' }));
    const c2 = mat(task({ title: '第三章作业', platformTaskId: 'x2', courseId: 'C2' }));
    const plan = mergeTasks([c1], [c2]);
    assert.equal(plan.created, 1, '不同课程的同名作业是两条记录');
  });
});

// ---------------------------------------------------------------- 提醒

describe('提醒调度', () => {
  const rules: ReminderRule[] = [
    { id: 'hw', label: '作业', kinds: ['homework'], offsets: [{ value: 2, unit: 'day' }, { value: 1, unit: 'day' }, { value: 3, unit: 'hour' }, { value: 1, unit: 'hour' }] },
  ];

  function withDeadline(deadline: string, id = '1'): UnifiedTask {
    return mat({ platformTaskId: id, courseId: 'C1', title: 'A', kind: 'homework', deadline });
  }

  test('未进入任何窗口时不提醒', () => {
    const t = withDeadline('2026-09-30 23:59'); // 8 天后
    assert.equal(planReminders([t], NOW, { rules, sentKeys: new Set() }).length, 0);
  });

  test('进入窗口后只发最紧的一条，并消费掉更宽松的窗口', () => {
    // 截止还剩 30 分钟 → 2d/1d/3h/1h 四个窗口全部满足，发最紧的 T-1h。
    // （此前这个夹具用 +2h，依赖了一个把 ISO 按本地时间重解析的 bug 才落到 T-1h；
    //   时区修正后它只满足到 T-3h，所以这里改成真正处于 1h 窗口内的时刻。）
    const t = withDeadline(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    const planned = planReminders([t], NOW, { rules, sentKeys: new Set() });

    assert.equal(planned.length, 1, '每轮每任务最多一条，避免补发风暴');
    assert.equal(planned[0]!.windowId, 'T-1h');
    assert.equal(planned[0]!.consumedKeys.length, 3, '其余三个窗口应被标记消费');
  });

  test('已发送过的提醒不会重复发送', () => {
    const t = withDeadline(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    const first = planReminders([t], NOW, { rules, sentKeys: new Set() });
    const sent = new Set([first[0]!.key, ...first[0]!.consumedKeys]);

    // 时间稍后再跑一次，所有 key 都已记录
    const again = planReminders([t], new Date(NOW.getTime() + 60_000), { rules, sentKeys: sent });
    assert.equal(again.length, 0);
  });

  test('截止时间变化后重新提醒（key 含截止时间）', () => {
    const before = withDeadline('2026-09-25 23:59');
    const sent = new Set([planReminders([before], NOW, { rules, sentKeys: new Set() })[0]?.key ?? 'none']);

    // 老师把截止时间提前到 2 小时后
    const after = { ...before, deadline: normalizeDeadline(new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), NOW) };
    const planned = planReminders([after], NOW, { rules, sentKeys: sent });
    assert.equal(planned.length, 1, '改期后应重新提醒');
  });

  test('已提交的任务不再提醒', () => {
    const t = { ...withDeadline(new Date(NOW.getTime() + 3_600_000).toISOString()), status: 'submitted' as const };
    assert.equal(planReminders([t], NOW, { rules, sentKeys: new Set() }).length, 0);
  });

  test('开放态与未知截止时间不参与时间轴提醒', () => {
    const open = withDeadline('不限时', 'o1');
    const unknown = withDeadline('等通知', 'u1');
    assert.equal(planReminders([open, unknown], NOW, { rules, sentKeys: new Set() }).length, 0);
  });

  test('逾期任务在宽限期内仍提醒，超出后静默', () => {
    const t = withDeadline(new Date(NOW.getTime() - 86_400_000).toISOString());
    const withinGrace = planReminders([t], NOW, { rules, sentKeys: new Set(), overdueGraceDays: 3 });
    assert.equal(withinGrace.length, 1);
    assert.match(withinGrace[0]!.body, /已逾期/);

    const beyond = withDeadline(new Date(NOW.getTime() - 10 * 86_400_000).toISOString(), 't2');
    assert.equal(planReminders([beyond], NOW, { rules, sentKeys: new Set(), overdueGraceDays: 3 }).length, 0);
  });

  test('默认规则集按任务类型给出不同窗口，且只发最紧的一条', () => {
    // 6 天后考试：只有 T-7d 窗口满足
    const exam = mat({ platformTaskId: 'e1', courseId: 'C1', title: '期末', kind: 'exam', deadline: '2026-09-28 09:00' });
    const examPlan = planReminders([exam], NOW, { sentKeys: new Set() });
    assert.equal(examPlan.length, 1);
    assert.equal(examPlan[0]!.ruleId, 'exam');
    assert.equal(examPlan[0]!.windowId, 'T-7d');

    // 同一时间的作业：作业规则最宽只到 T-2d，此时不应提醒
    const hw = mat({ platformTaskId: 'h1', courseId: 'C1', title: '作业', kind: 'homework', deadline: '2026-09-28 09:00' });
    assert.equal(planReminders([hw], NOW, { sentKeys: new Set() }).length, 0);

    // 任务点走第三条规则
    const tp = mat({ platformTaskId: 't1', courseId: 'C1', title: '视频', kind: 'task-point', deadline: '2026-09-25 09:00' });
    const tpPlan = planReminders([tp], NOW, { sentKeys: new Set() });
    assert.equal(tpPlan.length, 1);
    assert.equal(tpPlan[0]!.ruleId, 'task-point');

    assert.equal(DEFAULT_REMINDER_RULES.length >= 3, true);
  });
});

// ---------------------------------------------------------------- 限流与重试

describe('限流与退避', () => {
  test('令牌桶限制速率', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 100, burst: 2 });
    const t0 = Date.now();
    await bucket.acquire();
    await bucket.acquire();
    assert.equal(bucket.available(), 0);
    const waited = await bucket.acquire(); // 第三个必须等
    assert.ok(waited > 0, '超过桶容量后必须等待');
    assert.ok(Date.now() - t0 >= waited);
  });

  test('惩罚后进入冷却并清空令牌', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 1000, burst: 10 });
    bucket.penalize(60);
    assert.equal(bucket.available(), 0);
    const waited = await bucket.acquire();
    assert.ok(waited >= 50, `应等待冷却时间，实际 ${waited}ms`);
  });

  test('指数退避带抖动且有上限', () => {
    const policy = { attempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    for (let i = 1; i <= 5; i += 1) {
      const d = backoffDelay(i, policy);
      assert.ok(d > 0 && d <= 1000, `第 ${i} 次退避 ${d}ms 超出范围`);
    }
    // 抖动：同一次尝试的延迟不应恒定
    const samples = new Set(Array.from({ length: 20 }, () => backoffDelay(3, policy)));
    assert.ok(samples.size > 1, '应带随机抖动，避免多账号齐步重试');
  });

  test('并发池限制并发数且保持结果顺序', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 10;
    });
    assert.equal(peak, 2, `峰值并发应为 2，实际 ${peak}`);
    assert.deepEqual(result, [10, 20, 30, 40, 50, 60], '结果顺序必须与输入一致');
  });
});

// ---------------------------------------------------------------- 保险箱

describe('加密会话保险箱', () => {
  test('读回一致，且密文中不含明文机密', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-vault-'));
    try {
      const keyPath = join(dir, 'master.key');
      const vault = new EncryptedVault({ directory: join(dir, 'sessions'), keyProvider: new FileKeyProvider(keyPath) });

      const session = {
        platformId: 'chaoxing',
        accountId: 'chaoxing::20230001',
        cookies: { JSESSIONID: 'SUPER-SECRET-TOKEN-VALUE', _uid: '12345' },
        headers: { Authorization: 'Bearer TOP-SECRET-BEARER' },
        issuedAt: NOW.toISOString(),
      };

      await vault.save(session);
      const loaded = await vault.load(session.accountId);
      assert.deepEqual(loaded?.cookies, session.cookies);
      assert.deepEqual(loaded?.headers, session.headers);

      const inspect = await vault.debugInspect(session.accountId);
      assert.equal(inspect.exists, true);
      assert.equal(inspect.leaksPlaintext, false, '密文里不应出现明文账号');

      // 直接读原始文件，确认机密字符串确实不在里面
      const { readdir } = await import('node:fs/promises');
      const files = (await readdir(join(dir, 'sessions'))).filter((f) => f.endsWith('.session.enc'));
      assert.equal(files.length, 1);
      const raw = await readFile(join(dir, 'sessions', files[0]!), 'utf8');
      assert.ok(!raw.includes('SUPER-SECRET-TOKEN-VALUE'), '明文 token 泄露到磁盘了');
      assert.ok(!raw.includes('TOP-SECRET-BEARER'), '明文 bearer 泄露到磁盘了');
      assert.equal(await vault.load('不存在的账号'), undefined);
      assert.deepEqual(await vault.list(), [session.accountId]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('更换主密钥后解密失败并给出可操作提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-vault-'));
    try {
      const a = new EncryptedVault({ directory: dir, keyProvider: new StaticKeyProvider('key-a') });
      const b = new EncryptedVault({ directory: dir, keyProvider: new StaticKeyProvider('key-b') });
      await a.save({
        platformId: 'p',
        accountId: 'acc',
        cookies: {},
        headers: {},
        issuedAt: NOW.toISOString(),
      });
      await assert.rejects(() => b.load('acc'), /解密失败/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('删除会话后不再可读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-vault-'));
    try {
      const vault = new EncryptedVault({ directory: dir, keyProvider: new StaticKeyProvider() });
      await vault.save({ platformId: 'p', accountId: 'acc', cookies: {}, headers: {}, issuedAt: NOW.toISOString() });
      await vault.remove('acc');
      assert.equal(await vault.load('acc'), undefined);
      assert.deepEqual(await vault.list(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 存储

describe('存储层幂等性', () => {
  test('同一批任务重复 upsert 不产生重复记录', async () => {
    const store = new MemoryStore();
    await store.init();
    const t = mat(task({ title: 'A', platformTaskId: '1' }));

    const first = await store.upsertTasks([t]);
    assert.equal(first.created, 1);
    const second = await store.upsertTasks([t]);
    assert.equal(second.created, 0);
    assert.equal((await store.listTasks()).length, 1);
  });

  test('软删除的记录默认不可见，但可显式查询', async () => {
    const store = new MemoryStore();
    const t = mat(task({ title: 'A', platformTaskId: '1' }));
    await store.upsertTasks([t]);
    await store.softDeleteTasks([t.id], NOW.toISOString());

    assert.equal((await store.listTasks()).length, 0);
    assert.equal((await store.listTasks({ includeDeleted: true })).length, 1);
  });

  test('提醒记录按 key 去重', async () => {
    const store = new MemoryStore();
    const record = {
      key: 'k1',
      taskId: 't1',
      ruleId: 'r',
      accountId: 'a',
      sentAt: NOW.toISOString(),
      revision: 1,
      channel: 'default',
      title: 'x',
    };
    await store.recordReminders([record]);
    await store.recordReminders([record]);
    assert.equal((await store.listReminders()).length, 1);
    assert.equal(await store.hasReminder('k1'), true);
  });
});

// ---------------------------------------------------------------- 只读守卫

describe('只读守卫', () => {
  /** 记录所有真正被发出去的请求，用来证明「被拦截的请求根本没到传输层」。 */
  function spyClient() {
    const sent: Array<{ method: string; url: string }> = [];
    return {
      sent,
      client: {
        async request(req: { url: string; method?: string }) {
          sent.push({ method: (req.method ?? 'GET').toUpperCase(), url: req.url });
          return {
            status: 200,
            headers: {},
            url: req.url,
            setCookies: [],
            text: async () => '{}',
            json: async <T>() => ({}) as T,
            bytes: async () => new Uint8Array(),
          };
        },
      },
    };
  }

  const policy = {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [
      { pattern: /\/login$/, why: '登录' },
      { pattern: /\/api\/courses$/, why: '查询课程（只读）' },
      { pattern: /\/submit$/, why: '故意误配 —— 用来验证黑名单兜底' },
    ],
  };

  test('默认只允许 GET / HEAD', async () => {
    const spy = spyClient();
    const guarded = createReadOnlyHttpClient(spy.client, { platformId: 'test' });

    const res = await guarded.request({ url: 'https://x/api/list', method: 'GET' }, { platformId: 'test' });
    assert.equal(res.status, 200);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await assert.rejects(
        () => guarded.request({ url: 'https://x/api/list', method }, { platformId: 'test' }),
        (e: unknown) => e instanceof HubError && e.code === 'WRITE_BLOCKED',
        `${method} 应被拦截`,
      );
    }
    assert.equal(spy.sent.length, 1, '被拦截的请求不应到达传输层');
  });

  test('显式声明的只读 POST 被放行', async () => {
    const spy = spyClient();
    const guarded = createReadOnlyHttpClient(spy.client, { platformId: 'test', policy });

    await guarded.request({ url: 'https://x/api/courses', method: 'POST' }, { platformId: 'test' });
    await guarded.request({ url: 'https://x/login', method: 'POST' }, { platformId: 'test' });
    assert.equal(spy.sent.length, 2);
  });

  test('黑名单优先级高于白名单（防一处误配就破坏整个承诺）', async () => {
    const spy = spyClient();
    const guarded = createReadOnlyHttpClient(spy.client, { platformId: 'test', policy });

    // /submit 明明在 allowPost 里，但默认黑名单会先把它拦下
    await assert.rejects(
      () => guarded.request({ url: 'https://x/submit', method: 'POST' }, { platformId: 'test' }),
      (e: unknown) => e instanceof HubError && e.code === 'WRITE_BLOCKED',
    );
    assert.equal(spy.sent.length, 0);
  });

  test('覆盖签到 / 提交 / 已读回执 / 学习打点等危险路径', async () => {
    const spy = spyClient();
    const guarded = createReadOnlyHttpClient(spy.client, { platformId: 'test' });

    const dangerous = [
      'https://x/work/submit',
      'https://x/exam/handin',
      'https://x/api/qiandao',
      'https://x/api/sign-in',
      'https://x/notice/mark-read',
      'https://x/api/study-record',
      'https://x/api/heartbeat',
      'https://x/api/logout',
      'https://x/api/course/delete',
    ];
    for (const url of dangerous) {
      await assert.rejects(
        () => guarded.request({ url, method: 'GET' }, { platformId: 'test' }),
        (e: unknown) => e instanceof HubError && e.code === 'WRITE_BLOCKED',
        `${url} 应被拦截（即使方法看起来安全）`,
      );
    }
    assert.equal(spy.sent.length, 0);
  });

  test('把动作参数藏进 query 同样被拦截', async () => {
    const guarded = createReadOnlyHttpClient(spyClient().client, { platformId: 'test' });
    await assert.rejects(
      () => guarded.request({ url: 'https://x/api/list?action=submit&id=1', method: 'GET' }, { platformId: 'test' }),
      (e: unknown) => e instanceof HubError && e.code === 'WRITE_BLOCKED',
    );
  });

  test('统计可被观测：正常读取不产生拦截', async () => {
    const stats = createReadOnlyGuardStats();
    const guarded = createReadOnlyHttpClient(spyClient().client, { platformId: 'test', policy, stats });

    await guarded.request({ url: 'https://x/api/courses', method: 'GET' }, { platformId: 'test' });
    await guarded.request({ url: 'https://x/login', method: 'POST' }, { platformId: 'test' });

    assert.equal(stats.checked, 2);
    assert.equal(stats.blocked, 0);
    assert.equal(stats.allowedNonSafe, 1);
    assert.deepEqual(stats.blockedDetails, []);
  });

  test('拦截时会记录明细，便于定位是哪段代码在尝试写', async () => {
    const stats = createReadOnlyGuardStats();
    const guarded = createReadOnlyHttpClient(spyClient().client, { platformId: 'test', stats });
    await assert.rejects(() => guarded.request({ url: 'https://x/work/submit', method: 'POST' }, { platformId: 'test' }));
    assert.equal(stats.blocked, 1);
    assert.match(stats.blockedDetails[0] ?? '', /POST/);
    assert.match(stats.blockedDetails[0] ?? '', /submit/);
  });
});

describe('会话来源策略', () => {
  const base = {
    platformId: 'p',
    accountId: 'a',
    cookies: {},
    headers: {},
    issuedAt: NOW.toISOString(),
  };

  test('用户提供的会话被识别为 imported，且不允许我们替他重新登录', () => {
    const imported = { ...base, origin: 'imported' as const };
    assert.equal(isImportedSession(imported), true);
    assert.equal(mayReauthenticate(imported), false, '这是同时顶掉用户正在用客户端的风险点');
  });

  test('独立登录的会话允许重新登录', () => {
    const derived = { ...base, origin: 'derived' as const };
    assert.equal(isImportedSession(derived), false);
    assert.equal(mayReauthenticate(derived), true);
  });

  test('未声明来源时保守处理：不允许自动重新登录', () => {
    assert.equal(mayReauthenticate(base), true, '未声明时按 derived 处理，但引擎不会保存密码所以也无法自动登录');
    assert.equal(isImportedSession(base), false);
  });
});

// ---------------------------------------------------------------- 零影响传输：HAR 录制与回放

describe('HAR 录制与回放', () => {
  /** 一个可控的假传输层，返回预设响应并记录收到的请求。 */
  function fakeUpstream(responses: Record<string, { status: number; body: string; setCookie?: string[] }>) {
    const received: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    return {
      received,
      client: {
        async request(req: { url: string; method?: string; headers?: Record<string, string> }) {
          const method = (req.method ?? 'GET').toUpperCase();
          received.push({ method, url: req.url, headers: req.headers ?? {} });
          const hit = responses[`${method} ${req.url}`];
          if (!hit) {
            throw new Error(`fakeUpstream 没有配置 ${method} ${req.url} —— 测试写错了`);
          }
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (hit.setCookie) headers['set-cookie'] = hit.setCookie[0] ?? '';
          return {
            status: hit.status,
            headers,
            url: req.url,
            setCookies: hit.setCookie ?? [],
            text: async () => hit.body,
            json: async <T>() => JSON.parse(hit.body) as T,
            bytes: async () => new TextEncoder().encode(hit.body),
          };
        },
      },
    };
  }

  const SESSION_COOKIE = 'SESSION_TOKEN_ABC123';

  function makeUpstream() {
    return fakeUpstream({
      'GET https://p.example.edu/api/user': { status: 200, body: '{"username":"20230001"}' },
      'GET https://p.example.edu/api/courses': {
        status: 200,
        body: '[{"id":"C1","name":"数据库"}]',
        setCookie: [`${SESSION_COOKIE}=rotated; HttpOnly`, 'TRACKING_ID=x'],
      },
      'GET https://p.example.edu/api/tasks?page=1': {
        status: 200,
        body: '[{"id":"w1","title":"作业一","deadline":"2026-09-25 23:59"}]',
      },
      'GET https://p.example.edu/api/tasks?page=2': {
        status: 200,
        body: '[{"id":"w2","title":"作业二","deadline":"2026-09-30 23:59"}]',
      },
      'GET https://p.example.edu/api/tasks?page=3': { status: 500, body: 'boom' },
    });
  }

  test('录制 → 回放，产出字节级相同的响应', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);

    // 用与真实同步相同的顺序请求
    const urls = [
      'https://p.example.edu/api/user',
      'https://p.example.edu/api/courses',
      'https://p.example.edu/api/tasks?page=1',
      'https://p.example.edu/api/tasks?page=2',
    ];
    const live: string[] = [];
    for (const url of urls) {
      const res = await recorder.request({ url, method: 'GET', headers: { Cookie: 'SECRET=1' } }, { platformId: 'p' });
      live.push(await res.text());
    }

    const har = recorder.toHar();
    const replay = new HarReplayHttpClient(har);

    // 上游此刻「下线」：换掉 fakeUpstream，让任何真实网络访问直接失败
    let networkTouched = false;
    const offline: HttpClient = {
      async request() {
        networkTouched = true;
        throw new Error('回放期间不应该有任何网络请求');
      },
    };

    const replayed: string[] = [];
    for (const url of urls) {
      const res = await offlineAware(replay).request({ url, method: 'GET' }, { platformId: 'p' });
      replayed.push(await res.text());
    }

    assert.equal(networkTouched, false, '回放期间触碰了网络');
    assert.deepEqual(replayed, live, '回放的响应体应与录制时完全一致');
  });

  /** 守卫的顺序无关性验证辅助：确保回放客户端独立可用。 */
  function offlineAware(c: HttpClient): HttpClient {
    return c;
  }

  test('录制的 HAR 默认脱敏，绝不含登录凭证', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);

    await recorder.request(
      { url: 'https://p.example.edu/api/courses', method: 'GET', headers: { Cookie: 'SECRET=1', Authorization: 'Bearer X' } },
      { platformId: 'p' },
    );

    const har = recorder.toHar();
    assert.equal(recorder.containsSensitiveHeaders(), false, 'containsSensitiveHeaders 判定为有泄露');
    assert.ok(!har.includes('SECRET=1'), '请求 Cookie 泄露到了 HAR');
    assert.ok(!har.includes('Bearer X'), 'Authorization 泄露到了 HAR');
    assert.ok(!har.includes(SESSION_COOKIE), '响应 Set-Cookie 泄露到了 HAR');
    assert.ok(!har.includes('TRACKING_ID'), '追踪 cookie 泄露到了 HAR');
    // 但响应体必须保留 —— 那是回放的唯一价值
    // （JSON.stringify 会把响应体里的引号转义成 \"，所以只检查内容本身）
    assert.ok(har.includes('数据库'), '响应体不应被误删');
  });

  test('脱敏后仍能正常回放（证明凭证对回放毫无用处）', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);
    await recorder.request({ url: 'https://p.example.edu/api/tasks?page=1', method: 'GET', headers: { Cookie: 'SECRET=1' } }, { platformId: 'p' });

    const replay = new HarReplayHttpClient(recorder.toHar());
    const res = await replay.request({ url: 'https://p.example.edu/api/tasks?page=1', method: 'GET' }, { platformId: 'p' });
    const body = (await res.json()) as Array<{ id: string }>;
    assert.equal(res.status, 200);
    assert.equal(body[0]!.id, 'w1');
  });

  test('query 不同但 path 相同的分页请求，按顺序兜底匹配', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);
    for (const page of [1, 2]) {
      await recorder.request({ url: `https://p.example.edu/api/tasks?page=${page}`, method: 'GET' }, { platformId: 'p' });
    }

    const replay = new HarReplayHttpClient(recorder.toHar());
    const first = await (await replay.request({ url: 'https://p.example.edu/api/tasks?page=99', method: 'GET' }, { platformId: 'p' })).json<unknown[]>();
    const second = await (await replay.request({ url: 'https://p.example.edu/api/tasks?page=77', method: 'GET' }, { platformId: 'p' })).json<unknown[]>();

    assert.equal((first[0] as { id: string }).id, 'w1', '第一页应对上第一条录制');
    assert.equal((second[0] as { id: string }).id, 'w2', '第二页应对上第二条录制（不能重复取第一条）');
    assert.equal(replay.stats.pathHits, 2);
  });

  test('录制失败的请求（5xx）默认被跳过，不会污染回放', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);
    await recorder.request({ url: 'https://p.example.edu/api/tasks?page=3', method: 'GET' }, { platformId: 'p' });

    const replay = new HarReplayHttpClient(recorder.toHar());
    assert.equal(replay.stats.total, 0, '500 的条目不应进入回放索引');
    await assert.rejects(
      () => replay.request({ url: 'https://p.example.edu/api/tasks?page=3', method: 'GET' }, { platformId: 'p' }),
      (e: unknown) => e instanceof HubError && e.code === 'CAPTURE_MISS',
    );
  });

  test('回放未录制的请求时显式报错，并列出已录制的 URL', async () => {
    const upstream = makeUpstream();
    const recorder = new RecordingHttpClient(upstream.client);
    await recorder.request({ url: 'https://p.example.edu/api/user', method: 'GET' }, { platformId: 'p' });

    const replay = new HarReplayHttpClient(recorder.toHar());
    try {
      await replay.request({ url: 'https://p.example.edu/api/grades', method: 'GET' }, { platformId: 'p' });
      assert.fail('应该抛出 CAPTURE_MISS');
    } catch (e) {
      assert.ok(e instanceof HubError && e.code === 'CAPTURE_MISS', `实际 ${(e as Error).message}`);
      assert.match((e as Error).message, /\/api\/user/, '应列出已录制的 URL 帮助定位');
    }
  });

  test('非 HAR 文件给出可操作的错误提示', () => {
    assert.throws(() => new HarReplayHttpClient('{"foo":1}'), /Save all as HAR/);
    assert.throws(() => new HarReplayHttpClient('not json at all'), /不是合法 JSON/);
  });
});

// ---------------------------------------------------------------- 零影响传输：CDP 附着

describe('CDP 附着传输', () => {
  test('按 origin 挑选标签页，且只认 page 类型', () => {
    const targets: CdpTarget[] = [
      { id: '1', title: '新标签页', url: 'chrome://newtab', type: 'page', webSocketDebuggerUrl: 'ws://a' },
      { id: '2', title: '学习通', url: 'https://mooc1.chaoxing.com/visit/study', type: 'page', webSocketDebuggerUrl: 'ws://b' },
      { id: '3', title: 'service worker', url: 'https://mooc1.chaoxing.com/sw', type: 'service_worker', webSocketDebuggerUrl: 'ws://c' },
      { id: '4', title: '其他站', url: 'https://other.example.com/x', type: 'page', webSocketDebuggerUrl: 'ws://d' },
    ];

    const picked = pickTargetForOrigin(targets, 'https://mooc1.chaoxing.com/mooc-ans/work/getAllWork');
    assert.equal(picked?.id, '2', '应命中同源且为 page 类型的标签页');

    assert.equal(pickTargetForOrigin(targets, 'https://unknown.example.com/x'), undefined);
    assert.equal(pickTargetForOrigin(targets, '不是URL'), undefined);
  });

  test('页面 fetch 表达式正确注入参数，且凭据总是 include', () => {
    const expr = buildPageFetchExpression({
      url: 'https://p.example.edu/api/tasks?cursor=0',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'courseId=C1',
    });

    assert.ok(expr.includes('"https://p.example.edu/api/tasks?cursor=0"'), 'URL 应以 JSON 字面量注入');
    assert.ok(expr.includes('credentials: \'include\''), '必须带 cookie —— 这是凭据不过手的核心');
    assert.ok(expr.includes('JSON.stringify({ status'), '应返回结构化结果而非裸文本');
    // 引号注入防护：URL 里带引号也不会破坏表达式
    const evil = buildPageFetchExpression({ url: 'https://p/x"); alert(1); ("', method: 'GET' });
    assert.ok(!evil.includes('alert(1); ("'), '恶意 URL 不能逃逸出字符串');
  });

  test('CDP 报文解析：正常响应 / 页面异常 / CDP 错误 / 事件 / 坏消息', () => {
    const ok = parseCdpFrame('{"id":7,"result":{"result":{"type":"string","value":"{\\"status\\":200}"}}}');
    assert.equal(ok.kind, 'response');
    assert.ok(ok.kind === 'response' && ok.ok && ok.id === 7);
    assert.ok(ok.kind === 'response' && ok.value === '{"status":200}');

    const pageError = parseCdpFrame('{"id":1,"result":{"exceptionDetails":{"text":"Uncaught"}}}');
    assert.ok(pageError.kind === 'response' && !pageError.ok);

    const cdpError = parseCdpFrame('{"id":2,"error":{"message":"Not found"}}');
    assert.ok(cdpError.kind === 'response' && !cdpError.ok && cdpError.error === 'Not found');

    const event = parseCdpFrame('{"method":"Page.frameNavigated","params":{}}');
    assert.equal(event.kind, 'event');

    const bad = parseCdpFrame('not json');
    assert.equal(bad.kind, 'unknown');
  });

  test('evaluate 的请求/响应按 id 配对，互不串扰', async () => {
    const sent: string[] = [];
    const fakeWs: WsLike = {
      send(data) {
        sent.push(data);
        const { id } = JSON.parse(data) as { id: number };
        // 模拟浏览器：先回一个无关事件，再回响应（顺序颠倒也要能配对）
        setTimeout(() => {
          fakeWs.onmessage?.('{"method":"Runtime.executionContextCreated","params":{}}');
          fakeWs.onmessage?.(
            JSON.stringify({ id, result: { result: { type: 'string', value: `answer-${id}` } } }),
          );
        }, 1);
      },
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };

    const conn = await CdpConnection.connect('ws://fake', { wsFactory: async () => fakeWs });
    const [a, b] = await Promise.all([conn.evaluate<string>('x'), conn.evaluate<string>('y')]);
    assert.equal(a, 'answer-1');
    assert.equal(b, 'answer-2');
    assert.equal(sent.length, 2);
    conn.close();
  });

  test('页面抛异常会把错误传回来，而不是静默返回空', async () => {
    const fakeWs: WsLike = {
      send(data) {
        const { id } = JSON.parse(data) as { id: number };
        setTimeout(() => {
          fakeWs.onmessage?.(
            JSON.stringify({
              id,
              result: { exceptionDetails: { exception: { description: 'TypeError: Failed to fetch' } } },
            }),
          );
        }, 1);
      },
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };

    const conn = await CdpConnection.connect('ws://fake', { wsFactory: async () => fakeWs });
    await assert.rejects(() => conn.evaluate('fetch(...)'), /Failed to fetch/);
    conn.close();
  });

  test('连接关闭后挂起的调用会收到明确错误', async () => {
    const fakeWs: WsLike = {
      send() {
        setTimeout(() => fakeWs.onclose?.(), 1);
      },
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    const conn = await CdpConnection.connect('ws://fake', { wsFactory: async () => fakeWs });
    await assert.rejects(() => conn.evaluate('x'), /连接已关闭/);
  });

  test('发现目标接口走的是普通 HTTP，可独立验证', async () => {
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/json/list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { id: 't1', title: '学习通', url: 'https://mooc1.chaoxing.com/x', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/t1' },
          ]),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    try {
      const targets = await discoverCdpTargets(`http://127.0.0.1:${port}`);
      assert.equal(targets.length, 1);
      assert.equal(targets[0]!.type, 'page');
      assert.equal(pickTargetForOrigin(targets, 'https://mooc1.chaoxing.com/y')?.id, 't1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('调试端口不可达时给出可操作的提示', async () => {
    // 用一个几乎肯定没监听的端口
    await assert.rejects(
      () => discoverCdpTargets('http://127.0.0.1:9'),
      (e: unknown) => e instanceof HubError && e.code === 'NOT_SUPPORTED' && /remote-debugging-port/.test(e.message),
    );
  });
});

// ---------------------------------------------------------------- 时钟

describe('时钟抽象', () => {
  test('FakeClock 可推进并用于构造临界时刻', () => {
    const clock = new FakeClock('2026-09-22T12:00:00+08:00');
    const t0 = clock.nowMs();
    clock.advance(3_600_000);
    assert.equal(clock.nowMs() - t0, 3_600_000);
    clock.advanceDays(2);
    assert.equal(clock.nowMs() - t0, 3_600_000 + 2 * 86_400_000);
    clock.set('2026-01-01T00:00:00Z');
    assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z');
  });
});
