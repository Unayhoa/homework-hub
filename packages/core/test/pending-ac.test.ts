/**
 * 「题全交了、但还没全 AC」这一档的三条不变量。
 *
 * 它是本项目里第一个**三态**的任务（未交完 / 已交未全 AC / 全 AC），
 * 所以最容易悄悄退化成两态。三条断言各守一处：
 *   1. 留在待办页（否则想刷 AC 的人再也找不到它）
 *   2. 不进已完成栏（否则同一条作业在两个地方出现，用户会以为有两条）
 *   3. 不排截止提醒（已经交了还催，等于让提醒贬值 + 白占系统闹钟配额）
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
  buildNotificationSchedule,
  createSilentLogger,
  hasPendingAc,
  materializeTask,
  systemClock,
} from '../src/index.ts';
import type { HttpClient, TaskProgress } from '../src/index.ts';

const noHttp: HttpClient = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error('本测试不发请求');
  },
};

/** 2026-10-20，早于下面所有任务的截止时间。 */
const NOW = new Date('2026-10-20T00:00:00Z');
const DEADLINE = '2026-10-25T15:59:00Z';

function task(progress: TaskProgress | undefined, deadline = DEADLINE) {
  return materializeTask({
    platformId: 'pintia',
    accountId: 'pintia::u',
    now: NOW,
    platformTask: {
      platformTaskId: `ps-${progress?.accepted ?? 'x'}-${progress?.submitted ?? 'x'}`,
      courseId: 'c1',
      courseName: '数据结构',
      kind: 'homework',
      title: '上机实验',
      status: progress && progress.submitted >= progress.total ? 'submitted' : 'pending',
      deadline,
      ...(progress ? { progress } : {}),
      ...(progress
        ? {
            subtasks: Array.from({ length: progress.total }, (_, i) => ({
              label: String.fromCharCode(65 + i),
              score: 20,
              status: i < progress.accepted ? 'PROBLEM_ACCEPTED' : i < progress.submitted ? 'PROBLEM_WRONG_ANSWER' : 'PROBLEM_NO_ANSWER',
            })),
          }
        : {}),
    },
  });
}

async function makeEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'hub-pac-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const engine = new SyncEngine({
    registry: new AdapterRegistry(),
    store,
    vault,
    http: noHttp,
    clock: { now: () => NOW, nowMs: () => NOW.getTime() },
    logger: createSilentLogger(),
  });
  return { dir, store, engine };
}

describe('「已交完但没全 AC」：待办里有、已完成里没有、不排提醒', () => {
  it('4 题全交、只 AC 1 题 → 判定为待 AC', () => {
    const t = task({ submitted: 4, accepted: 1, total: 4 });
    assert.equal(hasPendingAc(t, NOW), true);
  });

  it('它是待办的一条，但不在已完成里', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertTasks([task({ submitted: 4, accepted: 1, total: 4 })]);
      const todo = await engine.upcoming({ withinDays: 60 });
      assert.equal(todo.length, 1, '必须留在待办页 —— 用户还要回来刷 AC');
      const done = await engine.completed();
      assert.equal(done.length, 0, '不进已完成 —— 否则同一条作业会出现两次');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('不排任何截止提醒（每日汇总照常，但它不会提这条已交的）', async () => {
    const t = task({ submitted: 4, accepted: 1, total: 4 });
    const planned = buildNotificationSchedule([t], NOW);
    // 只断言「截止提醒」：每日汇总是一天一条的保底，与具体某条作业无关，
    // 它仍然会发（内容是"今天没有要交的"），这是设计不是漏排。
    const perTask = planned.filter((x) => x.kind !== 'daily');
    assert.equal(perTask.length, 0, '已经交了的作业不该再占闹钟配额');

    // 汇总正文里也不该出现这条已交的作业
    const digest = planned.filter((x) => x.kind === 'daily');
    assert.ok(digest.length > 0, '每日汇总仍然要有');
    assert.ok(
      digest.every((d) => !d.body.includes('上机实验')),
      '汇总只回答"今天要交什么"，已交的不该出现在里面',
    );

    // 对照组：同一份作业只交了一半 → 必须照常提醒
    const partial = task({ submitted: 2, accepted: 1, total: 4 });
    const planned2 = buildNotificationSchedule([partial], NOW).filter((x) => x.kind !== 'daily');
    assert.ok(planned2.length > 0, '没交完就得继续提醒 —— 这才是提醒存在的意义');
  });

  it('全部 AC 之后：离开待办、进已完成、不再是待 AC', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      const t = task({ submitted: 4, accepted: 4, total: 4 });
      await store.upsertTasks([t]);
      assert.equal(hasPendingAc(t, NOW), false);
      assert.equal((await engine.upcoming({ withinDays: 60 })).length, 0);
      assert.equal((await engine.completed()).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('过期之后不再算待 AC（平台已经不收提交，留着只会让人白跑）', () => {
    const t = task({ submitted: 4, accepted: 1, total: 4 }, '2026-10-19T00:00:00Z');
    assert.equal(hasPendingAc(t, NOW), false);
  });

  it('没有 progress 的平台完全不受影响（超星/iSmart/雨课堂）', () => {
    const t = task(undefined);
    assert.equal(hasPendingAc(t, NOW), false, '没有进度概念就不该有这一档');
  });
});
