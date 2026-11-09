/**
 * 「一键重登」不能丢用户偏好。
 *
 * 真机 2026-11-09 事故：重登时 accountId 只存在 JS 全局，切到官方登录页再回来
 * WebView 重载、全局丢失 → registerOfflineAccount 按 `platform::browser` 新建账号
 * → 同一批课程按平台原名又抓一遍，用户看到"改名失效、待办从 21 涨到 39"。
 *
 * 这组测试锁住三条：
 *   1. 带 accountId + preserveCourseSelection 时不新建账号、username 不被 'browser' 覆盖；
 *   2. 课程勾选（course-mute）与改名（displayName）在重登后仍在；
 *   3. 误建的 `platform::browser` 兄弟账号会被自愈清理。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  systemClock,
} from '../src/index.ts';
import type { PlatformAdapter } from '../src/ports/adapter.ts';
import type { HttpClient } from '../src/ports/http.ts';

const noHttp: HttpClient = {
  async request() {
    throw new Error('本测试不起 HTTP');
  },
};

function stubAdapter(): PlatformAdapter {
  return {
    id: 'zhs',
    displayName: '智慧树',
    homepage: 'https://example.com',
    capabilities: { courses: true, tasks: true, exams: false, incremental: false, cookieOnlySession: true, requiresNativeSigner: false, aggressiveAntiBot: false },
    authMethods: [],
    readOnlyPolicy: { allowMethods: ['GET', 'HEAD'] },
    sessionExpiryCauses: [],
    keepAliveProbe: { url: 'https://example.com/p', method: 'GET', alivePattern: '.', intervalMs: 900000 },
    async login() {
      return { platformId: 'zhs', accountId: '', origin: 'imported', cookies: {}, headers: {}, issuedAt: new Date().toISOString() };
    },
    async probeSession() {
      return true;
    },
    async fetchCourses() {
      return { hasMore: false, items: [] };
    },
    async fetchTasks() {
      return { items: [], hasMore: false };
    },
  } as unknown as PlatformAdapter;
}

async function makeEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'hub-relogin-acct-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({ directory: join(dir, 's'), keyProvider: new StaticKeyProvider('k') });
  const engine = new SyncEngine({
    registry: new AdapterRegistry().register(stubAdapter()),
    store,
    vault,
    http: noHttp,
    clock: systemClock,
    logger: createSilentLogger(),
  });
  return { dir, store, vault, engine };
}

describe('一键重登不丢用户偏好', () => {
  it('带 accountId + preserve 时归到原账号，username 不被 browser 覆盖', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      // 原账号（账号密码登录的身份）
      const orig = await engine.registerOfflineAccount('zhs', '18939527235', { label: '学习通' });
      // 模拟「一键重登」从官方页返回：username 占位 'browser'，但带 targetAccountId
      const after = await engine.registerOfflineAccount('zhs', 'browser', {
        accountId: orig.id,
        preserveCourseSelection: true,
        freshLogin: true,
      });
      assert.equal(after.id, orig.id, '必须归到原账号，不能新建');
      assert.equal(after.username, '18939527235', 'username 不能被占位的 browser 覆盖');

      const all = await store.listAccounts();
      assert.equal(all.filter((a) => a.platformId === 'zhs').length, 1, '同平台不应出现第二个账号');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('重登后课程勾选与改名都保留', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      const orig = await engine.registerOfflineAccount('zhs', 'u1', { label: '学习通' });
      const courseId = `zhs:${orig.id}:C1`;
      await store.upsertCourses([{
        id: courseId, platformId: 'zhs', accountId: orig.id, platformCourseId: 'C1',
        name: '计算机组成原理', displayName: '计组（我改的名）', lastSeenAt: new Date().toISOString(),
      }]);
      await engine.setCourseMuted(orig.id, courseId, true);

      await engine.registerOfflineAccount('zhs', 'browser', {
        accountId: orig.id,
        preserveCourseSelection: true,
        freshLogin: true,
      });

      const courses = await store.listCourses([orig.id]);
      const c = courses.find((x) => x.id === courseId)!;
      assert.equal(c.displayName, '计组（我改的名）', '改名必须保留');
      const mute = await store.getCursor(orig.id, 'course-mute');
      assert.ok((mute?.cursor ?? '').includes(courseId), '取消勾选状态必须保留');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('误建的 platform::browser 兄弟账号会被自愈清理', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      const orig = await engine.registerOfflineAccount('zhs', 'u1', { label: '学习通' });
      // 模拟旧版本 bug 留下的残留账号
      await engine.registerOfflineAccount('zhs', 'browser', { label: '智慧树' });
      assert.equal((await store.listAccounts()).length, 2, '先造出两条');

      await engine.registerOfflineAccount('zhs', 'browser', {
        accountId: orig.id,
        preserveCourseSelection: true,
        freshLogin: true,
      });

      const all = await store.listAccounts();
      assert.equal(all.length, 1, '误建的 browser 账号应被清理');
      assert.equal(all[0]!.id, orig.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
