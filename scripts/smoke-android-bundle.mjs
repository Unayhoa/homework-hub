#!/usr/bin/env node
/**
 * 冒烟测试：直接加载**打进 APK 的编译产物**，验证模块图能跑起来。
 *
 * 为什么需要它：Android 端出问题时的表现是白屏，而白屏的原因往往极其隐蔽 ——
 * 说明符没改写、某个模块引了 node: 前缀、桶文件少导出一个名字。
 * 这些在 tsc 阶段不报错，在 Gradle 阶段也不报错，只有真机运行才发现。
 *
 * 这里在 Node 里模拟浏览器环境（不引 DOM，只给 WebCrypto 这类标准 API），
 * 把 assets/www/hh 下的模块按 main.js 的接法装配起来，
 * 然后跑一遍 /api/state、/api/login、/api/import-har，看是否返回合理结果。
 *
 * 用法：node scripts/smoke-android-bundle.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE = join(ROOT, 'android/app/src/main/assets/www/hh');

const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

if (!existsSync(BUNDLE)) {
  fail(`没有找到编译产物 ${BUNDLE}。先执行：npm run android:sync`);
}

const load = (rel) => import(pathToFileURL(join(BUNDLE, rel)).href);

// ---- 模拟浏览器里存在、Node 里缺失的东西 ----
globalThis.window = globalThis.window ?? { location: { href: 'https://appassets.androidplatform.net/index.html' } };
if (!globalThis.window.localStorage) {
  const map = new Map();
  globalThis.window.localStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
  };
}

// ---------------------------------------------------------------- 1. 加载模块

log('加载编译产物…');
let core;
let webKit;
let registryMod;
let apiMod;
try {
  core = await load('packages/core/src/index.browser.js');
  webKit = await load('packages/web-kit/src/index.js');
  registryMod = await load('packages/adapters/registry.js');
  apiMod = await load('apps/web/src/api.js');
} catch (e) {
  fail(`模块加载失败（真机上就是白屏）：\n  ${e.message}`);
}

// 桶文件是否导出了我们依赖的名字 —— 漏导出是典型的「加载成功但一调用就 undefined」
for (const [name, mod, keys] of [
  ['core', core, ['SyncEngine', 'MemoryStore', 'HubError', 'systemClock', 'HarReplayHttpClient', 'UnavailableSigner']],
  ['web-kit', webKit, ['PersistentStore', 'WebCryptoVault', 'BridgeHttpClient', 'memoryStorage']],
  ['adapters/registry', registryMod, ['createProductionRegistry']],
  ['api', apiMod, ['createApiHandler', 'platformSummaries']],
]) {
  const missing = keys.filter((k) => mod[k] === undefined);
  if (missing.length > 0) fail(`${name} 缺少导出：${missing.join(', ')}`);
}
log('  导出检查：通过');

// ---------------------------------------------------------------- 2. 按 main.js 的方式装配

const storage = webKit.memoryStorage();
const store = new webKit.PersistentStore({ storage, debounceMs: 0 });
await store.init();
const vault = new webKit.WebCryptoVault({ storage });
const registry = registryMod.createProductionRegistry();

const platforms = registry.list().map((a) => a.id);
if (!platforms.includes('chaoxing') || platforms.includes('mock')) {
  fail(`平台清单不对（不该含 mock，必须含 chaoxing）：${platforms.join(', ')}`);
}
log(`  注册平台：${platforms.join(', ')}`);

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const reminders = [];
const engine = new core.SyncEngine({
  registry,
  store,
  vault,
  http: new webKit.BridgeHttpClient(),
  clock: core.systemClock,
  logger,
  signer: new core.UnavailableSigner(),
  reminderSink: { deliver: async (r) => void reminders.push(r) },
});

const handle = apiMod.createApiHandler({
  engine,
  store,
  vault,
  registry,
  logger,
  clock: core.systemClock,
  reminders,
  buildTransport: async (kind, payload) => {
    if (kind === 'attach') throw new core.HubError('NOT_SUPPORTED', '手机上不支持 CDP 附着');
    return new core.HarReplayHttpClient(String(payload.har ?? ''));
  },
});

const call = (method, pathname, body = '', search = new URLSearchParams()) =>
  handle({ method, pathname, search, body });

// ---------------------------------------------------------------- 3. 打接口

log('\n调用接口…');
const state = await call('GET', '/api/state');
if (state.status !== 200) fail(`/api/state 返回 ${state.status}：${JSON.stringify(state.body)}`);
if (!state.body.grouped || !state.body.platforms) fail('/api/state 缺少 grouped 或 platforms');
log(`  GET  /api/state      → 200（平台 ${state.body.platforms.length} 个，待办 ${state.body.counts.total}）`);

const login = await call(
  'POST',
  '/api/login',
  JSON.stringify({ platformId: 'chaoxing', method: 'cookie-import', username: 'test', cookie: 'JSESSIONID=abc' }),
);
if (login.status !== 200) fail(`cookie 导入失败：${JSON.stringify(login.body)}`);
const accountId = login.body.account.id;
log(`  POST /api/login      → 200（离线登记，未发请求）`);

// 会话应能加密落盘并读回
const session = await vault.load(accountId);
if (session?.cookies?.JSESSIONID !== 'abc') fail('会话未正确加密保存');
log(`  会话加密落盘          → 通过（origin=${session.origin}）`);

// 没有原生桥时同步应报错而非静默成功 —— 这正是「不静默失败」原则在手机上的体现
const sync = await call('POST', '/api/sync');
const acc0 = sync.body?.accounts?.[0];
if (!acc0) fail(`/api/sync 响应异常：${JSON.stringify(sync.body)}`);
if (acc0.status === 'ok') fail('没有原生桥却同步成功了？不该发生');
if (!/没有原生 HTTP 桥/.test(acc0.message ?? '')) {
  fail(`同步失败原因不对：${acc0.message}`);
}
log(`  POST /api/sync       → 报错清晰：${(acc0.message ?? '').slice(0, 40)}…`);

// HAR 回放：零网络路径，应该能跑通（用一个最小 HAR）
const har = JSON.stringify({
  log: {
    version: '1.2',
    creator: { name: 'smoke', version: '1' },
    entries: [
      {
        request: { method: 'GET', url: 'https://mooc1-2.chaoxing.com/visit/interaction' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'text/html' }],
          content: { size: 10, mimeType: 'text/html', text: '<html></html>' },
        },
      },
    ],
  },
});
const replayed = await call('POST', '/api/import-har', JSON.stringify({ platformId: 'chaoxing', har }));
if (replayed.status !== 200) fail(`HAR 回放失败：${JSON.stringify(replayed.body)}`);
log(`  POST /api/import-har → 200（回放命中，未联网）`);

const changes = await call('GET', '/api/changes');
const logs = await call('GET', '/api/log');
if (changes.status !== 200 || logs.status !== 200) fail('变更/日志接口异常');
log(`  GET  /api/changes、/api/log → 200`);

// ---------------------------------------------------------------- 4. 持久化跨实例

store.flush();
const store2 = new webKit.PersistentStore({ storage, debounceMs: 0 });
await store2.init();
const accounts = await store2.listAccounts();
if (accounts.length < 2) fail(`重启后账号丢失：${accounts.length}`);
log(`\n  重启后仍能读回 ${accounts.length} 个账号 → 持久化通过`);

log('\n✓ 打包产物冒烟测试全部通过');
