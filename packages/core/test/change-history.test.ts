/**
 * 变更历史（记录页 · 变更历史 段）的数据契约。
 *
 * 真机症状：同步条写「新增 N」，变更历史却写「最近 30 天没有变更记录」。
 * 根因是历史只记录**已知任务的字段 diff**，任务的「第一次出现」从来没进过历史；
 * 另外查询侧按建号顺序返回、且先截断后排序，新记录会沉到末尾。
 *
 * 这组测试守四件事：
 *   1. 新增会留下一条 created 记录
 *   2. 修改仍然照旧记录，且排在新增之前（新的在前）
 *   3. 查询按最近变更倒序、且**包含已删除任务**（记录不能随任务消失）
 *   4. 没变化时绝不凭空产生记录（老任务回填 = 噪音）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry,
  EncryptedVault,
  MemoryStore,
  StaticKeyProvider,
  SyncEngine,
  createSilentLogger,
  materializeTask,
  mergeTasks,
  systemClock,
  DEFAULT_MERGE_OPTIONS,
} from '../src/index.ts';
import type { HttpClient, PlatformTask, UnifiedTask } from '../src/index.ts';

const noHttp: HttpClient = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error('本测试不起 HTTP');
  },
};

function taskAt(over: Partial<PlatformTask>, now: Date): UnifiedTask {
  const base: PlatformTask = {
    platformTaskId: 'hw-1',
    courseId: 'c1',
    courseName: '高等数学',
    kind: 'homework',
    title: '第一次作业',
    status: 'pending',
    deadline: '2026-11-01 23:59',
  };
  return materializeTask({ platformId: 'stub', accountId: 'acc1', platformTask: { ...base, ...over }, now });
}

async function makeEngine(store: MemoryStore) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-chg-'));
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const engine = new SyncEngine({
    registry: new AdapterRegistry(),
    store,
    vault,
    http: noHttp,
    clock: systemClock,
    logger: createSilentLogger(),
  });
  return { dir, engine };
}

describe('变更历史：新增与修改都要留下记录', () => {
  it('任务第一次出现时写入一条 created 记录，且 revision 仍是 1', () => {
    const plan = mergeTasks([], [taskAt({}, new Date('2026-10-20T10:00:00.000Z'))]);
    assert.equal(plan.created, 1);
    const born = plan.writes[0]!;
    assert.equal(born.history.length, 1, '新增必须留下一条记录');
    assert.equal(born.history[0]!.field, 'created');
    assert.equal(born.history[0]!.to, '第一次作业');
    assert.equal(born.history[0]!.from, null);
    assert.equal(born.revision, 1, '新增不是"改过"，revision 不能变成 2');
  });

  it('新增之后再改截止时间：两条都在，且新的排在前面', () => {
    const first = mergeTasks([], [taskAt({}, new Date('2026-10-20T10:00:00.000Z'))]).writes[0]!;
    const plan = mergeTasks(
      [first],
      [taskAt({ deadline: '2026-11-05 23:59' }, new Date('2026-10-21T11:00:00.000Z'))],
    );
    assert.equal(plan.updated, 1);
    const merged = plan.writes[0]!;
    assert.deepEqual(
      merged.history.map((h) => h.field),
      ['deadline', 'created'],
      '历史是「新在前、旧在后」，界面直接按这个顺序渲染',
    );
    assert.equal(merged.revision, 2);
  });

  it('内容没变化的同步不产生任何记录（不给老任务回填「新增」）', () => {
    const first = mergeTasks([], [taskAt({}, new Date('2026-10-20T10:00:00.000Z'))]).writes[0]!;
    const plan = mergeTasks(
      [first],
      [taskAt({}, new Date('2026-10-22T10:00:00.000Z'))],
      DEFAULT_MERGE_OPTIONS,
    );
    assert.equal(plan.writes.length, 0, '幂等同步不写库');
    assert.equal(plan.updated, 0);
    assert.equal(first.history.length, 1, '原有记录不该被清掉');
  });
});

describe('变更历史：查询侧（recentChanges）', () => {
  /** 造一条「已落库、带 created 历史」的记录（直接 materialize 出来的任务 history 是空的）。 */
  const seeded = (over: Partial<PlatformTask>, now: Date): UnifiedTask =>
    mergeTasks([], [taskAt(over, now)]).writes[0]!;

  it('按最近一条变更倒序返回，新变更在第一屏', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      // A 早上新增，B 傍晚新增 → B 应该排在前面
      await store.upsertTasks([
        seeded({ platformTaskId: 'a', title: 'A 作业' }, new Date('2026-10-21T02:00:00.000Z')),
      ]);
      await store.upsertTasks([
        seeded({ platformTaskId: 'b', title: 'B 作业' }, new Date('2026-10-21T10:00:00.000Z')),
      ]);

      const list = await engine.recentChanges(new Date('2026-10-20T00:00:00.000Z'));
      assert.deepEqual(list.map((x) => x.task.title), ['B 作业', 'A 作业']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('任务被软删除后，它的变更记录仍然查得到', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      // 先新增（带 created 历史），再软删除 —— 模拟「平台撤了作业」
      const born = seeded({}, new Date('2026-10-21T02:00:00.000Z'));
      await store.upsertTasks([born]);
      await store.softDeleteTasks([born.id], '2026-10-21T03:00:00.000Z');

      const list = await engine.recentChanges(new Date('2026-10-20T00:00:00.000Z'));
      assert.equal(list.length, 1, '记录不能随任务一起消失，否则历史会"倒退"');
      assert.ok(list[0]!.task.deletedAt, '同时要把"已删除"这个事实带出去');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('时间窗口之外的历史不返回；非法 since 不静默清空', async () => {
    const store = new MemoryStore();
    await store.init();
    const { dir, engine } = await makeEngine(store);
    try {
      await store.upsertTasks([seeded({ platformTaskId: 'old' }, new Date('2026-09-01T02:00:00.000Z'))]);
      await store.upsertTasks([seeded({ platformTaskId: 'new' }, new Date('2026-10-21T02:00:00.000Z'))]);

      const old = await engine.recentChanges(new Date('2026-10-01T00:00:00.000Z'));
      assert.equal(old.length, 1, '窗口外（9/1）不返回，窗口内（10/21）返回');
      assert.equal(old[0]!.task.platformTaskId, 'new');

      const bad = await engine.recentChanges(new Date('这不是时间'));
      assert.equal(bad.length, 1, 'since 非法时应退化成最近 30 天，而不是返回空');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
