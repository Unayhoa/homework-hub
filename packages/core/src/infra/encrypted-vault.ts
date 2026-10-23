/**
 * 加密会话保险箱。
 *
 * 先说清楚这个实现的安全边界，不要自欺欺人：
 *
 * ✅ 它防的是：状态文件被同步到网盘 / 被其他程序顺手读走 / 被误发出去。
 *    —— 也就是「静态泄露」场景。
 * ❌ 它防不住：已经能在你机器上以你的身份执行代码的恶意软件。
 *    因为密钥就躺在旁边，只是放在一个独立文件里。
 *
 * 要真正对标商业产品，密钥应该来自操作系统钥匙串
 * （macOS Keychain / Windows Credential Manager / Linux libsecret），
 * 所以这里把密钥来源抽成 KeyProvider：桌面壳层接上系统钥匙串即可，
 * 存储格式完全不用改。
 *
 * 算法：AES-256-GCM。选 GCM 是因为它自带认证标签 ——
 * 文件被改一个字节就会解密失败，而不是解出一堆乱码静默污染数据。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session, Vault } from '../ports/vault.ts';
import { sha1Hex } from '../domain/ids.ts';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_SALT = 'homework-hub.vault.v1';

export interface KeyProvider {
  /** 返回 32 字节主密钥 */
  getKey(): Promise<Buffer>;
  describe(): string;
}

/** 从环境变量拿密钥（十六进制或任意口令，口令会走 scrypt 派生）。适合 CI 与高级用户。 */
export class EnvKeyProvider implements KeyProvider {
  readonly #varName: string;

  constructor(varName = 'HOMEWORK_HUB_MASTER_KEY') {
    this.#varName = varName;
  }

  async getKey(): Promise<Buffer> {
    const raw = process.env[this.#varName];
    if (!raw) throw new Error(`环境变量 ${this.#varName} 未设置`);
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    return scryptSync(raw, SCRYPT_SALT, KEY_BYTES);
  }

  describe(): string {
    return `env:${this.#varName}`;
  }
}

/**
 * 密钥文件。首次调用时生成 0600 权限的随机密钥。
 * 定位是「比明文好」，不是「比系统钥匙串好」。
 */
export class FileKeyProvider implements KeyProvider {
  readonly #path: string;

  constructor(keyPath: string) {
    this.#path = keyPath;
  }

  async getKey(): Promise<Buffer> {
    try {
      const raw = (await readFile(this.#path, 'utf8')).trim();
      const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
      if (buf.length !== KEY_BYTES) throw new Error('密钥长度不正确');
      return buf;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await mkdir(dirname(this.#path), { recursive: true });
      const key = randomBytes(KEY_BYTES);
      await writeFile(this.#path, key.toString('hex'), 'utf8');
      // Windows 上 chmod 基本无效，这里只是尽力而为
      await chmod(this.#path, 0o600).catch(() => {});
      return key;
    }
  }

  describe(): string {
    return `file:${this.#path}`;
  }
}

/** 固定密钥，仅供单元测试。生产代码不要用。 */
export class StaticKeyProvider implements KeyProvider {
  readonly #key: Buffer;
  constructor(seed = 'test-key') {
    this.#key = createHash('sha256').update(seed).digest();
  }
  async getKey(): Promise<Buffer> {
    return this.#key;
  }
  describe(): string {
    return 'static:test';
  }
}

interface Envelope {
  v: 1;
  algo: string;
  iv: string;
  tag: string;
  /** 明文 JSON 的密文 */
  data: string;
}

export interface EncryptedVaultOptions {
  directory: string;
  keyProvider: KeyProvider;
}

/**
 * 每个账号一个独立文件。
 * 为什么不是一个大文件：单个账号会话损坏不会波及全部账号，
 * 且删除账号时直接删文件，不会在密文里留下可分析的残留。
 */
export class EncryptedVault implements Vault {
  readonly #dir: string;
  readonly #keyProvider: KeyProvider;
  #key: Buffer | undefined;

  constructor(opts: EncryptedVaultOptions) {
    this.#dir = opts.directory;
    this.#keyProvider = opts.keyProvider;
  }

  get keySource(): string {
    return this.#keyProvider.describe();
  }

  async #getKey(): Promise<Buffer> {
    if (!this.#key) this.#key = await this.#keyProvider.getKey();
    return this.#key;
  }

  #fileFor(accountId: string): string {
    // 账号 ID 里可能含 `:`、`@` 等不适合做文件名的字符，哈希后使用
    return join(this.#dir, `${sha1Hex(accountId).slice(0, 24)}.session.enc`);
  }

  /** 账号 ID 也加密进内容里，所以需要单独的索引文件来支持 list() */
  #indexFile(): string {
    return join(this.#dir, 'index.json');
  }

  async load(accountId: string): Promise<Session | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#fileFor(accountId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }

    const env = JSON.parse(raw) as Envelope;
    const key = await this.#getKey();

    try {
      const decipher = createDecipheriv(ALGO, key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
      const session = JSON.parse(plain.toString('utf8')) as Session;
      // 双保险：文件被张冠李戴（比如 index 错乱）时立刻发现
      if (session.accountId !== accountId) {
        throw new Error(`会话内容与账号不匹配（期望 ${accountId}，实际 ${session.accountId}）`);
      }
      return session;
    } catch (e) {
      throw new Error(
        `会话解密失败，可能主密钥已更换或文件被破坏。请重新登录该账号。原始错误：${(e as Error).message}`,
      );
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const key = await this.#getKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const plain = Buffer.from(JSON.stringify(session), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);

    const env: Envelope = {
      v: 1,
      algo: ALGO,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
    };

    const file = this.#fileFor(session.accountId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(env), 'utf8');
    await chmod(tmp, 0o600).catch(() => {});
    // 原子替换：避免写到一半断电导致会话不可读，进而逼用户重新登录
    await rename(tmp, file);

    await this.#updateIndex(session.accountId, true);
  }

  async remove(accountId: string): Promise<void> {
    await unlink(this.#fileFor(accountId)).catch(() => {});
    await this.#updateIndex(accountId, false);
  }

  async list(): Promise<string[]> {
    try {
      const raw = await readFile(this.#indexFile(), 'utf8');
      const parsed = JSON.parse(raw) as { accounts?: string[] };
      return parsed.accounts ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async #updateIndex(accountId: string, add: boolean): Promise<void> {
    const current = new Set(await this.list());
    if (add) current.add(accountId);
    else current.delete(accountId);
    const tmp = `${this.#indexFile()}.tmp`;
    await writeFile(tmp, JSON.stringify({ accounts: [...current] }, null, 2), 'utf8');
    await rename(tmp, this.#indexFile());
  }

  /** 诊断用：确认密文确实是密文（不含明文账号名）。 */
  async debugInspect(accountId: string): Promise<{ exists: boolean; bytes: number; leaksPlaintext: boolean }> {
    try {
      const raw = await readFile(this.#fileFor(accountId), 'utf8');
      const env = JSON.parse(raw) as Envelope;
      return {
        exists: true,
        bytes: raw.length,
        leaksPlaintext: Buffer.from(env.data, 'base64').includes(Buffer.from(accountId, 'utf8')),
      };
    } catch {
      return { exists: false, bytes: 0, leaksPlaintext: false };
    }
  }

  /** 校验两个 key 是否一致，供测试断言「换密钥后解密失败」。 */
  static sameKey(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** 列出目录里所有 .session.enc，用于「保险箱里有孤儿文件」的自检。 */
export async function listVaultFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((f) => f.endsWith('.session.enc'));
}
