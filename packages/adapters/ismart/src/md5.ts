/**
 * 纯 TS 的 MD5 —— iSmart 的 SSO 登录要求 `md5(md5(密码) + 盐)`，
 * 而浏览器/WebView 环境没有 node:crypto。公开算法，自实现零依赖。
 *
 * 正确性由单测保证（用 RFC 1321 与广泛已知的测试向量校验）。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Array<number>(64);
for (let i = 0; i < 64; i += 1) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
}

/** 输出为小端序 hex（MD5 标准形态）。 */
export function md5(input: string): string {
  const msg = Array.from(new TextEncoder().encode(input));
  const bitLen = msg.length * 8;

  // 填充：补 0x80，再补 0 到 ≡56 (mod 64)，末尾 8 字节小端长度
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  msg.push(bitLen & 0xff, (bitLen >>> 8) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 24) & 0xff, 0, 0, 0, 0);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < msg.length; off += 64) {
    const m = new Array<number>(16);
    for (let j = 0; j < 16; j += 1) {
      m[j] =
        (msg[off + j * 4] as number) |
        ((msg[off + j * 4 + 1] as number) << 8) |
        ((msg[off + j * 4 + 2] as number) << 16) |
        ((msg[off + j * 4 + 3] as number) << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = (f + a + (K[i] as number) + (m[g] as number)) | 0;
      a = d;
      d = c;
      c = b;
      const s = S[i] as number;
      b = (b + ((tmp << s) | (tmp >>> (32 - s)))) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const hexLE = (n: number): string => {
    let out = '';
    for (let i = 0; i < 4; i += 1) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return out;
  };
  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
