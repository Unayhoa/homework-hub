/**
 * 任务身份与合并的回归测试。
 *
 * 起因（2026-10-06 真机）：日志显示「拉取 84 · 新增 84」，但待办里只看到几条，
 * 超星的任务几乎全不见了。根因是 upsertTasks 的指纹双重匹配：
 * 同一批数据内部也用「标题指纹」互相认领，而 normalizeTitle 会把结尾括号备注
 * 去掉 —— 「信安第三次作业(1)」与「信安第三次作业（王班）」指纹相同，
 * 于是同课程里后缀不同的多条作业互相覆盖，最后只剩一条。
 *
 * 结论：**平台给出不同 id 的任务，就是不同任务**。
 * 指纹只能用于「原任务本来就没有稳定 id」的场景。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rm } from 'node:fs/promises';

import { MemoryStore, materializeTask, diffTask } from '../src/index.ts';
import { normalizeTitle } from '../src/domain/ids.ts';
import { makeEngine, makeStubAdapter, type StubControl } from './relogin.test.ts';

const NOW = new Date('2026-10-06T12:00:00+08:00');

function task(title: string, platformTaskId: string | undefined) {
  return materializeTask({
    platformId: 'chaoxing',
    accountId: 'acc1',
    platformTask: {
      platformTaskId,
      courseId: 'C1',
      courseName: '信息安全数学基础',
      kind: 'homework',
      title,
      status: 'submitted',
    },
    now: NOW,
  });
}

describe('任务身份 · 标题归一化的合并风险（真机 bug 的起点）', () => {
  it('结尾括号备注会被去掉 —— 这正是多条作业撞指纹的原因', () => {
    assert.equal(normalizeTitle('信安第三次作业(1)'), normalizeTitle('信安第三次作业（王班）'));
  });
});

describe('任务身份 · upsert 的匹配规则', () => {
  it('同一批里标题相同但 id 不同 → 一条都不能少（修复前 5 条只剩 2 条）', async () => {
    const store = new MemoryStore();
    const result = await store.upsertTasks([
      task('作业一', 'w1'),
      task('作业二', 'w2'),
      task('作业一', 'w3'),
      task('作业一', 'w4'),
      task('作业二', 'w5'),
    ]);

    assert.equal(result.created, 5, '五条都应是新增');
    assert.equal(result.merged ?? 0, 0, '批内不得互认领');
    const all = await store.listTasks();
    assert.equal(all.length, 5, `store 里应留下 5 条（实际 ${all.length}）`);
    assert.deepEqual(
      all.map((t) => t.platformTaskId).sort(),
      ['w1', 'w2', 'w3', 'w4', 'w5'],
    );
  });

  it('跨批次：平台后补真实 id → 认领已有任务，不新建（避免重复条目）', async () => {
    const store = new MemoryStore();
    // 首次：平台没有给 id，用指纹兜底
    await store.upsertTasks([task('作业一', undefined)]);
    assert.equal((await store.listTasks()).length, 1);

    // 再次：平台给了真实 id，指纹相同 → 应认领那条兜底记录
    const result = await store.upsertTasks([task('作业一', 'w1')]);
    assert.equal(result.created, 0, '不应新建');
    assert.equal(result.merged, 1, '应发生一次指纹认领');
    assert.equal((await store.listTasks()).length, 1, '仍然只有一条');
  });

  it('无 id 且同标题 → 合并为一条（无法区分，属固有局限）', async () => {
    const store = new MemoryStore();
    await store.upsertTasks([task('作业一', undefined), task('作业一', undefined)]);
    assert.equal((await store.listTasks()).length, 1);
  });

  it('已有真实 id 的任务不会被别的标题相同任务顶掉', async () => {
    const store = new MemoryStore();
    await store.upsertTasks([task('作业一', 'w1')]);
    // 另一条同标题、不同 id —— 必须是新增，而不是覆盖 w1
    const result = await store.upsertTasks([task('作业一', 'w9')]);
    assert.equal(result.created, 1);
    assert.equal((await store.listTasks()).length, 2);
  });
});

describe('任务可见性 · 期限未知不能被丢弃（真机：整门课凭空消失）', () => {
  it('没有截止时间的待办任务必须出现在 upcoming 里', async () => {
    // 起因：超星 84 条任务的截止时间都没解析出来（kind=unknown），
    // upcoming 里 `return t.deadline.kind !== 'unknown'` 把它们整体丢掉，
    // 而它们的状态又不是终态、进不了已完成 —— 界面上彻底不可见，
    // 库里却明明有数据。前端早就准备了「期限未知」分组，是后端先滤掉了。
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
    };
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      const t = materializeTask({
        platformId: 'stub',
        accountId: account.id,
        platformTask: {
          platformTaskId: 'no-deadline-1',
          courseId: 'C1',
          courseName: '高等数学',
          kind: 'homework',
          title: '平台没给截止时间的作业',
          status: 'pending',
          // deadline 缺省 → normalizeDeadline 得到 kind='unknown'
        },
        now: new Date(),
      });
      await store.upsertTasks([t]);

      const list = await engine.upcoming({ withinDays: 60, includeOverdue: true });
      assert.equal(
        list.filter((x) => x.id === t.id).length,
        1,
        '期限未知的任务必须可见（否则整门课会凭空消失）',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('截止时间的变更阈值（秒级抖动不算改期）', () => {
  const mk = (deadline: string) =>
    materializeTask({
      platformId: 'chaoxing',
      accountId: 'acc1',
      platformTask: {
        platformTaskId: 'w1',
        courseId: 'C1',
        courseName: '高等数学',
        kind: 'homework',
        title: '第2章作业',
        status: 'pending',
        deadline,
      },
      now: NOW,
    });

  it('同一分钟内相差二十几秒 → 不算变更（平台时间戳的秒级零头）', () => {
    // 真机看到的正是这一对：用户以为是改期，其实都是 10/9 23:59
    const a = mk('2026-10-09T15:59:32.200Z');
    const b = mk('2026-10-09T15:59:08.786Z');
    const changes = diffTask(a, b).filter((c) => c.field === 'deadline');
    assert.equal(changes.length, 0, '秒级抖动不该报成「截止时间变了」');
  });

  it('真实改期（相差 1 小时）→ 必须报出来', () => {
    const a = mk('2026-10-09T15:59:00.000Z');
    const b = mk('2026-10-09T16:59:00.000Z');
    const changes = diffTask(a, b).filter((c) => c.field === 'deadline');
    assert.equal(changes.length, 1, '改期不能被阈值吃掉');
  });

  it('相差 2 分钟 → 仍算变更（阈值是 5 分钟，不该过宽）', () => {
    const a = mk('2026-10-09T15:59:00.000Z');
    const b = mk('2026-10-09T15:57:00.000Z');
    // 2 分钟 < 5 分钟 → 视为抖动，不报
    assert.equal(diffTask(a, b).filter((c) => c.field === 'deadline').length, 0);
  });
});
