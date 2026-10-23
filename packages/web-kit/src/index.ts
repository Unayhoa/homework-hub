/**
 * web-kit —— 让同一份核心引擎跑在浏览器/WebView 里。
 *
 * 核心库（packages/core）刻意不依赖 node:fs / node:crypto，
 * 所以只要替换三样东西就能搬进 WebView：
 *
 *   JsonFileStore     → PersistentStore（MemoryStore 快照 + localStorage）
 *   EncryptedVault    → WebCryptoVault（AES-256-GCM，算法不变）
 *   FetchHttpClient   → BridgeHttpClient（走原生网络栈绕开 CORS）
 *
 * 引擎、适配器、合并、提醒、只读守卫 —— 一行都不用改。
 */
export { localStorageAdapter, memoryStorage, nativeKvStorage } from './web-storage.ts';
export type { WebStorage, NativeKvBridge } from './web-storage.ts';
export { PersistentStore, assertImplementsHubStore } from './persistent-store.ts';
export type { PersistentStoreOptions } from './persistent-store.ts';
export { WebCryptoVault } from './webcrypto-vault.ts';
export type { WebCryptoVaultOptions } from './webcrypto-vault.ts';
export { BridgeHttpClient, hasNativeBridge, ensureBridgeCallbacks } from './bridge-http.ts';
export type { BridgeHttpOptions } from './bridge-http.ts';
