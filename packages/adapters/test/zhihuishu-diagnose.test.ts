/**
 * 智慧树掉登录的根因定位（仿 iSmart 的「失效即取证」机制）。
 *
 * 智慧树是 cookie-only 多域会话，没有可续期 ticket。这里锁定 recoverSession 的归因：
 *   · 全域失效 → ticket-expired（真的需要重新登录）
 *   · 部分域可用 → mechanism（部分 cookie 掉线，不是账号被登出）
 *   · 全部通道错误 → channel（网络/DNS 没测成，不是会话问题）
 * 这三者对应的用户动作完全不同，混在一起就会误导用户。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSilentLogger, systemClock, TokenBucket, UnavailableSigner } from '../../core/src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/src/ports/http.ts';
import type { AdapterContext } from '../../core/src/ports/adapter.ts';
import type { Session } from '../../core/src/ports/vault.ts';
import { ZhihuishuAdapter } from '../zhihuishu/src/index.ts';

const SESSION: Session = {
  platformId: 'zhihuishu', accountId: 'zhihuishu::u1', origin: 'imported',
  cookies: {}, headers: {}, issuedAt: new Date().toISOString(),
};

function ctx(handler: (req: HttpRequest) => { status?: number; text: string } | 'throw'): AdapterContext {
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const r = handler(req);
      if (r === 'throw') throw new Error('Unable to resolve host "onlineservice-api.zhihuishu.com"');
      const text = r.text;
      return {
        status: r.status ?? 200, headers: { 'content-type': 'application/json' }, url: req.url, setCookies: [],
        async text() { return text; }, async json<T>() { return JSON.parse(text) as T; },
        async bytes() { return new TextEncoder().encode(text); },
      };
    },
  };
  return { http, clock: systemClock, logger: createSilentLogger(), limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }), signer: new UnavailableSigner() };
}

describe('智慧树 · 掉登录根因定位', () => {
  it('所有域都 403 未登录 → ticket-expired（需重新登录）', async () => {
    const adapter = new ZhihuishuAdapter();
    const r = await adapter.recoverSession(ctx(() => ({ text: JSON.stringify({ code: 403, message: '未登录', result: null }) }))!, SESSION);
    assert.equal(r.recovered, false);
    assert.equal(r.diagnosis, 'ticket-expired');
    assert.match(r.note ?? '', /所有域都判定未登录/);
  });

  it('部分域可用、主域失效 → mechanism（部分 cookie 掉线，不是被登出）', async () => {
    const adapter = new ZhihuishuAdapter();
    const r = await adapter.recoverSession(
      ctx((req) => {
        // 主会话域失效
        if (req.url.includes('getLoginUserInfo')) return { text: JSON.stringify({ code: 403, message: '未登录' }) };
        // 课程/作业域仍可用（回正常 JSON）
        return { text: JSON.stringify({ status: 200, rt: { list: [] }, msg: 'ok' }) };
      })!,
      SESSION,
    );
    assert.equal(r.diagnosis, 'mechanism');
    assert.match(r.note ?? '', /部分域仍可用/);
  });

  it('全部通道错误 → channel（不是会话失效，是没网）', async () => {
    const adapter = new ZhihuishuAdapter();
    const r = await adapter.recoverSession(ctx(() => 'throw')!, SESSION);
    assert.equal(r.diagnosis, 'channel');
    assert.match(r.note ?? '', /通道错误.*不是会话失效/);
  });

  it('HTTP 200 + 业务 code=403 也算 AUTH_REQUIRED（否则查不出根因）', async () => {
    const adapter = new ZhihuishuAdapter();
    await assert.rejects(
      () =>
        adapter.fetchCourses(
          ctx(() => ({ status: 200, text: JSON.stringify({ code: 403, message: '未登录', result: null }) }))!,
          SESSION,
        ),
      /AUTH|会话已失效/,
    );
  });
});
