/**
 * 智慧树作业/考试接口的请求参数加密（2026-11-09 逆向并离线验证）。
 *
 * 链路（全部来自 HAR 实证，无一处猜测）：
 *  1. 页面生成 `uid`：RSA-1024 / PKCS#1 v1.5 type 2，加密 `{"module":3}`，
 *     公钥是平台硬编码在 base2/js/2.js 里的那把。
 *  2. GET appcomm-user .../c/has?uid=... → `rt.sl`。
 *  3. `sl` 是平台用**私钥**签发的 RSA 块（PKCS#1 v1.5 type 1，`00 01 FF.. 00`）。
 *     持有公钥的任何人都能用 c^e mod n 还原，明文是
 *     {"cKey":"...","key":"...","module":3,"ckv":1,"nkv":2,...}。
 *  4. `secretStr` = AES-128-CBC(JSON.stringify(params), key=cKey, iv='1g3qqdh4jvbskb9x')
 *     的 base64。AES 是确定性的（固定 IV），所以同一组参数永远得到同一个密文。
 *
 * 离线验证（见 exam-crypto.test.ts）：用 HAR 里的 cKey 加密
 *   {"recruitId":"368799","courseId":1000006248,"flag":2,"pageSize":100,"pageNum":0}
 * 得到的 secretStr 与抓包里的 `getStudentHomework` 请求体**逐字节一致**。
 *
 * 为什么全部手写而不用 WebCrypto：RSAES-PKCS1-v1_5 加密不在 WebCrypto 里，
 * 而 WebView 的 crypto.subtle 在个别 ROM 上缺失。纯 BigInt + 纯 JS AES 没有运行时依赖。
 */

/** 平台公钥（SPKI base64），n/e 已展开成十六进制常量，省掉 DER 解析。 */
const RSA_N_HEX =
  'a07d99a92e93c4a441512817be6635895233defbbaa0ee91aa71f3778f67a027c1f69ab2b0684a991273e7a62d8ede137c1d1c9a168cc33a9f20c198987e22198d6cb426bfc53408a22988796ead06b049fe89e326472260ffe8b5aea8b386f097bc576b7468454f0e440704e9b067707b5bad765aef2095001568fd621e2a6d';
const RSA_E = 65537n;
const RSA_K = 128; // 1024-bit 模长

/** AES-CBC 的固定 IV（从 HAR 密文与已知明文反推，且与 2.js 混淆表里的值一致）。 */
export const ZHS_AES_IV = '1g3qqdh4jvbskb9x';

const N = BigInt('0x' + RSA_N_HEX);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const hex = v.toString(16).padStart(length * 2, '0');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 取随机字节（默认用 WebCrypto，测试可注入确定性实现）。 */
export type RandomSource = (length: number) => Uint8Array;
const systemRandom: RandomSource = (length) => {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
};

export function rsaEncryptType2(
  modulusHex: string,
  exponent: bigint,
  plaintext: string,
  rand: RandomSource = systemRandom,
): string {
  const modulus = BigInt('0x' + modulusHex);
  const msg = utf8Bytes(plaintext);
  const k = Math.ceil(modulusHex.length / 2);
  const psLength = k - msg.length - 3;
  if (psLength < 8) throw new Error('RSA 明文过长');
  const ps = new Uint8Array(psLength);
  for (let i = 0; i < psLength; ) {
    const byte = rand(1)[0]!;
    if (byte !== 0) {
      ps[i] = byte;
      i += 1;
    }
  }
  const em = new Uint8Array(k);
  em[0] = 0;
  em[1] = 2;
  em.set(ps, 2);
  em[2 + psLength] = 0;
  em.set(msg, 3 + psLength);
  const c = modPow(bytesToBigInt(em), exponent, modulus);
  return toBase64(bigIntToBytes(c, k));
}

/** RSAES-PKCS1-v1_5 type 2 加密，返回 base64（即 has 接口的 uid）。 */
export function rsaEncryptUid(plaintext: string, rand: RandomSource = systemRandom): string {
  return rsaEncryptType2(RSA_N_HEX, RSA_E, plaintext, rand);
}

/** 从 has 接口返回的 sl 还原平台下发的密钥包。 */
export function recoverSl(
  slBase64: string,
): { cKey?: string; key?: string; module?: number; ckv?: number; nkv?: number; osVersion?: number } | undefined {
  try {
    const c = bytesToBigInt(fromBase64(slBase64));
    const bytes = bigIntToBytes(modPow(c, RSA_E, N), RSA_K);
    if (bytes[0] !== 0 || bytes[1] !== 1) return undefined;
    const sep = bytes.indexOf(0, 2);
    if (sep < 10) return undefined;
    const text = new TextDecoder().decode(bytes.slice(sep + 1));
    const obj = JSON.parse(text) as {
      cKey?: string;
      key?: string;
      module?: number;
      ckv?: number;
      nkv?: number;
      osVersion?: number;
    };
    return obj;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- AES-128

const SBOX = (() => {
  const box = new Uint8Array(256);
  const rotl = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ ((p & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
    q = (q ^ ((q << 1) & 0xff)) & 0xff;
    q = (q ^ ((q << 2) & 0xff)) & 0xff;
    q = (q ^ ((q << 4) & 0xff)) & 0xff;
    q = (q ^ ((q & 0x80) !== 0 ? 0x09 : 0)) & 0xff;
    const x = (q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4)) & 0xff;
    box[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  box[0] = 0x63;
  return box;
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(a: number): number {
  const hi = (a << 1) & 0xff;
  return (a & 0x80) !== 0 ? hi ^ 0x1b : hi;
}

/** 展开 16 字节密钥成 11 个 16 字节轮密钥。 */
function expandKey(key: Uint8Array): Uint8Array[] {
  const words: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    words.push([key[4 * i]!, key[4 * i + 1]!, key[4 * i + 2]!, key[4 * i + 3]!]);
  }
  for (let i = 4; i < 44; i += 1) {
    let t = [...words[i - 1]!];
    if (i % 4 === 0) {
      t = [SBOX[t[1]!]! ^ RCON[i / 4 - 1]!, SBOX[t[2]!]!, SBOX[t[3]!]!, SBOX[t[0]!]!];
    }
    const prev = words[i - 4]!;
    words.push([prev[0]! ^ t[0]!, prev[1]! ^ t[1]!, prev[2]! ^ t[2]!, prev[3]! ^ t[3]!]);
  }
  const rounds: Uint8Array[] = [];
  for (let r = 0; r < 11; r += 1) {
    const rk = new Uint8Array(16);
    for (let c = 0; c < 4; c += 1) {
      const w = words[4 * r + c]!;
      rk.set(w, 4 * c);
    }
    rounds.push(rk);
  }
  return rounds;
}

function encryptBlock(block: Uint8Array, roundKeys: Uint8Array[]): Uint8Array {
  // AES 状态是列优先：input[i] 就是 state[i%4][floor(i/4)]，即 s[i]。直接拷贝即可。
  const s = new Uint8Array(block);
  const addRoundKey = (r: number) => {
    const rk = roundKeys[r]!;
    for (let i = 0; i < 16; i += 1) s[i] = s[i]! ^ rk[i]!;
  };
  addRoundKey(0);
  for (let round = 1; round <= 10; round += 1) {
    for (let i = 0; i < 16; i += 1) s[i] = SBOX[s[i]!]!;
    // ShiftRows：第 r 行左移 r（列优先索引 = c*4+r）
    const copy = [...s];
    for (let r = 1; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) s[c * 4 + r] = copy[((c + r) % 4) * 4 + r]!;
    }
    if (round !== 10) {
      for (let c = 0; c < 4; c += 1) {
        const a0 = s[c * 4]!;
        const a1 = s[c * 4 + 1]!;
        const a2 = s[c * 4 + 2]!;
        const a3 = s[c * 4 + 3]!;
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[c * 4] = a0 ^ t ^ xtime(a0 ^ a1);
        s[c * 4 + 1] = a1 ^ t ^ xtime(a1 ^ a2);
        s[c * 4 + 2] = a2 ^ t ^ xtime(a2 ^ a3);
        s[c * 4 + 3] = a3 ^ t ^ xtime(a3 ^ a0);
      }
    }
    addRoundKey(round);
  }
  return new Uint8Array(s);
}

/** AES-128-CBC + PKCS#7，返回 base64。 */
export function aesCbcEncryptBase64(plaintext: string, key: string, iv: string): string {
  const keyBytes = utf8Bytes(key);
  const ivBytes = utf8Bytes(iv);
  if (keyBytes.length !== 16 || ivBytes.length !== 16) throw new Error('AES-128 需要 16 字节 key 与 iv');
  const roundKeys = expandKey(keyBytes);
  const data = utf8Bytes(plaintext);
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  for (let i = data.length; i < padded.length; i += 1) padded[i] = pad;

  const out = new Uint8Array(padded.length);
  let prev = ivBytes;
  for (let off = 0; off < padded.length; off += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) block[i] = padded[off + i]! ^ prev[i]!;
    const enc = encryptBlock(block, roundKeys);
    out.set(enc, off);
    prev = enc;
  }
  return toBase64(out);
}

/** 生成 secretStr：注意参数**顺序**必须和平台页面一致（AES-CBC 对顺序敏感）。 */
export function buildSecretStr(params: Record<string, unknown>, cKey: string): string {
  return aesCbcEncryptBase64(JSON.stringify(params), cKey, ZHS_AES_IV);
}
