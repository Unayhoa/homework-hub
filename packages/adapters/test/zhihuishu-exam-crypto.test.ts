/**
 * 智慧树考试接口加密的离线验证。
 *
 * 夹具全部来自 2026-11-09 真机 HAR；这里证明「我们生成的 secretStr 与平台
 * 发出去的逐字节一致」，而不是靠真机碰运气。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  constants,
} from 'node:crypto';

import {
  ZHS_AES_IV,
  aesCbcEncryptBase64,
  buildSecretStr,
  recoverSl,
  rsaEncryptUid,
  rsaEncryptType2,
} from '../zhihuishu/src/exam-crypto.ts';

const CKEY = 'onbfhdyvz8x7otrp'; // 考试页 has 接口返回的 sl 解出的 cKey
const EXAM_SL =
  'MvvI6LxWDXiULHdxgGkpyKNBYNmLKocPqUjTId7M/47jQn5akrEAL5Swv7HX3T/Vuz4UsU552qp7eR55UX6gZ/lLhdOioo6BgRBPmreHZHO0vfYlJ9dN3LHD/k8FaebO3R9e684JIdjJBRT2VhgHozJDp5qRO3/WpeK25qruy2U=';

describe('智慧树 · 考试加密（HAR 逐字节验证）', () => {
  it('recoverSl 用公钥还原平台下发的密钥包', () => {
    const payload = recoverSl(EXAM_SL);
    assert.equal(payload?.cKey, CKEY);
    assert.equal(payload?.module, 3);
    assert.equal(payload?.ckv, 1);
  });

  it('AES-128-CBC 实现与 Node crypto 一致', () => {
    const pt = '{"recruitId":"368799"}';
    const mine = aesCbcEncryptBase64(pt, CKEY, ZHS_AES_IV);
    const ref = createCipheriv('aes-128-cbc', Buffer.from(CKEY), Buffer.from(ZHS_AES_IV))
      .update(Buffer.from(pt));
    const refAll = Buffer.concat([ref, createCipheriv('aes-128-cbc', Buffer.from(CKEY), Buffer.from(ZHS_AES_IV)).final()]);
    // 分开构造会错（padding 要一次 update+final），直接用单次加密比对
    const c = createCipheriv('aes-128-cbc', Buffer.from(CKEY), Buffer.from(ZHS_AES_IV));
    const expected = Buffer.concat([c.update(Buffer.from(pt)), c.final()]).toString('base64');
    assert.equal(mine, expected);
    void refAll;
    const d = createDecipheriv('aes-128-cbc', Buffer.from(CKEY), Buffer.from(ZHS_AES_IV));
    assert.equal(Buffer.concat([d.update(Buffer.from(mine, 'base64')), d.final()]).toString('utf8'), pt);
  });

  it('getStudentHomework(flag=1/2) 的 secretStr 与抓包一致', () => {
    assert.equal(
      buildSecretStr({ recruitId: '368799', courseId: 1000006248, flag: 1, pageSize: 100, pageNum: 0 }, CKEY),
      'iXrVDnR/HotjglEzfv30GGCJA+IWKcTD/3PsY7h2s/pCt2Vaa4aJKFq2RdZqhA6Ip++a4m+JlXEJ2tURlifGIVNQR9Crj9Vt52tMqXBbABlAaB7X0piH5QQrOMz6VXqb',
    );
    assert.equal(
      buildSecretStr({ recruitId: '368799', courseId: 1000006248, flag: 2, pageSize: 100, pageNum: 0 }, CKEY),
      'iXrVDnR/HotjglEzfv30GGCJA+IWKcTD/3PsY7h2s/pCt2Vaa4aJKFq2RdZqhA6I+A4aojgKnA/B8dGobgkqhHGATqPkJAIAWvuCVs+k8WDzL05fjtLcYpwiuRXp5lJg',
    );
  });

  it('getStudentFinalExam 参数顺序是 courseId 在前', () => {
    assert.equal(
      buildSecretStr({ courseId: 1000006248, recruitId: '368799', flag: 2 }, CKEY),
      'lHKvhh9x3yAYhfPyJoG9usLNHEX/wfEamkgaSBfEzJuaa1UkGCKyt/ccGLWzb2eQ4W0lBP/V8whDOOcDaeCSPw==',
    );
  });

  it('getSingleRecruit 的 secretStr 与抓包一致', () => {
    assert.equal(
      buildSecretStr({ recruitId: '368799' }, CKEY),
      'iXrVDnR/HotjglEzfv30GMjo7O1JbRBn78QO964oTr4=',
    );
  });

  it('rsaEncryptType2 是标准 PKCS#1 v1.5：用生成的私钥能解开', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicExponent: 65537,
    });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const nHex = Buffer.from(jwk.n, 'base64url').toString('hex');
    const e = BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'));
    const cipher = rsaEncryptType2(nHex, e, '{"module":3}', (len) => new Uint8Array(len).fill(0x5a));
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(cipher, 'base64'),
    ).toString('utf8');
    assert.equal(plain, '{"module":3}');
  });

  it('rsaEncryptUid 产出 1024-bit 密文，每次随机填充都不同', () => {
    const a = rsaEncryptUid('{"module":3}');
    const b = rsaEncryptUid('{"module":3}');
    assert.equal(Buffer.from(a, 'base64').length, 128);
    assert.notEqual(a, b);
  });
});
