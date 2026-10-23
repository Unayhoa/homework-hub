/**
 * 用户删除功能 + ISO 时区修复 的回归测试。
 * 前两者来自真机反馈（2026-09-28）：iSmart 导入成功后需要一个「删掉结课课程」的出口。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeDeadline,
  AdapterRegistry,
  SyncEngine,
  MemoryStore,
  EncryptedVault,
  StaticKeyProvider,
  createSilentLogger,
  systemClock,
  materializeTask,
} from '../src/index.ts';
import { makeStubAdapter, makeEngine, type StubControl } from './relogin.test.ts';

describe('deadline · 显式时区的 ISO 串', () => {
  it('带 Z 的 ISO 保留 UTC 时刻，不被按本地时间重解释（真机 20:00 显示成 12:00 的根因）', () => {
    const d = normalizeDeadline(new Date(1791460800000).toISOString(), new Date());
    assert.equal(d.kind, 'absolute');
    assert.equal(new Date(d.at!).getTime(), 1791460800000);
  });

  it('带数字时区偏移的 ISO 同样保留', () => {
    const d = normalizeDeadline('2026-10-08T20:00:00+08:00', new Date());
    assert.equal(d.kind, 'absolute');
    assert.equal(new Date(d.at!).getTime(), Date.parse('2026-10-08T12:00:00Z'));
  });

  it('无时区的墙上时间仍按本地解释（平台给「2026-10-08 20:00」的语义就是本地）', () => {
    const d = normalizeDeadline('2026-10-08 20:00', new Date());
    assert.equal(d.kind, 'absolute');
    const at = new Date(d.at!);
    assert.equal(at.getHours(), 20);
  });
});

describe('用户删除 · 单条任务', () => {
  it('墓碑任务在同步后不复活，即便平台仍然推送同一条', async () => {
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
      // 先正常同步一轮，拿到库里的任务
      await engine.syncAll({});
      const tasks = await store.listTasks({ accountIds: [account.id] });
      assert.equal(tasks.length, 1);
      const target = tasks[0]!;

      // 用户删除
      await engine.deleteTask(account.id, target.id);
      const after = (await store.listTasks({ accountIds: [account.id], includeDeleted: true })).find(
        (x) => x.id === target.id,
      );
      assert.ok(after?.userDeletedAt, '墓碑应已落库');

      // 再同步：stub 推送同一条（title/id 都相同）→ 不得复活
      await engine.syncAll({});
      const final = (await store.listTasks({ accountIds: [account.id], includeDeleted: true })).find(
        (x) => x.id === target.id,
      );
      assert.ok(final?.userDeletedAt, '墓碑必须保留');
      assert.equal(final!.deletedAt ?? null, null, '不应走同步层的软删除');
      assert.equal((await engine.upcoming({ withinDays: 60 })).length, 0, '待办里不应再出现');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('用户删除 · 整个课程', () => {
  it('删课后任务隐藏，且之后的同步跳过该课程（0 请求）', async () => {
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
      await engine.syncAll({});
      const tasks = await store.listTasks({ accountIds: [account.id] });
      const internalCourseId = tasks[0]!.courseId;

      const r = await engine.deleteCourse(account.id, internalCourseId);
      assert.equal(r.removed, 1);

      // 再同步：课程在排除清单里 → 不爬
      control.fetchCalls = 0;
      const report = await engine.syncAll({});
      assert.equal(report.accounts[0]!.status, 'ok');
      assert.equal(control.fetchCalls, 0, '被删课程不应再产生任务请求');

      // 待办与已完成里都不再出现
      assert.equal((await engine.upcoming({ withinDays: 365 })).length, 0);
      assert.equal((await engine.completed({})).length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('删除不存在直接抛错（API 层转 400）', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
    };
    const { dir, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await assert.rejects(() => engine.deleteTask(account.id, '不存在'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('重新登录清除删课排除清单', () => {
  it('删整课后重新登录（应用内登录路径），课程恢复参与同步', async () => {
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
      await engine.syncAll({});
      const tasks = await store.listTasks({ accountIds: [account.id] });
      const internalCourseId = tasks[0]!.courseId;

      await engine.deleteCourse(account.id, internalCourseId);
      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 0, '删课后同步不爬');

      // 用户重新登录（应用内登录走的就是这条路径）→ 排除清单应被清空
      await engine.registerOfflineAccount('stub', 'u1', {});
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 1, '重新登录后课程应恢复参与同步');

      // 但已删除的任务不应复活（墓碑语义）
      const still = await store.listTasks({ accountIds: [account.id], includeDeleted: true });
      assert.ok(still.every((t) => t.userDeletedAt || !t.deletedAt), '墓碑保留，已删任务不复活');
      assert.equal((await engine.upcoming({ withinDays: 365 })).length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('registerOfflineAccount · 从网页存储提取 API token', () => {
  it('localStorage 快照里的 token 被注入 Authorization 头（雨课堂 401 根因）', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
    };
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const storage = JSON.stringify({
        authorization: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
        unrelated: 'value',
      });
      const account = await engine.registerOfflineAccount('stub', 'u1', { storage });
      const s = await vault.load(account.id);
      assert.equal(s?.headers?.Authorization, 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
      assert.equal(s?.origin, 'imported');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('已有账号再登录时刷新 token；快照无 token 时不覆盖', async () => {
    const control: StubControl = {
      probeCalls: 0,
      loginCalls: 0,
      fetchCalls: 0,
      probeAlwaysFails: false,
      coursesFail: false,
    };
    const { dir, vault, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.registerOfflineAccount('stub', 'u1', {});
      // 第一次无 token
      let s = await vault.load(account.id);
      assert.equal(s?.headers?.Authorization, undefined);

      // 登录拿到新 token → 再返回应用
      await engine.registerOfflineAccount('stub', 'u1', {
        storage: JSON.stringify({ token: 'new-token-value-12345' }),
      });
      s = await vault.load(account.id);
      assert.equal(s?.headers?.Authorization, 'new-token-value-12345');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('移除账号的墓碑（账号不再被静默重建）', () => {
  const baseControl = (): StubControl => ({
    probeCalls: 0,
    loginCalls: 0,
    fetchCalls: 0,
    probeAlwaysFails: false,
    coursesFail: false,
  });

  it('移除后：账号消失、游标一并清空、墓碑写入', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await store.setCursor({
        accountId: account.id,
        kind: 'course-crawl',
        cursor: '{"C1":"2026-01-01T00:00:00.000Z"}',
        updatedAt: new Date().toISOString(),
      });

      await engine.removeAccount(account.id);

      assert.equal((await store.listAccounts()).length, 0, '账号应被移除');
      assert.equal(
        await store.getCursor(account.id, 'course-crawl'),
        undefined,
        '游标必须一并清掉 —— 否则重新添加会继承旧的跳过清单',
      );
      const tomb = await store.getCursor('__removed__', account.id);
      assert.equal(tomb?.cursor, '1', '应写入墓碑');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('移除后从平台页返回（自动登记）→ 不重建，抛出可识别的 accountRemoved', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.removeAccount(account.id);

      await assert.rejects(
        () => engine.registerOfflineAccount('stub', 'u1', {}),
        (e: unknown) =>
          (e as { details?: { accountRemoved?: boolean } }).details?.accountRemoved === true,
      );
      assert.equal((await store.listAccounts()).length, 0, '不应被静默重建');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('用户确认后（explicit:true）重建成功，墓碑被撤掉', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.removeAccount(account.id);

      const back = await engine.registerOfflineAccount('stub', 'u1', { explicit: true });
      assert.equal(back.id, account.id);
      assert.equal((await store.listAccounts()).length, 1, '确认后应重新添加');
      const tomb = await store.getCursor('__removed__', account.id);
      assert.notEqual(tomb?.cursor, '1', '墓碑应被撤掉');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('账号密码登录同样撤掉墓碑（显式意图优先）', async () => {
    const { dir, store, engine } = await makeEngine(makeStubAdapter(baseControl()));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.removeAccount(account.id);
      await engine.login('stub', 'u1', { password: 'p1' });

      const tomb = await store.getCursor('__removed__', account.id);
      assert.notEqual(tomb?.cursor, '1', '用户在表单里显式添加 → 墓碑必须失效');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('重新添加的账号不继承旧账号的删课排除清单', async () => {
    const control = baseControl();
    const { dir, store, engine } = await makeEngine(makeStubAdapter(control));
    try {
      const account = await engine.login('stub', 'u1', { password: 'p1' });
      await engine.syncAll({});
      const tasks = await store.listTasks({ accountIds: [account.id] });
      await engine.deleteCourse(account.id, tasks[0]!.courseId);

      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 0, '删课后不该再爬（对照组）');

      // 移除 → 重新添加（用户确认）
      await engine.removeAccount(account.id);
      await engine.registerOfflineAccount('stub', 'u1', { explicit: true });

      control.fetchCalls = 0;
      await engine.syncAll({});
      assert.equal(control.fetchCalls, 1, '新账号必须重新爬取，不能继承旧的排除清单');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
