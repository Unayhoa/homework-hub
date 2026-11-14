/**
 * 「先出待办，后台补细节」—— 只能延后细节，绝不能漏待办。
 *
 * 真机背景（2026-11-14）：超星每轮同步里最慢的一截是「考试开考时间」——
 * 它只写在详情页，一个考试一个请求，单页 300KB。把这些请求从快速通道挪到后台，
 * 用户就能先看到完整待办。
 *
 * 这组测试锁住两条边界：
 *   1. skipDetails 只跳过详情页，**作业/考试本身一条不少**；
 *   2. refreshTaskDetails 只回传 startsAt 这类展示字段，不碰状态/标题。
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

const COURSE_PAGE = `<input id="enc" value="ENC1" /><input id="workEnc" value="WRK1" /><input id="t" value="1793871359365" />`;
const WORK_LIST = `<ul class="bottomList"><li><p class="overHidden2 fl">实验01</p><p class="status fl">未交</p></li></ul>`;
const EXAM_LIST = `<ul><li><p class="overHidden2">期末考试</p><p class="status">未开始</p><span onclick="goTest('204587864',11006129,'x','2026-12-01 09:00')">考试</span></li></ul>`;
const EXAM_DETAIL = `<div>开始时间：2026-12-01 09:00 结束时间：2026-12-01 11:00</div>`;

function makeCtx(handler: (req: HttpRequest) => string): { ctx: AdapterContext; urls: string[] } {
  const urls: string[] = [];
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      urls.push(req.url);
      const text = handler(req);
      return {
        status: 200,
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

const route = (req: HttpRequest): string => {
  const u = req.url;
  if (u.includes('stucoursemiddle')) return COURSE_PAGE;
  if (u.includes('work/list')) return WORK_LIST;
  if (u.includes('examnotes')) return EXAM_DETAIL;
  if (u.includes('exam-list')) return EXAM_LIST;
  return '';
};

function coursesArg() {
  return [
    {
      id: 'chaoxing::u1:204587864',
      platformId: 'chaoxing',
      accountId: 'chaoxing::u1',
      platformCourseId: '204587864',
      name: '数据结构',
      lastSeenAt: new Date().toISOString(),
      raw: { classId: '152728914', cpi: '487116507', enc: 'b2090525' },
    },
  ] as never;
}

describe('先出待办，后台补细节', () => {
  it('skipDetails 只跳过考试详情页，作业与考试本身都在', async () => {
    const adapter = new ChaoxingAdapter();
    const { ctx, urls } = makeCtx(route);

    const page = await adapter.fetchTasks(ctx, SESSION, {
      courses: coursesArg(),
      quietCourseIds: [],
      skipDetails: true,
    } as never);

    // 一条作业 + 一条考试，一条都不能少
    assert.ok(page.items.some((t) => t.kind === 'homework'), '作业不能被跳过');
    assert.ok(page.items.some((t) => t.kind === 'exam'), '考试不能被跳过');
    // 但详情页一个都不该请求
    assert.equal(
      urls.filter((u) => u.includes('examnotes')).length,
      0,
      'skipDetails 时不应请求考试详情页',
    );
  });

  it('不跳过时（默认）仍会去取开考时间，行为不变', async () => {
    const adapter = new ChaoxingAdapter();
    const { ctx, urls } = makeCtx(route);
    const page = await adapter.fetchTasks(ctx, SESSION, {
      courses: coursesArg(),
      quietCourseIds: [],
    } as never);
    const exam = page.items.find((t) => t.kind === 'exam');
    assert.ok(exam, '考试存在');
    assert.equal(
      urls.filter((u) => u.includes('examnotes')).length,
      1,
      '默认路径应取一次开考时间',
    );
  });

  it('refreshTaskDetails 只补 startsAt，不碰状态与标题', async () => {
    const adapter = new ChaoxingAdapter();
    const { ctx, urls } = makeCtx(route);
    const tasks = [
      {
        id: 't1',
        platformId: 'chaoxing',
        accountId: 'chaoxing::u1',
        platformTaskId: '11006129',
        courseId: 'chaoxing::u1:204587864',
        courseName: '数据结构',
        kind: 'exam',
        title: '期末考试',
        status: 'pending',
        statusRaw: '未开始',
        deadline: { kind: 'absolute', at: '2026-12-01T11:00:00.000Z' },
        updatedAt: new Date().toISOString(),
      },
    ] as never;

    const patches = await adapter.refreshTaskDetails(ctx, SESSION, {
      tasks,
      courses: coursesArg(),
    });

    assert.equal(patches.length, 1);
    assert.equal(patches[0]!.platformTaskId, '11006129');
    assert.ok(patches[0]!.startsAt, '应补到开考时间');
    // 补丁里**不允许**出现状态/标题 —— 后台补写不能把待办改没了
    assert.equal('status' in patches[0]!, false);
    assert.equal('title' in patches[0]!, false);
    assert.ok(urls.some((u) => u.includes('examnotes')));
  });

  it('已经有 startsAt 的考试不再重复请求（省请求）', async () => {
    const adapter = new ChaoxingAdapter();
    const { ctx, urls } = makeCtx(route);
    const tasks = [
      {
        id: 't1',
        platformId: 'chaoxing',
        accountId: 'chaoxing::u1',
        platformTaskId: '11006129',
        courseId: 'chaoxing::u1:204587864',
        courseName: '数据结构',
        kind: 'exam',
        title: '期末考试',
        status: 'pending',
        deadline: { kind: 'absolute', at: '2026-12-01T11:00:00.000Z' },
        startsAt: '2026-12-01T09:00:00.000Z',
        updatedAt: new Date().toISOString(),
      },
    ] as never;

    const patches = await adapter.refreshTaskDetails(ctx, SESSION, {
      tasks,
      courses: coursesArg(),
    });
    assert.equal(patches.length, 0);
    assert.equal(urls.filter((u) => u.includes('examnotes')).length, 0, '已知开考时间不应再请求');
  });
});
