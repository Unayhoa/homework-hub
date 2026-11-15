/**
 * 超星跨轮签名缓存的安全阀。
 *
 * 背景（2026-11-10 真机反馈"重登功能后同步变慢"）：
 * 作业/考试列表需要课程页签发的 enc/workEnc，每门课每轮都要多一次课程页请求。
 * 为了提速加了跨轮缓存 —— 但缓存签名有真实风险：
 * 一旦缓存里是一份**已失效**的 enc，每轮都会失败，而下一轮又命中同一份坏缓存，
 * 形成"永远失败"的死循环（比慢更糟）。
 *
 * 所以必须验证两件事：
 *   1. 命中缓存时确实不再发课程页请求（真的省了）；
 * 2. 列表页判定失败时缓存被作废（下一轮会重取，不会卡死）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChaoxingAdapter } from '../chaoxing/src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/src/ports/http.ts';
import type { AdapterContext } from '../../core/src/ports/adapter.ts';
import type { Session } from '../../core/src/ports/vault.ts';
import { createSilentLogger, systemClock, TokenBucket, UnavailableSigner } from '../../core/src/index.ts';

const SESSION: Session = {
  platformId: 'chaoxing',
  accountId: 'chaoxing::u1',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

function makeCtx(handler: (req: HttpRequest) => { status?: number; text: string }): {
  ctx: AdapterContext;
  urls: string[];
} {
  const urls: string[] = [];
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      urls.push(req.url);
      const r = handler(req);
      const text = r.text;
      return {
        status: r.status ?? 200,
        headers: { 'content-type': 'text/html' },
        url: req.url,
        setCookies: [],
        async text() {
          return text;
        },
        async json<T>() {
          return JSON.parse(text) as T;
        },
        async bytes() {
          return new TextEncoder().encode(text);
        },
      };
    },
  };
  return {
    ctx: {
      http,
      clock: systemClock,
      logger: createSilentLogger(),
      limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }),
      signer: new UnavailableSigner(),
    },
    urls,
  };
}

const COURSE_PAGE = `<input id="enc" value="ENC123" /><input id="workEnc" value="WORK456" /><input id="t" value="1793871359365" />`;
// 结构照抄 HAR 里的真实行：<li onclick="goTask(this)" data="..."><p class="overHidden2 fl">标题</p><p class="status fl">未交</p>
const LIST_OK = `<ul class="bottomList">${Array.from(
  { length: 3 },
  (_, i) =>
    `<li onclick="goTask(this);" data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=5543021${i}">` +
    `<p class="overHidden2 fl">实验0${i} 数组及其在程序设计中的应用（2026级）</p>` +
    `<p class="status fl">未交</p></li>`,
).join('')}</ul>${'x'.repeat(20000)}`;
const LIST_BAD = `<html><body>提示 无效的用户！</body></html>`;

function courseRaw() {
  return [
    {
      id: 'c1',
      platformId: 'chaoxing',
      accountId: 'chaoxing::u1',
      platformCourseId: '204587864',
      name: '数据结构',
      lastSeenAt: new Date().toISOString(),
      raw: { classId: '152728914', cpi: '487116507', enc: 'b2090525' },
    },
  ] as never;
}

describe('超星跨轮签名缓存', () => {
  it('第二轮复用签名，不再请求课程页（真的省了请求）', async () => {
    const adapter = new ChaoxingAdapter();
    const { ctx, urls } = makeCtx((req) => {
      if (req.url.includes('stucoursemiddle')) return { text: COURSE_PAGE };
      return { text: LIST_OK };
    });

    const req = { courses: courseRaw(), quietCourseIds: [] } as never;
    await adapter.fetchTasks(ctx, SESSION, req);
    const coursePageHits1 = urls.filter((u) => u.includes('stucoursemiddle')).length;
    assert.ok(coursePageHits1 > 0, '第一轮必须去取签名');

    urls.length = 0;
    await adapter.fetchTasks(ctx, SESSION, req);
    const coursePageHits2 = urls.filter((u) => u.includes('stucoursemiddle')).length;
    assert.equal(coursePageHits2, 0, '第二轮应复用跨轮缓存，不再请求课程页');
  });

  it('列表页判定失败 → 该课签名缓存被作废（不死循环）', async () => {
    const adapter = new ChaoxingAdapter();
    const req = { courses: courseRaw(), quietCourseIds: [] } as never;

    // 第一轮：**所有**列表请求（主路径 + 回退路径）都是拒绝页。
    // 注意必须两条都拒：只拒主路径时，回退路径会重新取一份**有效**签名并写回缓存，
    // 那属于正确行为，测不出"坏缓存是否被作废"（真机排查时踩过这个坑）。
    const { ctx } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) return { text: COURSE_PAGE };
      return { text: LIST_BAD };
    });
    await adapter.fetchTasks(ctx, SESSION, req).catch(() => undefined);

    // 第二轮：换成新 ctx + 正常列表页。若坏签名没被作废，这一轮会直接复用缓存、
    // **不发课程页请求**（那就是死循环）。
    const { ctx: ctx2, urls: urls2 } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) return { text: COURSE_PAGE };
      return { text: LIST_OK };
    });
    await adapter.fetchTasks(ctx2, SESSION, req).catch(() => undefined);
    assert.ok(
      urls2.filter((u) => u.includes('stucoursemiddle')).length > 0,
      '上一轮列表请求都被拒后，这一轮必须重新取签名（不能复用坏缓存）',
    );
  });

  it('复用旧签名失败时，会当场重取一次并重试（延长 TTL 的安全阀）', async () => {
    const adapter = new ChaoxingAdapter();
    const req = { courses: courseRaw(), quietCourseIds: [] } as never;

    // 第一轮：课程页给 ENC1/WORK1，列表正常 → 写入跨轮缓存
    const p1 = `<input id="enc" value="ENC1"/><input id="workEnc" value="WORK1"/><input id="t" value="1"/>`;
    const { ctx: ctx1 } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) return { text: p1 };
      return { text: LIST_OK };
    });
    await adapter.fetchTasks(ctx1, SESSION, req);

    // 第二轮：平台换了签名（ENC2/WORK2）。旧缓存 WORK1 会被列表页拒绝 ——
    // 只有带 enc=WORK2 才返回真列表；模拟"签名过期"。
    const p2 = `<input id="enc" value="ENC2"/><input id="workEnc" value="WORK2"/><input id="t" value="2"/>`;
    let coursePageCalls = 0;
    const { ctx: ctx2 } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) {
        coursePageCalls += 1;
        return { text: coursePageCalls === 1 ? p2 : p2 };
      }
      if (r.url.includes('work/list')) {
        return { text: /[?&]enc=WORK2(&|$)/.test(r.url) ? LIST_OK : LIST_BAD };
      }
      return { text: LIST_OK };
    });

    const page = await adapter.fetchTasks(ctx2, SESSION, req).catch(() => undefined);
    // 关键：不能因为旧签名失败就整门课丢掉 —— 必须重取签名后拿到真列表
    assert.ok(page, '必须重试成功，而不是抛「全部 0 条」');
    assert.ok(
      (page as { items: unknown[] }).items.some((t) => (t as { kind: string }).kind === 'homework'),
      '重取签名后应解析出作业',
    );
    assert.ok(coursePageCalls >= 1, '应当重新请求课程页取新签名（第二轮原本命中缓存、一次都不请求）');
  });

  it('签名缓存可导出/导入（跨 App 重启复用）', async () => {
    const a1 = new ChaoxingAdapter();
    const { ctx } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) return { text: COURSE_PAGE };
      return { text: LIST_OK };
    });
    await a1.fetchTasks(ctx, SESSION, { courses: courseRaw(), quietCourseIds: [] } as never);

    const blob = a1.exportSigCache();
    assert.ok(blob && blob.includes('204587864'), '应导出这门课的签名');

    // 模拟 App 重启：新实例 + 导入
    const a2 = new ChaoxingAdapter();
    a2.importSigCache(blob);
    const { ctx: ctx2, urls: urls2 } = makeCtx((r) => {
      if (r.url.includes('stucoursemiddle')) return { text: COURSE_PAGE };
      return { text: LIST_OK };
    });
    await a2.fetchTasks(ctx2, SESSION, { courses: courseRaw(), quietCourseIds: [] } as never);
    assert.equal(
      urls2.filter((u) => u.includes('stucoursemiddle')).length,
      0,
      '导入缓存后应直接复用，不再请求课程页',
    );
  });
});

