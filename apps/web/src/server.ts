/**
 * HomeworkHub 本地 Web App —— Node HTTP 载体。
 *
 * 这里只做三件事：起 HTTP 服务、签发/校验局域网令牌、回静态资源。
 * 所有 API 逻辑在 api.ts（与传输层无关），因为同一份 API 还要跑在
 * Android WebView 里（那边不走网络，直接拦截 fetch）。
 *
 * 为什么选「本地 server + 网页」而不是直接上 Tauri / Electron / RN：
 *   1. 零新依赖、零构建。核心库本来就是纯 TS。
 *   2. 天然跨平台：Windows / macOS / Linux / 手机浏览器全都能开。
 *   3. 是后续所有壳层的底座。
 *
 * 安全边界：
 *   - 默认只监听 127.0.0.1（别的设备连不上）
 *   - --lan 时强制要求令牌；令牌打印在启动日志里，不落盘
 *   - 数据（含加密的会话）都在本机；任务接口不外传平台原始报文
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, normalize, isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ConsoleLogger,
  EncryptedVault,
  FetchHttpClient,
  FileKeyProvider,
  HubError,
  JsonFileStore,
  SyncEngine,
  UnavailableSigner,
  systemClock,
} from '#core';
import type { PlannedReminder } from '#core';
import { createDefaultRegistry } from '#adapters';

import { createApiHandler, createTransportFactory } from './api.ts';

// ---------------------------------------------------------------- 应用装配

const workspace = process.env.HH_HOME ?? join(homedir(), '.homework-hub');
const logger = new ConsoleLogger({ level: (process.env.HH_LOG as 'debug') ?? 'info', color: false });

/** 最近触发的提醒（内存），给 UI 的「提醒」区用。 */
const recentReminders: PlannedReminder[] = [];

const store = new JsonFileStore(join(workspace, 'state.json'));
await store.init();

const vault = new EncryptedVault({
  directory: join(workspace, 'sessions'),
  keyProvider: new FileKeyProvider(join(workspace, 'master.key')),
});

const registry = createDefaultRegistry({ mockBaseUrl: process.env.HH_MOCK_URL });

const engine = new SyncEngine({
  registry,
  store,
  vault,
  http: new FetchHttpClient({}),
  clock: systemClock,
  logger,
  signer: new UnavailableSigner(),
  reminderSink: {
    deliver: async (r) => {
      // 内存里留最近 50 条给 UI 展示；系统通知是壳层的事
      recentReminders.unshift(r);
      if (recentReminders.length > 50) recentReminders.pop();
    },
  },
});

/**
 * 把样本包写到仓库里的 `samples/<host>/<ts>.json`。
 *
 * 只在桌面端注入：手机端没有可写的项目目录，样本存在 store 里靠「复制」带出来。
 * 落进仓库的意义是它能被 `probe-samples.test.ts` 直接读进来当回归判据 ——
 * 识别器每次改动都有真实现场可比，而不是靠手写 fixture 自说自话。
 */
async function saveSampleFile(pack: { platformHint: string; capturedAt: string }): Promise<{ path: string }> {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const host = String(pack.platformHint || 'unknown-host').replace(/[^A-Za-z0-9.-]/g, '_');
  const dir = join(root, 'samples', host);
  await mkdir(dir, { recursive: true });
  const stamp = pack.capturedAt.replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}.json`);
  await writeFile(file, JSON.stringify(pack, null, 2), 'utf8');
  return { path: relative(root, file).replace(/\\/g, '/') };
}

const handleApi = createApiHandler({
  engine,
  store,
  vault,
  registry,
  logger,
  clock: systemClock,
  reminders: recentReminders,
  buildTransport: createTransportFactory(),
  saveSample: saveSampleFile,
});

// ---------------------------------------------------------------- 工具

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limitBytes = 30 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject(e));
  });
}

// ---------------------------------------------------------------- 静态资源

const STATIC_FILES: Record<string, { path: string; type: string }> = {
  '/': { path: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { path: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { path: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { path: 'style.css', type: 'text/css; charset=utf-8' },
};

const PUBLIC_DIR = join(normalize(import.meta.dirname ?? '.'), '..', 'public');

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const file = join(PUBLIC_DIR, entry.path);
  // 白名单机制下不需要防目录穿越，但保险起见仍确认路径没跑出 public/
  if (!isAbsolute(file) || !normalize(file).startsWith(normalize(PUBLIC_DIR))) return false;
  const content = await readFile(file, 'utf8');
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(content),
  });
  res.end(content);
  return true;
}

// ---------------------------------------------------------------- 令牌（LAN 模式）

const args = process.argv.slice(2);
const lanMode = args.includes('--lan');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1] ?? 7777) : 7777;
const accessToken = lanMode ? randomBytes(9).toString('base64url') : undefined;

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!accessToken) return true;
  const q = url.searchParams.get('token');
  const h = req.headers['x-token'];
  return q === accessToken || h === accessToken;
}

// ---------------------------------------------------------------- 服务器

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  void (async () => {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) {
        return json(res, 401, { ok: false, error: '需要访问令牌（看服务启动日志里的局域网地址）' });
      }
      const body = await readBody(req);
      const result = await handleApi({
        method: (req.method ?? 'GET').toUpperCase(),
        pathname: url.pathname.replace(/\/+$/, '') || '/api',
        search: url.searchParams,
        body,
      });
      return json(res, result.status, result.body);
    }
    if (await serveStatic(res, url.pathname)) return;
    json(res, 404, { ok: false, error: 'not found' });
  })().catch((e: unknown) => {
    const msg = e instanceof HubError ? `[${e.code}] ${e.message}` : ((e as Error).message ?? String(e));
    json(res, 500, { ok: false, error: msg });
  });
});

server.listen(port, lanMode ? '0.0.0.0' : '127.0.0.1');

console.log(`\n  课业中枢已启动：http://127.0.0.1:${port}/`);
console.log(`  数据目录：${workspace}`);
if (lanMode) {
  console.log(`\n  局域网访问（手机连同一 WiFi，浏览器打开下面任意一个地址）：`);
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      console.log(`    http://${net.address}:${port}/?token=${accessToken}`);
    }
  }
  console.log(`\n  令牌：${accessToken}（每次启动都会换一个）`);
} else {
  console.log(`  手机访问：重启并加 --lan 参数（会监听局域网并生成访问令牌）`);
}
console.log(`  说明：mock 之外的平台适配器为实验性，需用真实账号验证后再正式使用。\n`);
