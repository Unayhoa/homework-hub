/**
 * 任务点提醒：按「还差多少活」决定提前多久。
 *
 * 这条判据来自一个具体反例（用户 2026-11-04）：
 * 一门视频总时长 30 小时的课，提前 24 小时提醒等于通知「你已经来不及了」。
 * 作业可以套 T-24h，任务点不行。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TASK_POINT_REMINDER as CFG,
  humanDuration,
  leadMs,
  planTaskPointNotifications,
  taskPointAlertCount,
  urgencyOf,
  workloadMs,
  type TaskPointCourse,
} from '../src/engine/task-point-reminder.ts';

const NOW = new Date('2026-11-04T10:00:00+08:00');

function course(over: Partial<TaskPointCourse> = {}): TaskPointCourse {
  return { id: 'c1', name: '形势与政策', total: 10, done: 7, hasOpenNow: true, ...over };
}

const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

describe('任务点提醒：工作量估算', () => {
  it('净工作量 = 剩余点数 × 15 分钟（不含冗余）', () => {
    assert.equal(workloadMs({ total: 10, done: 7 }, CFG), 3 * 15 * 60_000);
    assert.equal(humanDuration(workloadMs({ total: 10, done: 7 }, CFG)), '45 分钟');
  });

  it('提前量 = 净工作量按「每天可投入」折成日历天 + 冗余，**不设上限**', () => {
    // 只剩 1 个（15 分钟）：0.25h / 6h = 0.04 天 ≈ 1 小时，加 12h 冗余
    const one = leadMs({ total: 10, done: 9 }, CFG);
    assert.equal(one, (0.25 / CFG.dailyHours) * 86_400_000 + CFG.bufferMs);

    // 300 个（75 小时）：75/6 = 12.5 天，不许被任何上限截断
    const huge = leadMs({ total: 300, done: 0 }, CFG);
    assert.equal(huge, (75 / CFG.dailyHours) * 86_400_000 + CFG.bufferMs);
    assert.ok(huge > 10 * 86_400_000, '大工作量必须能提前十天以上');
  });

  it('D 越小提前越多（同一个工作量，每天能投入的少就得更早开始）', () => {
    const slow = { ...CFG, dailyHours: 3 };
    const fast = { ...CFG, dailyHours: 12 };
    const c = { total: 100, done: 0 }; // 净 25 小时
    assert.ok(leadMs(c, slow) > leadMs(c, CFG), '每天 3 小时要比 6 小时更早提醒');
    assert.ok(leadMs(c, CFG) > leadMs(c, fast), '每天 6 小时要比 12 小时更早提醒');
    // 3 小时/天 → 25/3 ≈ 8.3 天；12 小时/天 → 25/12 ≈ 2.1 天（都要扣掉那 12 小时冗余）
    const toDays = (ms: number) => (ms - CFG.bufferMs) / 86_400_000;
    assert.ok(Math.abs(toDays(leadMs(c, slow)) - 8.33) < 0.1);
    assert.ok(Math.abs(toDays(leadMs(c, fast)) - 2.08) < 0.1);
  });

  it('工作量越大，提醒越早 —— 这就是"考虑完成可能性"', () => {
    const few = leadMs({ total: 5, done: 0 }, CFG);
    const many = leadMs({ total: 60, done: 0 }, CFG);
    assert.ok(many > few, `60 个点应比 5 个点更早提醒（${many} vs ${few}）`);
  });
});

describe('任务点提醒：状态判定', () => {
  it('做完了 → done（不提醒）', () => {
    assert.equal(urgencyOf(course({ total: 10, done: 10, closesAt: hoursFromNow(48) }), NOW), 'done');
  });

  it('窗口已关 → closed', () => {
    assert.equal(urgencyOf(course({ closesAt: hoursFromNow(-1) }), NOW), 'closed');
  });

  it('20 小时后关、还差 100 个 → impossible（净需 25 小时，来不及）', () => {
    const c = course({ total: 100, done: 0, closesAt: hoursFromNow(20) });
    assert.equal(urgencyOf(c, NOW), 'impossible');
  });

  it('36 小时后关、还差 100 个 → 还来得及，但已进提醒窗口', () => {
    // 净需 25h < 36h，所以不是 impossible；但提前量 25+12=37h > 36h → 该催了
    const c = course({ total: 100, done: 0, closesAt: hoursFromNow(36) });
    assert.equal(urgencyOf(c, NOW), 'due-soon');
  });

  it('时间还宽裕（200 小时后关、还差 100 个）→ ok，不打扰', () => {
    // 提前量 = 25/6 天 ≈ 100h + 12h = 112h；还剩 200h > 112h → 还没到该催的时候
    const c = course({ total: 100, done: 0, closesAt: hoursFromNow(200) });
    assert.equal(urgencyOf(c, NOW), 'ok');
  });

  it('进入提醒窗口（还剩 5h、下限 6h）→ due-soon', () => {
    const c = course({ total: 10, done: 7, closesAt: hoursFromNow(5) });
    assert.equal(urgencyOf(c, NOW), 'due-soon');
  });

  it('不能做的课（章节没开）不参与判定', () => {
    const c = course({ hasOpenNow: false, closesAt: hoursFromNow(5) });
    assert.equal(taskPointAlertCount([c], NOW), 0, '做不了的事提醒了只会让人焦虑');
  });
});

describe('任务点提醒：排期与角标分工', () => {
  it('提醒点在未来 → 排一条系统通知，文案带工作量', () => {
    // 还剩 3 个 → 净 45min + 12h 冗余 = 提前 12.75h；20 小时后关 → 提醒点在 7.25 小时后
    const c = course({ total: 10, done: 7, closesAt: hoursFromNow(20) });
    const list = planTaskPointNotifications([c], NOW);

    assert.equal(list.length, 1);
    const n = list[0]!;
    assert.equal(n.kind, 'points');
    assert.match(n.title, /形势与政策/);
    assert.match(n.body, /还差 3 个/);
    assert.match(n.body, /约需 45 分钟/);
    const fire = new Date(n.fireAt).getTime();
    assert.ok(fire > NOW.getTime(), '必须是未来的时刻');
    assert.ok(fire < new Date(hoursFromNow(20)).getTime(), '在关闭之前');
  });

  it('已经来不及 → 不补发弹窗，但角标一直亮', () => {
    // 100 个点（净 25h）但只剩 20 小时 → 提醒点远在过去
    const c = course({ total: 100, done: 0, closesAt: hoursFromNow(20) });
    assert.deepEqual(planTaskPointNotifications([c], NOW), [], '不排通知（否则每次开 App 都弹）');
    assert.equal(taskPointAlertCount([c], NOW), 1, '角标要亮 —— 这正是弹窗不管的那部分');
  });

  it('没有关闭时刻（无期限）→ 不排也不报', () => {
    const c = course({ closesAt: undefined });
    assert.deepEqual(planTaskPointNotifications([c], NOW), []);
    assert.equal(taskPointAlertCount([c], NOW), 0);
  });

  it('已完成的课不进角标', () => {
    const c = course({ total: 10, done: 10, closesAt: hoursFromNow(3) });
    assert.equal(taskPointAlertCount([c], NOW), 0);
  });

  it('多门课：通知按触发时刻升序，角标只数"该催"的', () => {
    const a = course({ id: 'a', name: 'A', total: 10, done: 7, closesAt: hoursFromNow(20) });
    const b = course({ id: 'b', name: 'B', total: 200, done: 0, closesAt: hoursFromNow(10) }); // 净需 50h 来不及
    const c = course({ id: 'c', name: 'C', total: 10, done: 9, closesAt: hoursFromNow(200) });
    const list = planTaskPointNotifications([a, b, c], NOW);

    const fires = list.map((x) => new Date(x.fireAt).getTime());
    assert.deepEqual(fires, [...fires].sort((x, y) => x - y), '按触发时刻排序');
    assert.equal(taskPointAlertCount([a, b, c], NOW), 1, 'b 来不及 → 算一个；a 还没进窗口');
  });
});
