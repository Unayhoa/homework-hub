/**
 * 共享课不能被「已完成课程跳过」逻辑跳过。
 *
 * 真机 2026-11-09：心理健康 78/78 视频全部看完 → 库里任务都是终态 →
 * 引擎 6 小时内跳过该课程 → fetchTasks 根本不发考试请求 →
 * 见面课测验/期末考试永远抓不到。共享课的任务点(视频)和作业/考试是两套数据，
 * 因此必须把「有 recruitId 的课程」排除在跳过与静默之外。
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
  makeCourseId,
} from '../src/index.ts';
import type { PlatformAdapter, FetchTasksRequest } from '../src/ports/adapter.ts';
import type { HttpClient, HttpResponse } from '../src/ports/http.ts';

const SESSION = {
  platformId: 'fake',
  accountId: '',
  origin: 'imported' as const,
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

const noHttp: HttpClient = {
  async request(): Promise<HttpResponse> {
    throw new Error('本测试不起 HTTP');
  },
};

class FakeAdapter implements PlatformAdapter {
  id = 'fake';
  displayName = 'Fake';
  homepage = 'https://example.com';
  capabilities = {
    courses: true,
    tasks: true,
    exams: true,
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };
  authMethods = [];
  readonly readOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };
  sessionExpiryCauses = [];
  keepAliveProbe = {
    url: 'https://example.com/ping',
    method: 'GET' as const,
    alivePattern: '.',
    intervalMs: 20 * 60 * 1000,
  };

  fetchTasksCalls: string[][] = [];

  async login() {
    return SESSION;
  }
  async probeSession() {
    return true;
  }
  async fetchCourses() {
    return {
      hasMore: false,
      items: [
        { platformCourseId: 'shared-1', name: '心理健康', raw: { recruitId: 368799 } },
        { platformCourseId: 'normal-1', name: '普通课', raw: {} },
      ],
    };
  }
  async fetchTasks(_ctx: unknown, _s: unknown, req: FetchTasksRequest) {
    this.fetchTasksCalls.push((req.courses ?? []).map((c) => c.platformCourseId));
    return { items: [], hasMore: false };
  }
  async fetchCourseProgress() {
    return { items: [], hasMore: false };
  }
}

describe('共享课不被「已完成跳过」吞掉', () => {
  it('共享课进入 fetchTasks，普通课可被跳过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-skip-'));
    const store = new MemoryStore();
    await store.init();
    const vault = new EncryptedVault({
      directory: join(dir, 'sessions'),
      keyProvider: new StaticKeyProvider('test-key'),
    });
    const registry = new AdapterRegistry();
    const adapter = new FakeAdapter();
    registry.register(adapter);
    const engine = new SyncEngine({
      registry,
      store,
      vault,
      http: noHttp,
      clock: systemClock,
      logger: createSilentLogger(),
      signer: new UnavailableSigner(),
    });
    const account = await engine.registerOfflineAccount('fake', 'cookie-import', { label: 'a' });
    // 先落一轮课程（含 raw.recruitId），模拟「刷新课程列表」把共享课拉进来
    await engine.syncAll({ refreshCourses: 'always' });
    adapter.fetchTasksCalls.length = 0;

    const sharedId = makeCourseId('fake', account.id, 'shared-1');
    const normalId = makeCourseId('fake', account.id, 'normal-1');
    const now = new Date().toISOString();
    await store.upsertTasks([
      {
        id: `${sharedId}:t1`,
        platformId: 'fake',
        platformTaskId: 't1',
        accountId: account.id,
        courseId: sharedId,
        courseName: '心理健康',
        kind: 'quiz',
        title: '旧测验',
        status: 'graded',
        deadline: { kind: 'absolute', at: '2099-01-01T00:00:00.000Z' },
        absentCount: 0,
        fingerprint: 'f1',
        revision: 1,
        history: [],
        firstSeenAt: now,
        lastSeenAt: now,
      },
      {
        id: `${normalId}:t2`,
        platformId: 'fake',
        platformTaskId: 't2',
        accountId: account.id,
        courseId: normalId,
        courseName: '普通课',
        kind: 'homework',
        title: '旧作业',
        status: 'graded',
        deadline: { kind: 'absolute', at: '2099-01-01T00:00:00.000Z' },
        absentCount: 0,
        fingerprint: 'f2',
        revision: 1,
        history: [],
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ]);
    await store.setCursor({
      accountId: account.id,
      kind: 'course-crawl',
      cursor: JSON.stringify({ 'shared-1': now, 'normal-1': now }),
      updatedAt: now,
    });

    await engine.syncAll({});
    const seen = adapter.fetchTasksCalls.flat();
    assert.ok(seen.includes('shared-1'), '共享课必须仍然进入 fetchTasks（否则考试抓不到）');
    assert.ok(!seen.includes('normal-1'), '普通课已完成且 TTL 内应被跳过');
  });
});


