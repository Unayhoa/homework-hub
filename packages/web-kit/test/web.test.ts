/**
 * web-kit 单元测试 —— 浏览器端三块实现（存储 / 加密 / 原生桥）。
 *
 * 为什么值得单独测：Android 端没法像 CLI 那样随手跑一遍看输出，
 * 出问题的表现是**白屏**或者「数据莫名其妙丢了」。
 * 所以这三块必须在 Node 里被完整验证过再打包进 APK。
 *
 * 测试环境靠两个替身：
 *   - 内存版 localStorage（Node 没有 localStorage）
 *   - 假的 window.Android + __hhBridge（模拟原生侧回调）
 * WebCrypto 用 Node 自带的 globalThis.crypto（与浏览器同一套标准 API）。
 *
 * 运行：node --test packages/web-kit/test/web.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PersistentStore,
  WebCryptoVault,
  BridgeHttpClient,
  hasNativeBridge,
  ensureBridgeCallbacks,
  localStorageAdapter,
  memoryStorage,
} from '../src/index.ts';
import type { WebStorage } from '../src/index.ts';

// ---------------------------------------------------------------- 替身

/** localStorage 的内存版（含 keys()，符合 WebStorage 契约）。 */
function fakeLocalStorage(): WebStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries(map),
  };
}

/** 一个最小的 window 替身（bridge-http 只需要 window.Android 与 window.__hhBridge）。 */
function installFakeWindow(handler: (req: FakeNativeRequest) => FakeNativeResponse | Error): {
  requests: FakeNativeRequest[];
  uninstall(): void;
} {
  const requests: FakeNativeRequest[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;

  const win: Record<string, unknown> = {
    Android: {
      httpRequest(id: string, method: string, url: string, headersJson: string, body: string | null) {
        const req: FakeNativeRequest = { id, method, url, headers: JSON.parse(headersJson), body };
        requests.push(req);
        // 模拟原生：立刻返回，稍后通过 evaluateJavascript 回调
        setTimeout(() => {
          const bridge = win.__hhBridge as { resolve(id: string, json: string): void; reject(id: string, json: string): void };
          const out = handler(req);
          if (out instanceof Error) bridge.reject(id, JSON.stringify({ message: out.message }));
          else bridge.resolve(id, JSON.stringify(out));
        }, 1);
      },
    },
  };
  globals.window = win;
  ensureBridgeCallbacks();
  return {
    requests,
    uninstall() {
      delete globals.window;
    },
  };
}

interface FakeNativeRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface FakeNativeResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
}

// ---------------------------------------------------------------- 持久化存储

describe('浏览器端持久化存储', () => {
  test('写入后重建实例仍能读回（App 重启场景）', async () => {
    const ls = fakeLocalStorage();

    const first = new PersistentStore({ storage: ls, debounceMs: 0 });
    await first.init();
    await first.upsertAccount({
      id: 'mock::1',
      platformId: 'mock',
      label: '张同学',
      username: '1',
      enabled: true,
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    await first.appendSyncLog({
      accountId: 'mock::1',
      platformId: 'mock',
      startedAt: '2026-09-25T00:00:00.000Z',
      finishedAt: '2026-09-25T00:00:01.000Z',
      status: 'ok',
      created: 3,
      updated: 0,
      removed: 0,
      fetched: 3,
    });

    // 模拟 App 被杀掉后重新打开
    const second = new PersistentStore({ storage: ls, debounceMs: 0 });
    await second.init();

    const accounts = await second.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.label, '张同学');
    assert.equal((await second.listSyncLog('mock::1'))[0]!.created, 3);
  });

  test('去抖写入：多次变更只落盘一次，flush 后立刻可见', async () => {
    const ls = fakeLocalStorage();
    let writes = 0;
    const counting: WebStorage = {
      ...ls,
      setItem: (k, v) => {
        writes += 1;
        ls.setItem(k, v);
      },
    };

    const store = new PersistentStore({ storage: counting, debounceMs: 50 });
    await store.init();
    for (let i = 0; i < 5; i += 1) {
      await store.upsertAccount({
        id: `a${i}`,
        platformId: 'p',
        label: `账号 ${i}`,
        username: String(i),
        enabled: true,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
    }
    assert.equal(writes, 0, '去抖窗口内不应落盘');

    store.flush();
    assert.equal(writes, 1, '去抖合并成一次写入');
    assert.equal(Object.keys(JSON.parse(ls.getItem('hh.state.v1')!).accounts).length, 5);
  });

  test('数据损坏时不清库（与桌面端 JsonFileStore 同策略）', async () => {
    const ls = fakeLocalStorage();
    ls.setItem('hh.state.v1', '{ 这不是合法 JSON');

    const errors: unknown[] = [];
    const store = new PersistentStore({ storage: ls, debounceMs: 0, onError: (e) => errors.push(e) });
    await store.init();

    assert.equal(errors.length, 1, '应上报错误');
    assert.deepEqual(await store.listAccounts(), [], '读不出来就是空的');
    // 但绝不能把原始内容抹掉 —— 用户可能还想抢救
    assert.ok(ls.getItem('hh.state.v1')!.includes('这不是合法 JSON'));
  });

  test('删除账号会连带清掉它的课程、任务与提醒', async () => {
    const store = new PersistentStore({ storage: fakeLocalStorage(), debounceMs: 0 });
    await store.init();
    await store.upsertAccount({
      id: 'a',
      platformId: 'p',
      label: 'A',
      username: 'a',
      enabled: true,
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    await store.upsertCourses([
      {
        id: 'c1',
        accountId: 'a',
        platformId: 'p',
        platformCourseId: 'C1',
        name: '数据库',
        lastSeenAt: '2026-09-25T00:00:00.000Z',
      },
    ]);
    await store.removeAccount('a');
    assert.equal((await store.listCourses()).length, 0);
  });
});

// ---------------------------------------------------------------- 加密保险箱

describe('WebCrypto 会话保险箱', () => {
  const session = {
    platformId: 'chaoxing',
    accountId: 'chaoxing::20230001',
    origin: 'imported' as const,
    cookies: { JSESSIONID: 'SUPER-SECRET-TOKEN' },
    headers: { Authorization: 'Bearer TOP-SECRET' },
    issuedAt: '2026-09-25T00:00:00.000Z',
  };

  test('存读一致，且密文里不含明文凭证', async () => {
    const ls = fakeLocalStorage();
    const vault = new WebCryptoVault({ storage: ls });

    await vault.save(session);
    const loaded = await vault.load(session.accountId);

    assert.deepEqual(loaded?.cookies, session.cookies);
    assert.equal(loaded?.origin, 'imported');

    const all = JSON.stringify(ls.dump());
    assert.ok(!all.includes('SUPER-SECRET-TOKEN'), '明文 cookie 泄露到了存储里');
    assert.ok(!all.includes('TOP-SECRET'), '明文 Authorization 泄露了');
    assert.equal(await vault.load('chaoxing::99999'), undefined);
  });

  test('list 能列出账号，remove 之后读不到', async () => {
    const ls = fakeLocalStorage();
    const vault = new WebCryptoVault({ storage: ls });
    await vault.save(session);
    assert.deepEqual(await vault.list(), [session.accountId]);

    await vault.remove(session.accountId);
    assert.equal(await vault.load(session.accountId), undefined);
    assert.deepEqual(await vault.list(), []);
  });

  test('主密钥被清掉时抛出可操作的错误，而不是静默当作未登录', async () => {
    const ls = fakeLocalStorage();
    const vault = new WebCryptoVault({ storage: ls });
    await vault.save(session);

    // 模拟「浏览器清理了站点数据」：只留下密文，密钥没了
    const dump = ls.dump();
    const fresh = fakeLocalStorage();
    for (const [k, v] of Object.entries(dump)) {
      if (k !== 'hh.masterkey.v1') fresh.setItem(k, v);
    }

    const brokenVault = new WebCryptoVault({ storage: fresh, onError: () => {} });
    await assert.rejects(
      () => brokenVault.load(session.accountId),
      /重新登录该账号/,
    );
  });

  test('重新打开（复用同一密钥）仍能解密 —— 密钥确实被持久化了', async () => {
    const ls = fakeLocalStorage();
    await new WebCryptoVault({ storage: ls }).save(session);
    // 新实例：只能从存储里读回密钥
    const again = await new WebCryptoVault({ storage: ls }).load(session.accountId);
    assert.deepEqual(again?.cookies, session.cookies);
  });
});

// ---------------------------------------------------------------- 原生桥

describe('Android 原生 HTTP 桥', () => {
  test('没有原生桥时给出可操作的错误（而不是静默失败）', async () => {
    const client = new BridgeHttpClient();
    await assert.rejects(
      () => client.request({ url: 'https://x/y', method: 'GET' }, { platformId: 'p' }),
      /没有原生 HTTP 桥/,
    );
  });

  test('请求经桥转发并还原响应（状态 / 头 / 正文）', async () => {
    const fake = installFakeWindow(() => ({
      status: 200,
      url: 'https://p.example.edu/api/tasks?cursor=0',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
      text: '{"list":[{"id":"w1"}]}',
    }));
    try {
      const client = new BridgeHttpClient();
      const res = await client.request(
        {
          url: 'https://p.example.edu/api/tasks?cursor=0',
          method: 'POST',
          json: { courseId: 'C1' },
        },
        { platformId: 'p' },
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers['x-trace'], 'abc', '响应头应统一小写');
      assert.deepEqual(await res.json(), { list: [{ id: 'w1' }] });

      // 桥收到的请求应带上 JSON body 与 Content-Type
      const sent = fake.requests[0]!;
      assert.equal(sent.method, 'POST');
      assert.equal(sent.headers['Content-Type'], 'application/json');
      assert.equal(sent.body, '{"courseId":"C1"}');
    } finally {
      fake.uninstall();
    }
  });

  test('表单请求自动补 urlencoded Content-Type', async () => {
    const fake = installFakeWindow(() => ({ status: 200, url: 'https://x/', headers: {}, text: '{}' }));
    try {
      await new BridgeHttpClient().request(
        { url: 'https://x/login', method: 'POST', form: { uname: 'a', password: 'b' } },
        { platformId: 'p' },
      );
      assert.equal(fake.requests[0]!.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(fake.requests[0]!.body, 'uname=a&password=b');
    } finally {
      fake.uninstall();
    }
  });

  test('原生侧报错会转成异常，不会被当成空数据', async () => {
    const fake = installFakeWindow(() => new Error('连接被拒绝'));
    try {
      await assert.rejects(
        () => new BridgeHttpClient().request({ url: 'https://x/y', method: 'GET' }, { platformId: 'p' }),
        /连接被拒绝/,
      );
    } finally {
      fake.uninstall();
    }
  });

  test('请求超时会明确报超时，而不是一直挂着', async () => {
    const fake = installFakeWindow(() => {
      // 永远不回调
      return { status: 0, url: '', headers: {}, text: '' };
    });
    // 让 handler 什么都不回：包一层直接吞掉回调
    const globals = globalThis as unknown as Record<string, unknown>;
    (globals.window as { Android: { httpRequest: () => void } }).Android.httpRequest = () => {};
    try {
      await assert.rejects(
        () =>
          new BridgeHttpClient({ timeoutMs: 60 }).request(
            { url: 'https://x/slow', method: 'GET' },
            { platformId: 'p' },
          ),
        /请求超时/,
      );
    } finally {
      fake.uninstall();
    }
  });

  test('hasNativeBridge 能正确识别环境', () => {
    assert.equal(hasNativeBridge(), false);
    const fake = installFakeWindow(() => ({ status: 200, url: '', headers: {}, text: '{}' }));
    try {
      assert.equal(hasNativeBridge(), true);
    } finally {
      fake.uninstall();
    }
  });
});

// ---------------------------------------------------------------- 适配器辅助

describe('存储辅助', () => {
  test('localStorageAdapter 支持真实 localStorage 的 keys() 语义', () => {
    // 用一个符合 DOM Storage 形状的对象
    const backing = new Map<string, string>();
    const ls = {
      get length() {
        return backing.size;
      },
      key: (i: number) => [...backing.keys()][i] ?? null,
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    } as unknown as Storage;

    const adapter = localStorageAdapter(ls);
    adapter.setItem('a', '1');
    adapter.setItem('b', '2');
    assert.deepEqual(adapter.keys().sort(), ['a', 'b']);
    adapter.removeItem('a');
    assert.deepEqual(adapter.keys(), ['b']);
  });

  test('memoryStorage 兜底实现可用（隐私模式下不白屏）', () => {
    const s = memoryStorage();
    s.setItem('k', 'v');
    assert.equal(s.getItem('k'), 'v');
    s.removeItem('k');
    assert.equal(s.getItem('k'), null);
    assert.deepEqual(s.keys(), []);
  });
});
