/**
 * 同步提速相关的回归测试（2026-10-06）。
 *
 * 两个机制：
 *   1. 静默课程 —— 全部终态 + 14 天无变化 → 适配器跳过考试等「探测型」请求。
 *      真机背景：超星每门课固定发一次考试请求，32 门课 / 80 请求 / 4rps ≈ 20 秒，
 *      其中约 40% 是这些早已结课课程的考试探测。
 *   2. 手动静默课程 —— 用户显式把某门课标为「不再同步」，完全不发请求，
 *      但**已有记录必须完整保留**（这是它与「删整课」的关键区别）。
 *
 * 这两个机制都会「主动不去看某些数据」，所以最大的风险是**把没看的东西
 * 误判成消失并删掉**。下面的测试主要就在守这条线。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry,
  SyncEngine,
  MemoryStore,
  EncryptedVault,
  StaticKeyProvider,
  createSilentLogger,
  materializeTask,
  makeCourseId,
} from '../src/index.ts';
import type { Clock, HttpClient, PlatformAdapter, UnifiedTask } from '../src/index.ts';
import { makeStubAdapter, type StubControl } from './relogin.test.ts';

const DAY = 24 * 60 * 60 * 1000;

/** 可控时钟：静默判定依赖「距最近变化多少天」，必须能拨动时间。 */
class FixedClock implements Clock {
  #t: Date;
  constructor(t: Date) {
    this.#t = t;
  }
  now(): Date {
    return this.#t;
  }
  nowMs(): number {
    return this.#t.getTime();
  }
  set(t: Date): void {
    this.#t = t;
  }
}

const noHttp = {
  async request(): Promise<never> {
    throw new Error('测试不应发出真实请求');
  },
} as unknown as HttpClient;

async function makeEngineWithClock(adapter: PlatformAdapter, clock: FixedClock) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-tuning-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const registry = new AdapterRegistry().register(adapter);
  const engine = new SyncEngine({
    registry,
    store,
    vault,
    http: noHttp,
    clock,
    logger: createSilentLogger(),
  });
  return { dir, store, vault, engine };
}

const baseControl = (): StubControl => ({
  probeCalls: 0,
  loginCalls: 0,
  fetchCalls: 0,
  probeAlwaysFails: false,
  coursesFail: false,
});

describe('手动静默课程：不发请求，但记录必须完整保留', () => {
  it('设为「不再同步」后同步不再请求该课程，任务不被删除也不被标记', async () => {
    const control = baseControl();
    const { dir, store, engine } = await makeEngineWithClock(makeStubAdapter(control), new FixedClock(new Date()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});
      const before = await store.listTasks({ accountIds: [account.id] });
      assert.ok(before.length > 0, '先要有数据才谈得上保留');

      await engine.setCourseMuted(account.id, before[0]!.courseId, true);

      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 0, '静默课程不应再发任何请求');

      const after = await store.listTasks({ accountIds: [account.id], includeDeleted: true });
      assert.equal(after.length, before.length, '记录数量必须不变');
      assert.ok(
        after.every((t) => !t.deletedAt && !t.userDeletedAt),
        '静默不是删除 —— 记录不能被标记删除',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('恢复同步后课程重新参与', async () => {
    const control = baseControl();
    const { dir, store, engine } = await makeEngineWithClock(makeStubAdapter(control), new FixedClock(new Date()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});
      const tasks = await store.listTasks({ accountIds: [account.id] });
      const courseId = tasks[0]!.courseId;

      await engine.setCourseMuted(account.id, courseId, true);
      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 0);

      await engine.setCourseMuted(account.id, courseId, false);
      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 1, '恢复后应重新请求');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('静默课程判定：全部终态且长期无变化', () => {
  it('课程 14 天无变化且全终态 → 判定为静默并告知适配器；考试任务不被误删', async () => {
    const control = baseControl();
    control.taskStatus = 'submitted'; // 该课程的任务全是终态
    const t0 = new Date('2026-09-01T10:00:00+08:00');
    const clock = new FixedClock(t0);
    const { dir, store, engine } = await makeEngineWithClock(makeStubAdapter(control), clock);
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});

      // 手工放一条「考试」任务进这门课 —— 适配器在静默时不会再去请求考试，
      // 它必须靠引擎的保护存活下来（否则连续缺席会被软删除）
      const courseId = makeCourseId('stub', account.id, 'C1');
      const exam = materializeTask({
        platformId: 'stub',
        accountId: account.id,
        platformTask: {
          platformTaskId: 'exam-1',
          courseId: 'C1',
          courseName: '课程一',
          kind: 'exam',
          title: '第一次考试',
          status: 'expired',
        },
        now: t0,
      });
      await store.upsertTasks([exam]);

      // 拨到 15 天后：14 天静默线已过，同时 6h 的跳过 TTL 也早已过期
      clock.set(new Date(t0.getTime() + 15 * DAY));
      await engine.syncAll({});

      assert.deepEqual(
        control.lastQuietCourseIds,
        ['C1'],
        '全终态且 15 天无变化的课程应被判定为静默并告知适配器',
      );

      // 再跑两轮（缺席阈值是 2），考试任务必须始终健在
      await engine.syncAll({});
      await engine.syncAll({});

      const all = await store.listTasks({ accountIds: [account.id], includeDeleted: true });
      const keptExam = all.find((t: UnifiedTask) => t.title === '第一次考试');
      assert.ok(keptExam, '静默课程里的考试记录必须保留');
      assert.equal(keptExam.deletedAt ?? null, null, '且不能被标记删除');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('课程里还有未完成任务 → 永不判静默（不能漏掉新测验）', async () => {
    const control = baseControl();
    control.taskStatus = 'pending'; // 有未完成任务
    const t0 = new Date('2026-09-01T10:00:00+08:00');
    const clock = new FixedClock(t0);
    const { dir, engine } = await makeEngineWithClock(makeStubAdapter(control), clock);
    try {
      await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});
      clock.set(new Date(t0.getTime() + 15 * DAY));
      await engine.syncAll({});

      assert.deepEqual(control.lastQuietCourseIds, [], '有未完成任务的课程必须保持活跃');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
