/**
 * 浏览器端会话保险箱：WebCrypto AES-256-GCM。
 *
 * 桌面端用 node:crypto（EncryptedVault），WebView 里没有 node:crypto，
 * 但有标准 WebCrypto（crypto.subtle），AES-GCM 是它的原生能力 ——
 * 所以这里不是「降级」，而是同一套算法换了个实现。
 *
 * ── 关于密钥存放，必须说清楚 ──
 * 桌面端把主密钥存在 master.key 文件里，与密文同目录 ——
 * 它防的是「状态文件被顺手同步到网盘 / 被别的程序读走」，
 * 不是防「能读到本机文件系统的攻击者」。
 *
 * Android 端这里同样把密钥放在应用私有目录（WebView 的 localStorage），
 * 也是同一保护等级。**要真正防住拿到设备的攻击者，应该把密钥放进
 * Android Keystore（密钥不出安全硬件），这需要原生桥配合，
 * 是明确记录在案的 TODO，而不是假装已经做到了。**
 */
import type { Session, Vault } from '#core';
import type { WebStorage } from './web-storage.ts';

const KEY_SLOT = 'hh.masterkey.v1';
const SESSION_PREFIX = 'hh.session.';

/** 同步的非加密哈希，仅用于生成稳定的存储键名（不是安全边界）。 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function toBase64(bytes: Uint8Array): string {
  // 分块转换：逐字节 `s += String.fromCharCode(b)` 在数据量大时是 O(n²)
  // 的工作量（每轮都复制一遍已有字符串），session 变大后可能直接卡死/爆内存。
  // 每块 8192 字节用展开调用，远低于引擎的参数个数上限。
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 返回 ArrayBuffer 支撑的 Uint8Array。
 *
 * 为什么要显式写返回类型：TS 5.7 起 Uint8Array 是泛型（Uint8Array<ArrayBufferLike>），
 * 而 WebCrypto 的 BufferSource 要求底层是 ArrayBuffer 而不是 SharedArrayBuffer。
 * 不写清楚的话 `crypto.subtle.importKey(..., fromBase64(x), ...)` 会报类型不匹配 ——
 * 这个错误是对的，它真的可能在 SharedArrayBuffer 场景下出问题。
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export interface WebCryptoVaultOptions {
  storage: WebStorage;
  /** 兼容旧的未加密会话（理论上不该有，留个出口） */
  onError?: (e: unknown) => void;
}

interface StoredBlob {
  v: 1;
  iv: string;
  data: string;
}

export class WebCryptoVault implements Vault {
  readonly #storage: WebStorage;
  readonly #onError: (e: unknown) => void;
  #key: CryptoKey | undefined;

  constructor(opts: WebCryptoVaultOptions) {
    this.#storage = opts.storage;
    this.#onError = opts.onError ?? ((e) => console.error('[vault]', e));
  }

  get keySource(): string {
    return 'webcrypto:localStorage';
  }

  async #masterKey(): Promise<CryptoKey> {
    if (this.#key) return this.#key;

    const existing = this.#storage.getItem(KEY_SLOT);
    if (existing) {
      this.#key = await crypto.subtle.importKey('raw', fromBase64(existing), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
      return this.#key;
    }
    // 首次运行：生成 256 位主密钥
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    this.#storage.setItem(KEY_SLOT, toBase64(raw));
    this.#key = key;
    return key;
  }

  #slot(accountId: string): string {
    return `${SESSION_PREFIX}${fnv1a(accountId)}`;
  }

  async save(session: Session): Promise<void> {
    const key = await this.#masterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(session));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const blob: StoredBlob = { v: 1, iv: toBase64(iv), data: toBase64(cipher) };
    // accountId → slot 的反查表也要存，否则 list() 无法还原账号 ID。
    // 这里只存「slot → accountId」的映射，不存任何凭证。
    this.#storage.setItem(`${this.#slot(session.accountId)}.id`, session.accountId);
    this.#storage.setItem(this.#slot(session.accountId), JSON.stringify(blob));
  }

  async load(accountId: string): Promise<Session | undefined> {
    const raw = this.#storage.getItem(this.#slot(accountId));
    if (!raw) return undefined;
    try {
      const blob = JSON.parse(raw) as StoredBlob;
      const key = await this.#masterKey();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(blob.iv) },
        key,
        fromBase64(blob.data),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as Session;
    } catch (e) {
      // 主密钥被清掉（浏览器清了存储）会导致解密失败。
      // 这时**不能**静默返回 undefined 假装没登录 —— 用户会以为账号丢了。
      this.#onError(e);
      const err = new Error(
        '会话解密失败：本机加密密钥已丢失（通常是浏览器/应用数据被清理过）。' +
          '请重新登录该账号。',
      );
      err.name = 'VaultDecryptError';
      throw err;
    }
  }

  async remove(accountId: string): Promise<void> {
    this.#storage.removeItem(this.#slot(accountId));
    this.#storage.removeItem(`${this.#slot(accountId)}.id`);
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.#storage.keys()) {
      if (!k.startsWith(`${SESSION_PREFIX}`) || !k.endsWith('.id')) continue;
      const id = this.#storage.getItem(k);
      if (id) out.push(id);
    }
    return out;
  }
}
