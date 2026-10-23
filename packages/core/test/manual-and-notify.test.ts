import {
  DEFAULT_NOTIFY_PREFS,
  maxTimesFor,
  normalizeNotifyPrefs,
  NOTIFY_PRESETS,
  specToOffsets,
} from '../src/index.ts';
 import type { NotifyLevel, NotifyPrefs, ScheduledNotification, UnifiedTask } from '../src/index.ts';
/**
 * 手动添加待办 + 截止提醒排期。
 *
 * 这个文件守的是两条**容易被"顺手"破坏**的安全线：
 *   1. 手动任务不能被同步的「缺席判定」误删 —— 上游永远看不到它，
 *      挂在真实账号下会在若干轮同步后被判成"消失了"。
 *   2. 提醒的排期必须是**幂等**的纯函数 —— 它每轮同步都被重算并整体替换，
 *      结果若依赖"上次排了什么"，就会出现重复或漏掉的闹钟。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { materializeTask, buildNotificationSchedule, MANUAL_ACCOUNT_ID } from '../src/index.ts';
import { makeEngine, makeStubAdapter, type StubControl } from './relogin.test.ts';

/** 本地时间构造（静默时段的判定基于本地小时，所以夹具必须用本地时刻） */
function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function task(input: {
  title: string;
  due: Date;
  kind?: 'homework' | 'exam' | 'quiz';
  status?: 'pending' | 'submitted';
  id?: string;
}) {
  return materializeTask({
    platformId: 'chaoxing',
    accountId: 'chaoxing::u1',
    platformTask: {
      platformTaskId: input.id ?? input.title,
      courseId: 'C1',
      courseName: '信息安全数学基础',
      kind: input.kind ?? 'homework',
      title: input.title,
      status: input.status ?? 'pending',
      deadline: input.due.toISOString(),
    },
    now: at(2026, 10, 1),
  });
}

describe('截止提醒排期（通知栏）', () => {
  /**
   * 这一组测的是「截止提醒」，所以**统一把每日汇总关掉** ——
   * 它是一条并列的链路，有自己的测试组（见文件末尾）。
   * 不关掉的话，本组每条断言里的 out.length 都会多出 7 个每日通知，
   * 而那种失败看起来像"提醒算错了"，实际只是口径没对齐。
   */
  const scheduleTasks = (
    tasks: Parameters<typeof buildNotificationSchedule>[0],
    now: Date,
    opts: Parameters<typeof buildNotificationSchedule>[2] = {},
  ) =>
    buildNotificationSchedule(tasks, now, {
      ...opts,
      prefs: { daily: false, ...opts.prefs },
    });

  it('作业：截止前 24 小时与 12 小时各一条', () => {
    const now = at(2026, 10, 8, 10, 0);
    const t = task({ title: '第三章作业', due: at(2026, 10, 10, 20, 0) });
    const out = scheduleTasks([t], now);

    assert.equal(out.length, 2);
    assert.equal(new Date(out[0]!.fireAt).getTime(), at(2026, 10, 9, 20, 0).getTime());
    assert.equal(new Date(out[1]!.fireAt).getTime(), at(2026, 10, 10, 8, 0).getTime());
    assert.match(out[0]!.title, /第三章作业/);
    assert.match(out[0]!.body, /信息安全数学基础/);
  });

  it('考试：提前 3 天与 1 天（不可补交，值得更早；没有 12 小时那一档）', () => {
    const now = at(2026, 10, 8, 10, 0);
    const t = task({ title: '期中考试', due: at(2026, 10, 15, 14, 0), kind: 'exam' });
    const out = scheduleTasks([t], now);

    assert.equal(out.length, 2);
    assert.equal(new Date(out[0]!.fireAt).getTime(), at(2026, 10, 12, 14, 0).getTime());
    assert.equal(new Date(out[1]!.fireAt).getTime(), at(2026, 10, 14, 14, 0).getTime());
  });

  it('深夜弹窗等于没弹：落在 22:00–08:00 的提醒顺延到当天 8 点', () => {
    // 截止 23:59 是平台的常见形态 —— 它的「前 24 小时」正好是前一天 23:59
    const now = at(2026, 10, 8, 10, 0);
    const t = task({ title: '深夜截止的作业', due: at(2026, 10, 10, 23, 59) });
    const out = scheduleTasks([t], now);

    const first = out.find((x) => x.key.endsWith('T-24h'))!;
    assert.equal(
      new Date(first.fireAt).getTime(),
      at(2026, 10, 10, 8, 0).getTime(),
      '23:59 的提醒应被顺延到 8:00，而不是半夜弹',
    );
  });

  it('顺延后已经来不及了 → 直接丢弃（迟到的提醒只制造焦虑）', () => {
    // 用一段极端的静默时段把两条都推到截止之后
    const now = at(2026, 10, 8, 10, 0);
    const t = task({ title: '早上八点截止', due: at(2026, 10, 10, 22, 0) });
    const out = scheduleTasks([t], now, { quietFromHour: 0, quietToHour: 23 });
    assert.equal(out.length, 0, '顺延到 23:00 已过截止，两条都该丢掉');
  });

  it('已经过去的窗口不补发（否则每轮同步都会突袭一条）', () => {
    // 10 小时后截止：T-24h 与 T-12h 都已经过去了
    const now = at(2026, 10, 8, 10, 0);
    const t = task({ title: '今晚就交', due: at(2026, 10, 8, 20, 0) });
    const out = scheduleTasks([t], now);
    assert.equal(out.length, 0, '过去的窗口只能丢弃 —— 不能一同步就补发');
  });

  it('已逾期、已完成、已删除的任务都不排提醒', () => {
    const now = at(2026, 10, 8, 10, 0);
    const overdue = task({ title: '逾期的', due: at(2026, 10, 1, 20, 0) });
    const done = task({ title: '已提交的', due: at(2026, 10, 10, 20, 0), status: 'submitted' });
    const deleted = { ...task({ title: '已删除的', due: at(2026, 10, 10, 20, 0) }), userDeletedAt: at(2026, 10, 2).toISOString() };
    const out = scheduleTasks([overdue, done, deleted], now);
    assert.equal(out.length, 0);
  });

  it('幂等：同样的任务集与时刻 → 完全一样的清单（排期是整体替换的，必须稳定）', () => {
    const now = at(2026, 10, 8, 10, 0);
    const tasks = [
      task({ title: 'A', due: at(2026, 10, 10, 20, 0) }),
      task({ title: 'B', due: at(2026, 10, 12, 9, 0) }),
    ];
    const a = scheduleTasks(tasks, now);
    const b = scheduleTasks(tasks, now);
    assert.deepEqual(a, b);
    // 按触发时刻升序
    for (let i = 1; i < a.length; i += 1) {
      assert.ok(new Date(a[i]!.fireAt) >= new Date(a[i - 1]!.fireAt), '清单必须按时刻升序');
    }
  });

  it('改期后 key 随之改变（旧的提醒不会因为 key 相同而被误认为已送达）', () => {
    const now = at(2026, 10, 8, 10, 0);
    const before = scheduleTasks([task({ title: 'X', due: at(2026, 10, 10, 20, 0) })], now);
    const after = scheduleTasks([task({ title: 'X', due: at(2026, 10, 12, 20, 0) })], now);
    assert.notEqual(before[0]!.key, after[0]!.key);
  });
});

describe('手动添加待办', () => {
  const baseControl = (): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
  });

  it('创建后立刻出现在待办里，平台名原样保留用户填的文字', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const t = await engine.createManualTask({
        title: '老师口头布置的论文提纲',
        deadlineAt: at(2026, 10, 12, 23, 59).toISOString(),
        courseName: '学术英语',
        platformLabel: '老师口头布置',
      });
      assert.equal(t.platformId, 'manual');
      assert.equal(t.accountId, MANUAL_ACCOUNT_ID);
      assert.equal(t.platformLabel, '老师口头布置');
      assert.equal(t.status, 'pending');

      const list = await engine.upcoming({ withinDays: 60, includeOverdue: true });
      assert.equal(list.filter((x) => x.id === t.id).length, 1, '手动任务必须出现在待办里');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('缺名称 / 截止时间无法识别 → 明确报错，不留下半条脏数据', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      await assert.rejects(
        () => engine.createManualTask({ title: '   ', deadlineAt: at(2026, 10, 12).toISOString() }),
        /不能为空/,
      );
      await assert.rejects(
        () => engine.createManualTask({ title: '题目', deadlineAt: '不是时间' }),
        /无法识别/,
      );
      assert.equal((await store.listTasks()).length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('课程名留空 → 归到「未分类」，而不是空字符串', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const t = await engine.createManualTask({
        title: '无课程的作业',
        deadlineAt: at(2026, 10, 12).toISOString(),
      });
      assert.equal(t.courseName, '未分类');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('【安全线】连续多轮同步后手动任务依然在（不会被缺席判定误删）', async () => {
    const control = baseControl();
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const manual = await engine.createManualTask({
        title: '平台抓不到的作业',
        deadlineAt: at(2026, 10, 20, 23, 59).toISOString(),
        courseName: '其他',
        platformLabel: '手动',
      });
      void account;

      // 缺席阈值是 2 —— 跑三轮足够让它被判"消失"（如果实现有误的话）
      await engine.syncAll({});
      await engine.syncAll({});
      await engine.syncAll({});

      const all = await store.listTasks({ includeDeleted: true });
      const kept = all.find((x) => x.id === manual.id);
      assert.ok(kept, '手动任务不能从库里消失');
      assert.equal(kept.deletedAt ?? null, null, '手动任务绝不能被同步软删除');
      assert.equal(kept.absentCount, 0, '它根本不该进入缺席计数');
      assert.equal((await engine.upcoming({ withinDays: 60 })).filter((x) => x.id === manual.id).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('删除手动任务后，它的提醒也不再排期（不能为删掉的作业发通知）', async () => {
    const { dir, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      // 截止时间必须相对「现在」算：这里走的是真实系统时钟（createManualTask），
      // 写死一个固定日期会变成时间炸弹 —— 日期一过测试就红，
      // 而它红的原因与"删除后还会不会提醒"毫无关系。
      const due = new Date(Date.now() + 3 * 86_400_000);
      due.setHours(20, 0, 0, 0);
      const t = await engine.createManualTask({
        title: '待删任务',
        deadlineAt: due.toISOString(),
      });
      const before = await engine.upcomingNotifications();
      assert.ok(before.some((x) => x.taskId === t.id), '创建后应有排期');

      await engine.deleteTask(t.accountId, t.id);
      const after = await engine.upcomingNotifications();
      assert.equal(after.filter((x) => x.taskId === t.id).length, 0, '删掉的任务不该再弹提醒');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


// ================================================================ 每日汇总
//
// 它与「截止提醒」是**并列的两条链路**，不是同一条：
//   截止提醒：某条任务临期时定点响（精确，但只有临期那几天才有）
//   每日汇总：每天固定一条，回答"我手上还有多少作业、数据是哪天的"
// 存在的理由是 Android 的 App Standby 分桶 —— 用户越不打开 App，
// 闹钟配额越低（活跃无限制 / 工作集 10 次每小时 / 常用 2 次 /
// 极少使用 1 次 / 受限**每天 1 次**）。每日汇总一天只占 1 个配额，
// 是唯一在「受限」桶下也到得了的形态。
describe('每日汇总', () => {
  const now = at(2026, 10, 8, 10, 0);
  const dailyOf = (
    tasks: UnifiedTask[],
    prefs: NotifyPrefs = {},
  ): ScheduledNotification[] =>
    buildNotificationSchedule(tasks, now, { prefs: { daily: true, ...prefs } }).filter(
      (x) => x.kind === 'daily',
    );

  it('默认排未来 7 天、每天一条，都落在配置的时刻（默认跟随静默结束 8:00）', () => {
    const t = task({ title: '第三章作业', due: at(2026, 10, 20, 23, 59) });
    const daily = dailyOf([t]);
    assert.equal(daily.length, 7);
    for (const d of daily) assert.equal(new Date(d.fireAt).getHours(), 8);
    assert.ok(daily.every((d) => d.key.startsWith('daily|')), 'key 必须带 daily 前缀，便于识别');
  });

  it('今天有到期的 → 标题说「今天要交 N 项」，正文给任务名与时刻', () => {
    const t = task({ title: '第三章作业', due: at(2026, 10, 9, 23, 59) });
    const daily = dailyOf([t], { dailyDays: 1 });
    assert.match(daily[0]!.title, /今天要交 1 项/);
    assert.match(daily[0]!.body, /第三章作业/);
  });

  it('今天没有到期的 → 给「最近一条」，而不是说更多', () => {
    const t = task({ title: '期末论文', due: at(2026, 10, 14, 23, 59) });
    const daily = dailyOf([t], { dailyDays: 1 });
    assert.match(daily[0]!.title, /今天没有要交的/);
    assert.match(daily[0]!.body, /最近一条/);
    assert.match(daily[0]!.body, /期末论文/);
  });

  it('没有待办 → 说「都交完了」（而不是"无待办"这种否定式）', () => {
    const daily = dailyOf([], { dailyDays: 1 });
    assert.match(daily[0]!.title, /都交完了/);
  });

  it('**远的那几条绝不说「今天」** —— 漏报会让用户错过作业', () => {
    const t = task({ title: '第三章作业', due: at(2026, 10, 20, 23, 59) });
    const daily = dailyOf([t], { dailyDays: 5 });
    // 第 0 条（明天）用正常措辞；第 1 条起降级
    assert.match(daily[0]!.title, /今天/);
    for (const d of daily.slice(1)) {
      assert.doesNotMatch(d.title, /今天/, '数据可能已过期，不能下"今天"的断言');
      assert.match(d.body, /数据截至/);
      assert.match(d.body, /点开同步/, '必须告诉用户怎么让数据变新');
    }
  });

  it('可以整条关掉（关掉后连一条都不排）', () => {
    const t = task({ title: '第三章作业', due: at(2026, 10, 20, 23, 59) });
    assert.equal(dailyOf([t], { daily: false }).length, 0);
  });
});

// ================================================================ 提醒档位
describe('提醒密度档位', () => {
  const now = at(2026, 10, 8, 10, 0);
  const count = (level: NotifyLevel, kind: 'homework' | 'exam' = 'homework') =>
    buildNotificationSchedule([task({ title: '作业', due: at(2026, 10, 10, 20, 0), kind })], now, {
      prefs: { level, daily: false },
    }).length;

  it('三档的条数：宽松 2 / 标准 3 / 紧凑 3', () => {
    assert.equal(count('loose'), 2);
    assert.equal(count('standard'), 3);
    assert.equal(count('tight'), 3);
  });

  it('每类任务的上限就是 3 次（给一个做不到的密度等于给一个假承诺）', () => {
    assert.ok(count('tight') <= 3);
    assert.ok(count('tight', 'exam') <= 3);
  });

  it('不认识的档位回落默认（standard），不抛', () => {
    assert.equal(count('随便写的' as NotifyLevel), count('standard'));
  });
});

describe('提醒偏好的归一化（坏数据不许让整条提醒链路瘫掉）', () => {
  it('缺字段 / 非对象 → 全回落默认', () => {
    assert.deepEqual(normalizeNotifyPrefs(null), DEFAULT_NOTIFY_PREFS);
    assert.deepEqual(normalizeNotifyPrefs('乱码'), DEFAULT_NOTIFY_PREFS);
    assert.deepEqual(normalizeNotifyPrefs([]), DEFAULT_NOTIFY_PREFS);
  });

  it('越界的小时与天数被夹到合法区间', () => {
    assert.equal(normalizeNotifyPrefs({ dailyHour: 99 }).dailyHour, 23);
    assert.equal(normalizeNotifyPrefs({ dailyHour: -5 }).dailyHour, 0);
    assert.equal(normalizeNotifyPrefs({ dailyDays: 999 }).dailyDays, 14);
    assert.equal(normalizeNotifyPrefs({ dailyDays: 0 }).dailyDays, 1);
  });

  it('坏字段不影响好字段', () => {
    const p = normalizeNotifyPrefs({ level: 'tight', dailyHour: 'abc', dailyDays: 3 });
    assert.equal(p.level, 'tight');
    assert.equal(p.dailyHour, DEFAULT_NOTIFY_PREFS.dailyHour);
    assert.equal(p.dailyDays, 3);
  });
});


// ================================================================ 提醒区间与护栏
//
// 设计变化（用户 2026-10-18）：原来三档本质上都是"提前一天开始、只是次数不同"，
// 而用户真正想调的是**什么时候开始、什么时候结束** —— 次数只是这两端的函数。
// 所以配置从「固定的一组提前量」改成「区间 + 次数」，护栏负责把做不到的组合夹掉。
describe('提醒区间（首次 / 末次 / 次数）', () => {
  it('区间内均匀取点：24 小时 → 1 小时，3 次', () => {
    const out = specToOffsets({ firstHours: 24, lastHours: 1, times: 3 });
    assert.deepEqual(
      out.map((o) => o.value),
      [24, 13, 1],
    );
    assert.ok(
      out.every((o) => o.unit === 'hour'),
      '内部统一用小时，显示时才换算成天',
    );
  });

  it('只设 1 次时，就是「最后提醒」那个时刻', () => {
    const out = specToOffsets({ firstHours: 24, lastHours: 2, times: 1 });
    assert.deepEqual(
      out.map((o) => o.value),
      [2],
    );
  });

  it('**硬护栏**：区间装不下时自动减少次数（相邻至少间隔 1 小时）', () => {
    assert.equal(maxTimesFor({ firstHours: 1, lastHours: 0 }), 2, '1 小时区间最多 2 次');
    assert.equal(
      specToOffsets({ firstHours: 1, lastHours: 0, times: 3 }).length,
      2,
      '设了 3 次也只能排 2 条 —— 宁可少一次，也不要同一时刻响两遍',
    );
  });

  it('末次超过首次时自动收敛（区间不能是负的）', () => {
    const out = specToOffsets({ firstHours: 6, lastHours: 12, times: 2 });
    assert.ok(out.every((o) => o.value <= 6));
  });

  it('三档预设都合法，且实际条数不超过设定次数', () => {
    for (const [k, p] of Object.entries(NOTIFY_PRESETS)) {
      for (const spec of [p.task, p.exam]) {
        assert.ok(spec.times <= 3, k + ': 次数上限 3');
        const out = specToOffsets(spec);
        assert.ok(out.length >= 1 && out.length <= spec.times, k + ': 实际条数不该超过设定');
      }
    }
  });

  it('文案里把 72 小时说成「3 天」—— 用户不该看到"还有不到 72 小时"', () => {
    const t = task({ title: '期中考试', due: at(2026, 10, 15, 14, 0), kind: 'exam', id: 'e1' });
    const out = buildNotificationSchedule([t], at(2026, 10, 8, 10, 0), {
      prefs: { daily: false, exam: { firstHours: 72, lastHours: 24, times: 2 } },
    });
    assert.equal(out.length, 2);
    assert.match(out[0]!.body, /还有不到 3 天/);
  });

  it('不同任务的区间互不影响（作业与考试分开配）', () => {
    const hw = task({ title: '作业', due: at(2026, 10, 12, 20, 0), id: 'h1' });
    const ex = task({ title: '考试', due: at(2026, 10, 12, 20, 0), kind: 'exam', id: 'e1' });
    const out = buildNotificationSchedule([hw, ex], at(2026, 10, 8, 10, 0), {
      prefs: {
        daily: false,
        task: { firstHours: 24, lastHours: 1, times: 1 },
        exam: { firstHours: 72, lastHours: 1, times: 2 },
      },
    });
    const hwCount = out.filter((x) => x.taskId === hw.id).length;
    const exCount = out.filter((x) => x.taskId === ex.id).length;
    assert.equal(hwCount, 1);
    assert.equal(exCount, 2);
  });
});
