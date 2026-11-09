/**
 * 单个账号同步抛异常时，绝不能把整轮同步带崩，且必须留下一条同步日志。
 *
 * 真机 2026-11-09：智慧树抛 Invalid string length → 异常穿出 mapLimit →
 * syncAll 整体 reject → ① 同步日志里没有智慧树 ② 前端只弹一句原始错误。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
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
  UnavailableSigner,
} from '../src/index.ts';
import type { PlatformAdapter } from '../src/ports/adapter.ts';
import type { HttpClient } from '../src/ports/http.ts';

const noHttp: HttpClient = {
  async request() {
    throw new Error('本测试不起 HTTP');
  },
};

const SESSION = { platformId: 'boom', accountId: '', origin: 'imported' as const, cookies: {}, headers: {}, issuedAt: new Date().toISOString() };

class BoomAdapter implements PlatformAdapter {
  id = 'boom';
  displayName = 'Boom';
  homepage = 'https://example.com';
  capabilities = { courses: true, tasks: true, exams: true, incremental: false, cookieOnlySession: true, requiresNativeSigner: false, aggressiveAntiBot: false };
  authMethods = [];
  readonly readOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };
  sessionExpiryCauses = [];
  keepAliveProbe = { url: 'https://example.com/p', method: 'GET' as const, alivePattern: '.', intervalMs: 20 * 60 * 1000 };
  async login() { return SESSION; }
  async probeSession() { return true; }
  async fetchCourses(): Promise<never> {
    // 抛出「无法序列化」类错误，模拟 Invalid string length 未捕获
    throw new RangeError('Invalid string length');
  }
  async fetchTasks() { return { items: [], hasMore: false }; }
}

class OkAdapter implements PlatformAdapter {
  id = 'okp';
  displayName = 'Ok';
  homepage = 'https://example.com';
  capabilities = { courses: true, tasks: true, exams: false, incremental: false, cookieOnlySession: true, requiresNativeSigner: false, aggressiveAntiBot: false };
  authMethods = [];
  readonly readOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };
  sessionExpiryCauses = [];
  keepAliveProbe = { url: 'https://example.com/p', method: 'GET' as const, alivePattern: '.', intervalMs: 20 * 60 * 1000 };
  async login() { return { ...SESSION, platformId: 'okp' }; }
  async probeSession() { return true; }
  async fetchCourses() { return { hasMore: false, items: [] }; }
  async fetchTasks() { return { items: [], hasMore: false }; }
}

describe('单账号异常隔离', () => {
  it('某账号抛异常：其它账号照常同步，且异常账号写入一条 failed 日志', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-iso-'));
    const store = new MemoryStore();
    await store.init();
    const vault = new EncryptedVault({ directory: join(dir, 'sessions'), keyProvider: new StaticKeyProvider('k') });
    const registry = new AdapterRegistry();
    registry.register(new BoomAdapter());
    registry.register(new OkAdapter());
    const engine = new SyncEngine({ registry, store, vault, http: noHttp, clock: systemClock, logger: createSilentLogger(), signer: new UnavailableSigner() });
    const boom = await engine.registerOfflineAccount('boom', 'cookie-import', { label: '会炸的' });
    await engine.registerOfflineAccount('okp', 'cookie-import', { label: '正常的' });

    const report = await engine.syncAll({ refreshCourses: 'always' });
    // 整轮不 reject，两个账号都有报告
    assert.equal(report.accounts.length, 2);
    const boomReport = report.accounts.find((r) => r.accountId === boom.id)!;
    assert.equal(boomReport.status, 'failed', '异常账号应标记 failed 而非整体崩溃');
    // 关键：同步日志里**必须有**这个账号的失败记录
    const log = await store.listSyncLog(boom.id, 10);
    assert.ok(log.length >= 1, '异常账号必须在同步日志里留下记录');
    assert.equal(log[0]!.status, 'failed');
    assert.match(String(log[0]!.message), /Invalid string length|同步中断/);
  });
});
