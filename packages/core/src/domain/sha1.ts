/**
 * 纯 JavaScript SHA-1。
 *
 * 为什么不用 node:crypto：本项目要跑在 Android WebView 里，那里没有 node:crypto。
 * 而指纹计算（makeFingerprint）是同步调用的核心路径，改成 WebCrypto 的异步
 * 会把整个 materialize → merge 链路染成 async。
 *
 * 为什么自己实现而不是换个非加密哈希：SHA-1 是标准算法，
 * 自己实现出来的输出与 node:crypto 的 `createHash('sha1')` **逐字节一致** ——
 * 意味着换实现不会让已有数据的指纹发生变化，不需要任何迁移。
 * （单测里有一条专门对比两者输出。）
 *
 * 注意：指纹不是安全边界，只是「稳定唯一」。这里用 SHA-1 是历史选择，
 * 不涉及任何密码学安全性假设。
 */

const K0 = 0x5a827999;
const K1 = 0x6ed9eba1;
const K2 = 0x8f1bbcdc;
const K3 = 0xca62c1d6;

/** 手工 UTF-8 编码（不依赖 TextEncoder，保证在老 WebView 里也能用）。 */
function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      // 代理对 → 合并成码点再编码
      const next = input.charCodeAt(i + 1);
      i += 1;
      const cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** 返回小写十六进制的 SHA-1 摘要，与 node:crypto 的 `digest('hex')` 一致。 */
export function sha1Hex(input: string): string {
  const msg = utf8Bytes(input);
  const bitLen = msg.length * 8;

  // 补位：0x80，补零到 56 mod 64，末尾 8 字节大端长度
  const totalLen = Math.ceil((msg.length + 1 + 8) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(msg);
  buf[msg.length] = 0x80;

  const view = new DataView(buf.buffer);
  // 长度可能超过 32 位（虽然实际上不会），高 32 位用除法算，避免位运算溢出
  view.setUint32(totalLen - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(totalLen - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i += 1) {
      const n = (w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) | 0;
      w[i] = (n << 1) | (n >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = K0;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = K1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = K2;
      } else {
        f = b ^ c ^ d;
        k = K3;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
