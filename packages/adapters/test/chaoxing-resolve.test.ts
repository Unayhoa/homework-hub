/**
 * 超星「点击时解析链接」的测试。
 *
 * 夹具全部来自用户 2026-11-05 提供的两份 HAR：
 *   - mooc-ans.chaoxing.com.har：我的课程 → 课程页 → 作业列表
 *   - mooc-ans2.chaoxing.com.har：点开某条作业后的 work/dowork 页面
 *
 * 守的是一条真机故障：「同步时存下的 enc 点的时候已失效 → 无效的参数」。
 * 因此解析必须发生在**点击那一刻**，按 课程页(workEnc/enc/t) → 作业列表(data) 现拼。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChaoxingAdapter } from '../chaoxing/src/index.ts';
import { createSilentLogger, systemClock, TokenBucket, UnavailableSigner } from '../../core/src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/src/ports/http.ts';
import type { AdapterContext } from '../../core/src/ports/adapter.ts';
import type { Session } from '../../core/src/ports/vault.ts';
import type { UnifiedCourse } from '../../core/src/domain/course.ts';

const SESSION: Session = {
  platformId: 'chaoxing',
  accountId: 'chaoxing::u1',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

const COURSE = {
  id: 'chaoxing:u1:201764055',
  platformId: 'chaoxing',
  accountId: 'chaoxing::u1',
  platformCourseId: '201764055',
  name: '高级语言程序设计',
  lastSeenAt: new Date().toISOString(),
  raw: { classId: '152266486', cpi: '487116507', enc: 'b20905258250d689fd162578ad0b4d2e' },
} as UnifiedCourse;

/** 我的课程页：这门课的链接（带新鲜 enc + t）。 */
const INTERACTION = `
<ul>
  <li><a href="https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=201764055&clazzid=152266486&cpi=487116507&enc=b20905258250d689fd162578ad0b4d2e&t=1793871359364&pageHeader=0&v=2&hideHead=0">高级语言程序设计</a></li>
</ul>`;

/** studentcourse 页：**隐藏 enc 才是课程页认的那个**（URL 上的 stuenc 不总是同值）。 */
const STUDENT_COURSE = `
<div>
  <input type="hidden" id="courseId" value="201764055"/>
  <input type="hidden" id="clazzId" value="152266486"/>
  <input type="hidden" id="enc" value="fresh-course-enc-001"/>
  <div class="fanyaChapterWhite"><div class="chapter_head"></div></div>
</div>`;

/** 课程页：作业列表需要的 workEnc / enc / t 都在隐藏域里（HAR 原文）。 */
const COURSE_PAGE = `
<div>
  <input type="hidden" id="enc" name="enc" value="b20905258250d689fd162578ad0b4d2e"/>
  <input type="hidden" id="workEnc" name="workEnc" value="a83a042efb5647d140ab5333d693ec23"/>
  <input type="hidden" id="t" name="t" value="1793871359364"/>
</div>`;

/** 作业列表：每行 data 属性就是该作业的新鲜入口（HAR 原文节选）。 */
const WORK_LIST = `
<ul>
  <li onclick="goTask(this);" data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=201764055&classId=152266486&cpi=487116507&workId=55429917&answerId=0&enc=91f7448b3971d0bb8f38d49d7783e7fb">实验04</li>
</ul>`;

function textResponse(body: string, status = 200): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'text/html' },
    url: 'x',
    setCookies: [],
    async text() {
      return body;
    },
    async json<T>() {
      return JSON.parse(body) as T;
    },
    async bytes() {
      return new TextEncoder().encode(body);
    },
  };
}

function makeCtx(routes: (url: string) => { body: string; status?: number }): AdapterContext {
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const r = routes(req.url);
      return textResponse(r.body, r.status ?? 200);
    },
  };
  return {
    http,
    clock: systemClock,
    logger: createSilentLogger(),
    limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }),
    signer: new UnavailableSigner(),
  };
}

describe('超星 · 点击时解析链接（HAR 实证链路）', () => {
  it('作业：我的课程 → 课程页 → 作业列表 → 该 workId 的 work/task 地址', async () => {
    const calls: string[] = [];
    const ctx = makeCtx((url) => {
      calls.push(url);
      if (url.includes('studentcourse')) return { body: STUDENT_COURSE };
      if (url.includes('mycourse/stu?')) return { body: COURSE_PAGE };
      if (url.includes('mooc2/work/list')) return { body: WORK_LIST };
      return { body: '', status: 404 };
    });

    const adapter = new ChaoxingAdapter();
    const url = await adapter.resolveTaskUrl(ctx, SESSION, {
      course: COURSE,
      platformTaskId: '55429917',
      kind: 'homework',
    });

    assert.equal(
      url,
      'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=201764055&classId=152266486&cpi=487116507&workId=55429917&answerId=0&enc=91f7448b3971d0bb8f38d49d7783e7fb',
    );
    // 先用 studentcourse 里的隐藏 enc 拼课程页 → 再抓作业列表；
    // 课程页一次就通过，不需要再走「我的课程」页那条更脆的兜底。
    assert.equal(calls.filter((u) => u.includes('studentcourse')).length, 1);
    assert.equal(calls.filter((u) => u.includes('mycourse/stu?')).length, 1);
    assert.equal(calls.filter((u) => u.includes('mooc2/work/list')).length, 1);
    assert.equal(calls.filter((u) => u.includes('visit/interaction')).length, 0);
    assert.match(adapter.resolveDebug().join(' | '), /course:ok-student-enc/);
  });

  it('课程页：解析失败时退回「我的课程」页，绝不返回会报错拼装链接', async () => {
    const ctx = makeCtx(() => ({ body: '', status: 500 }));
    const adapter = new ChaoxingAdapter();
    const url = await adapter.resolveCourseUrl(ctx, SESSION, COURSE);
    assert.equal(url, 'https://mooc2-ans.chaoxing.com/visit/interaction');
  });

  it('作业列表里没有这条 workId → 退回课程页', async () => {
    const ctx = makeCtx((url) => {
      if (url.includes('visit/interaction')) return { body: INTERACTION };
      if (url.includes('mycourse/stu')) return { body: COURSE_PAGE };
      if (url.includes('mooc2/work/list')) return { body: '<ul></ul>' };
      return { body: '', status: 404 };
    });
    const adapter = new ChaoxingAdapter();
    const url = await adapter.resolveTaskUrl(ctx, SESSION, {
      course: COURSE,
      platformTaskId: '99999999',
      kind: 'homework',
    });
    assert.match(url!, /mycourse\/stu\?/);
  });

  it('课程列表接口（POST courselistdata）返回 stucoursemiddle 链接 → 重定向后拿到课程页', async () => {
    const calls: string[] = [];
    const LIST_HTML = `
      <div class="course clearfix learnCourse">
        <input type="hidden" class="clazzId" name="clazzId" value="152266486"/>
        <input type="hidden" class="courseId" name="courseId" value="201764055"/>
        <a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=201764055&clazzid=152266486&cpi=487116507&ismooc2=1&v=2">高级语言程序设计</a>
      </div>`;
    const ctx = makeCtx((url) => {
      calls.push(url);
      if (url.includes('courselistdata')) return { body: LIST_HTML };
      if (url.includes('stucoursemiddle')) return { body: COURSE_PAGE };
      if (url.includes('mooc2/work/list')) return { body: WORK_LIST };
      return { body: '', status: 500 };
    });
    const adapter = new ChaoxingAdapter();
    const url = await adapter.resolveTaskUrl(ctx, SESSION, {
      course: COURSE,
      platformTaskId: '55429917',
      kind: 'homework',
    });
    assert.match(url!, /workId=55429917/);
    assert.equal(calls.filter((u) => u.includes('courselistdata')).length, 1);
    assert.equal(calls.filter((u) => u.includes('stucoursemiddle')).length, 1);
  });});
