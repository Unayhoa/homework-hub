/**
 * Android WebView 入口 —— 引擎在网页里跑，网络走原生桥。
 *
 * 与前端的衔接方式：**不改前端**。
 * apps/web/public/app.js 里有几十处 `fetch('/api/xxx')`，
 * 这里直接把它拦下来、交给 api.ts 里的同一个 handler。
 * 于是「UI 只认 HTTP 接口」这个约定被保留，桌面端与手机端
 * 共用同一份 UI 代码、同一份 API 实现 —— 只换了传输方式。
 *
 *   WebView 里：  app.js → fetch('/api/sync') → [本文件拦截] → engine → 原生桥 → 平台
 *   电脑上：      app.js → fetch('/api/sync') → HTTP      → server.ts → engine → fetch → 平台
 *
 * 三件必须替换掉的 Node 依赖（见 packages/web-kit）：
 *   JsonFileStore   → PersistentStore（localStorage 持久化）
 *   EncryptedVault  → WebCryptoVault（AES-256-GCM）
 *   FetchHttpClient → BridgeHttpClient（原生网络栈，绕开 CORS）
 */
import {
  ConsoleLogger,
  readNotifyPrefs,
  writeNotifyPrefs,
  SyncEngine,
  UnavailableSigner,
  systemClock,
  HubError,
} from '#core';
import type { HttpClient, PlannedReminder } from '#core';
import { createProductionRegistry } from '#registry-browser';
import {
  BridgeHttpClient,
  PersistentStore,
  WebCryptoVault,
  localStorageAdapter,
  memoryStorage,
  nativeKvStorage,
} from '#web-kit';
import type { NativeKvBridge, WebStorage } from '#web-kit';
import { createApiHandler } from '#api';

/**
 * 通知相关桥。原生契约见 android/.../NotificationScheduler.java。
 * 用「按需 cast」而不是扩展 AndroidBridgeHost：那几个成员只有这个平台用得上。
 */
interface NativeNotifyBridge {
  /** 下发未来要弹的通知排期（全量替换） */
  scheduleReminders?: (json: string) => void;
  /** 'granted' / 'denied' */
  notificationPermission?: () => string;
  openNotificationSettings?: () => void;
}

// ---------------------------------------------------------------- 存储

function pickStorage(): WebStorage {
  const bridge = (window as unknown as { Android?: NativeKvBridge }).Android;

  // 手机端：状态交给原生写文件。
  //
  // 为什么不用 localStorage（真机踩过）：WebView 的 localStorage 是
  // 「先写内存、由浏览器引擎择机刷盘」。App 被从最近任务里划掉时进程直接被杀，
  // **未刷盘的那部分就丢了** —— 表现为「同步后都显示正常，清除后台重进
  // 就少了最后同步的那个平台」（超星 84 条，正好是最后写入的一批）。
  // 原生侧是同步写文件 + fsync，写成功即落盘，不依赖任何时机。
  if (bridge?.kvSet) {
    return migrateFromLocalStorage(nativeKvStorage(bridge));
  }

  try {
    const ls = window.localStorage;
    // iOS/隐私模式下 localStorage 可能「存在但不可写」，所以要实际写一次验证
    const probe = 'hh.probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return localStorageAdapter(ls);
  } catch {
    console.warn('[hh] localStorage 不可用，本次运行的数据不会持久化');
    return memoryStorage();
  }
}

/**
 * 一次性把老版本存在 localStorage 里的数据搬到原生文件存储。
 *
 * 只在原生侧还没有这个键时才搬，避免覆盖新数据。判断前缀是 `hh`
 * —— 引擎状态（hh.state.v1）与保险箱（hh.masterkey.v1 / hh.session.*）
 * 都用这个前缀。
 */
function migrateFromLocalStorage(target: WebStorage): WebStorage {
  try {
    const ls = window.localStorage;
    let moved = 0;
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (!k || !k.startsWith('hh')) continue;
      if (target.getItem(k) !== null) continue;
      const v = ls.getItem(k);
      if (v !== null) {
        target.setItem(k, v);
        moved += 1;
      }
    }
    if (moved > 0) console.log(`[hh] 已从 localStorage 迁移 ${moved} 项到原生存储`);
  } catch {
    // 迁移失败不影响新存储的使用 —— 后续同步会重新填充数据
  }
  return target;
}

const storage = pickStorage();

// 提醒偏好的读写**只有这一份**：引擎读它、API 写它。
// 两处各碰各的存储就会出现"改了设置没生效"—— 那种最难查的静默失败。
const prefs = {
  read: () => readNotifyPrefs(storage),
  write: (raw: unknown) => writeNotifyPrefs(storage, raw),
};
const store = new PersistentStore({
  storage,
  onError: (e) => {
    console.error('[store] 落盘失败', e);
    const msg = (e as Error)?.message ?? String(e);
    // 落盘失败以前只写 console —— 用户在真机上根本看不到，
    // 于是「重启后数据变少」这种最坏的故障形态完全没有提示。
    (window as unknown as { toast?: (m: string, ms?: number) => void }).toast?.(
      `数据保存失败：${msg}。重启后最近同步的数据可能丢失。`,
      9000,
    );
  },
});
await store.init();

const vault = new WebCryptoVault({ storage });

// ---------------------------------------------------------------- 引擎

const logger = new ConsoleLogger({ level: 'info', color: false });
const reminders: PlannedReminder[] = [];

// mock 平台只在桌面开发时用；手机上不注册 —— 否则 UI 会多出一个不存在的平台
const registry = createProductionRegistry();

const engine = new SyncEngine({
  registry,
  store,
  vault,
  http: new BridgeHttpClient(),
  clock: systemClock,
  logger,
  signer: new UnavailableSigner(),
  // 提醒偏好（密度档位 / 每日汇总）在设置页改，落在同一个 storage 里。
  // 注入的是**取值函数**：每次排期都现读一次，用户改完下一次同步就生效。
  notifyPrefs: () => readNotifyPrefs(storage),
  reminderSink: {
    deliver: async (r) => {
      reminders.unshift(r);
      if (reminders.length > 50) reminders.pop();
      // 刻意**不**在这里弹系统通知：这条链路是「同步时补记窗口」，
      // 而系统通知由 scheduleReminders 的闹钟准时送达。两边都弹的话，
      // 同一个作业会在同步的瞬间和窗口时刻各响一次。
      // 这里的产物只进 App 内的提醒框（打开 App 时该看到什么）。
    },
  },
  // 通知栏那条链路：算在 JS（领域逻辑都在 core），到点叫醒靠原生闹钟。
  notificationSink: {
    schedule: async (items) => {
      const bridge = (window as unknown as { Android?: NativeNotifyBridge }).Android;
      if (!bridge?.scheduleReminders) {
        // 桌面/CLI 没有原生闹钟。算得出排期但没人接，说一声比静默强。
        logger.info('无原生通知桥，跳过截止提醒排期', { count: items.length });
        return;
      }
      bridge.scheduleReminders(
        JSON.stringify(
          items.map((i) => ({
            key: i.key,
            taskId: i.taskId,
            title: i.title,
            body: i.body,
            // 时间是**时刻**而不是墙上时间，所以直接传 epoch 毫秒给原生 ——
            // 让 Java 再解析一遍 ISO 串只是多一个出错的机会。
            fireAtMs: new Date(i.fireAt).getTime(),
            dueAtMs: new Date(i.dueAt).getTime(),
          })),
        ),
      );
    },
  },
});

// ---------------------------------------------------------------- 会话保活

/**
 * 保活探测桥。原生契约见 android/.../KeepAliveScheduler.java。
 */
interface NativeKeepAliveBridge {
  /** 下发探测配置（全量替换） */
  scheduleKeepAlive?: (json: string) => void;
  /** 开关；关掉后不再有任何后台请求 */
  setKeepAliveEnabled?: (enabled: boolean) => void;
  /** 状态 + 最近探测记录（JSON 字符串） */
  keepAliveState?: () => string;
}

/**
 * 把「探活探测」的配置下发给原生。
 *
 * 配置来自适配器的 `keepAliveProbe` 声明 —— 只有适配器知道自家最便宜的探活接口，
 * 这里只做两件事：把**有账号的平台**筛出来、把间隔取最小值（多个平台共用一个闹钟）。
 *
 * 为什么必须有"有账号"这个条件：没有账号却还在后台定时发请求，
 * 是纯粹的白耗电 —— 保活的对象是会话，没有会话就没有可保的东西。
 */
async function syncKeepAlive(): Promise<void> {
  const bridge = (window as unknown as { Android?: NativeKeepAliveBridge }).Android;
  if (!bridge?.scheduleKeepAlive) return;
  try {
    const accounts = await store.listAccounts();
    const active = new Set(accounts.filter((a) => a.enabled).map((a) => a.platformId));
    const probes: Record<string, unknown>[] = [];
    let intervalMs = 30 * 60 * 1000;
    for (const adapter of registry.list()) {
      if (!active.has(adapter.id)) continue;
      const probe = adapter.keepAliveProbe;
      if (!probe) continue;
      probes.push({
        platformId: adapter.id,
        url: probe.url,
        method: probe.method,
        body: probe.body ?? '',
        alivePattern: probe.alivePattern,
      });
      intervalMs = Math.min(intervalMs, probe.intervalMs);
    }
    bridge.scheduleKeepAlive(JSON.stringify({ intervalMs, probes }));
  } catch (e) {
    // 下发失败不影响任何主流程 —— 保活只是诊断与优化的额外手段
    logger.info('保活探测配置下发失败', { error: (e as Error).message });
  }
}

// ---------------------------------------------------------------- 离线路线

/** CDP 附着依赖本机浏览器的调试端口，手机上不存在这个概念。 */
const unsupportedAttach: HttpClient = {
  async request() {
    throw new HubError('NOT_SUPPORTED', 'CDP 附着只在电脑上可用（需要浏览器的远程调试端口）。', {
      requiresUserAction: true,
    });
  },
};

const handleApi = createApiHandler({
  notifyPrefs: prefs,
  engine,
  store,
  vault,
  registry,
  logger,
  clock: systemClock,
  reminders,
  buildTransport: async (kind, payload) => {
    if (kind === 'attach') return unsupportedAttach;
    const har = String(payload.har ?? '');
    if (!har.trim()) throw new Error('HAR 内容为空');
    const { HarReplayHttpClient } = await import('#core');
    return new HarReplayHttpClient(har);
  },
});

// ---------------------------------------------------------------- fetch 桥接

const nativeFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, window.location.href);

  // 只拦自家 API，其余（比如平台的登录页跳转）照常走浏览器
  if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);

  const body =
    typeof init?.body === 'string'
      ? init.body
      : init?.body
        ? await new Response(init.body).text()
        : '';

  const result = await handleApi({
    method: (init?.method ?? 'GET').toUpperCase(),
    pathname: url.pathname.replace(/\/+$/, '') || '/api',
    search: url.searchParams,
    body,
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

// ---------------------------------------------------------------- 暴露给原生

/**
 * 原生侧需要能主动触发动作：
 *   - 用户在 App 内 WebView 里登录完平台后，原生调用 syncNow() 立刻拉一次
 *   - Android 返回前台时刷新状态
 */
interface NativeFacing {
  ready(): boolean;
  syncNow(): Promise<unknown>;
  refresh(): Promise<unknown>;
  flush(): void;
  platformIdForLogin(): string;
}

const nativeFacing: NativeFacing = {
  ready: () => true,
  syncNow: async () => {
    const r = await handleApi({ method: 'POST', pathname: '/api/sync', search: new URLSearchParams(), body: '' });
    // 账号可能刚被添加/移除 → 探活清单跟着变（没有账号的平台不该再发后台请求）
    await syncKeepAlive();
    return r;
  },
  refresh: async () => {
    const r = await handleApi({ method: 'GET', pathname: '/api/state', search: new URLSearchParams(), body: '' });
    await syncKeepAlive();
    return r;
  },
  // App 切后台时立刻落盘，避免丢掉最后一批写入
  flush: () => store.flush(),
  // 用户还没添加任何账号时，问 UI 该打开哪个平台的登录页
  platformIdForLogin: () => 'chaoxing',
};

declare global {
  interface Window {
    /** 暴露给 Android 原生侧调用（syncNow / refresh / flush） */
    HH?: NativeFacing;
  }
}
window.HH = nativeFacing;

// 告诉前端「现在是手机端」，用于隐藏 CDP、强调「去浏览器登录」
(window as unknown as Record<string, unknown>).__HH_PLATFORM = 'android';

// ---------------------------------------------------------------- 启动前端

// 前端 app.js 是普通脚本（非模块），必须等 fetch 桥装好之后再执行。
// 用变量形式的动态 import 是为了让 tsc 不去解析这个运行时 URL。
const uiUrl = '/app.js';
await import(uiUrl);

window.Android?.log?.('info', '引擎已就绪');

// 启动时就下发一次探活配置：重装后原生侧的配置是空的，
// 而"后台探测"这件事恰恰等不到用户手动点同步（那时他已经打开了 App，探测就不需要了）。
void syncKeepAlive();
