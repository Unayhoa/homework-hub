/**
 * 智慧树适配器：只做作业待办（2026-11-07 HAR 实证）。
 *
 * 夹具字段来自 onlineweb.zhihuishu.com.har：
 *   - getLoginUserInfo → uuid
 *   - getStudentCourseList → studyCourses
 *   - homeworkUser/List → 作业状态 1/3/4/5
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ZhihuishuAdapter,
  parseZhihuishuCourses,
  parseZhihuishuHomeworks,
  mapZhihuishuStatus,
} from '../zhihuishu/src/index.ts';
import { createSilentLogger, systemClock, TokenBucket, UnavailableSigner } from '../../core/src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/src/ports/http.ts';
import type { AdapterContext } from '../../core/src/ports/adapter.ts';
import type { Session } from '../../core/src/ports/vault.ts';

const COURSES = [
  {
    courseId: 11430986,
    courseName: '～2025秋本科生舞蹈欣赏',
    courseCreator: '王宁',
    yearTerm: '2024-2025学年第1学期',
    homepage: 'https://hike-course-homepage.zhihuishu.com/home/courseDesc?courseId=11430986',
    learningProgress: '100',
  },
];

const HOMEWORK_PENDING = {
  homeworkId: 3661764,
  title: '假条提交',
  status: 1,
  paperId: 0,
  isComplete: '0',
  endTime: Date.now() + 7 * 86_400_000,
  homeworkEndDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  isEndSubmit: 0,
};
const HOMEWORK_SUBMITTED = { ...HOMEWORK_PENDING, homeworkId: 1, title: '待批阅作业', status: 3, isEndSubmit: 1 };
const HOMEWORK_GRADED = { ...HOMEWORK_PENDING, homeworkId: 2, title: '已批阅作业', status: 4, answerScore: 92 };
const HOMEWORK_EXPIRED = {
  ...HOMEWORK_PENDING,
  homeworkId: 3,
  title: '过期未交',
  status: 1,
  endTime: 1700000000000,
  homeworkEndDate: '2023-11-14T00:00:00.000+0000',
  isEndSubmit: 1,
};

const SESSION: Session = {
  platformId: 'zhihuishu',
  accountId: 'zhihuishu::u1',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

function makeCtx(handler: (url: string) => { body: string; status?: number }): AdapterContext {
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const r = handler(req.url);
      return {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
        url: req.url,
        setCookies: [],
        async text() {
          return r.body;
        },
        async json<T>() {
          return JSON.parse(r.body) as T;
        },
        async bytes() {
          return new TextEncoder().encode(r.body);
        },
      };
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

describe('智慧树 · 纯解析', () => {
  it('解析课程列表（studyCourses + archiveCourses）', () => {
    const courses = parseZhihuishuCourses(COURSES);
    assert.equal(courses.length, 1);
    assert.equal(courses[0]!.platformCourseId, '11430986');
    assert.equal(courses[0]!.name, '～2025秋本科生舞蹈欣赏');
    assert.equal(courses[0]!.teacher, '王宁');
  });

  it('status 1/2/3/4/5 映射为 pending/expired/submitted/graded', () => {
    const now = new Date('2026-11-07T12:00:00+08:00');
    assert.equal(mapZhihuishuStatus(HOMEWORK_PENDING, now), 'pending');
    assert.equal(mapZhihuishuStatus(HOMEWORK_SUBMITTED, now), 'submitted');
    assert.equal(mapZhihuishuStatus(HOMEWORK_GRADED, now), 'graded');
    assert.equal(mapZhihuishuStatus(HOMEWORK_EXPIRED, now), 'expired');
    assert.equal(mapZhihuishuStatus({ ...HOMEWORK_PENDING, status: 2 }, now), 'pending');
  });

  it('title/id/截止时间/分数都落进 PlatformTask', () => {
    const items = parseZhihuishuHomeworks([HOMEWORK_PENDING, HOMEWORK_GRADED], '11430986', '舞蹈欣赏');
    const t = items[0]!;
    assert.equal(t.platformTaskId, '3661764');
    assert.equal(t.title, '假条提交');
    assert.equal(t.kind, 'homework');
    assert.equal(t.deadline, new Date(HOMEWORK_PENDING.endTime).toISOString());
    assert.equal(items[1]!.score, 92);
  });
});

describe('智慧树 · 抓取链路（HAR 结构）', () => {
  it('uuid → 课程列表 → 每门课作业列表', async () => {
    const calls: string[] = [];
    const ctx = makeCtx((url) => {
      calls.push(url);
      if (url.includes('getLoginUserInfo')) return { body: JSON.stringify({ code: 200, result: { uuid: 'Xe6yreg2' } }) };
      if (url.includes('getStudentCourseList')) {
        return { body: JSON.stringify({ status: 200, message: 'OK', rt: { studyCourses: COURSES, archiveCourses: [] } }) };
      }
      if (url.includes('homeworkUser/List')) {
        return {
          body: JSON.stringify({ status: '200', rt: { rowCount: 3, list: [HOMEWORK_PENDING, HOMEWORK_SUBMITTED, HOMEWORK_GRADED] } }),
        };
      }
      return { body: '{}', status: 404 };
    });
    const adapter = new ZhihuishuAdapter();
    const courses = await adapter.fetchCourses(ctx, SESSION);
    assert.equal(courses.items.length, 1);
    const tasks = await adapter.fetchTasks(ctx, SESSION, { courses: courses.items.map((c) => ({ ...c, accountId: 'u1', platformId: 'zhihuishu', id: 'c1', lastSeenAt: '' } as never)) });
    assert.equal(tasks.items.length, 3);
    assert.ok(calls.some((u) => u.includes('uuid=Xe6yreg2')));
    assert.ok(calls.some((u) => u.includes('courseId=11430986')));
  });

  it('会话失效（getLoginUserInfo 非 200）→ AUTH_REQUIRED', async () => {
    const ctx = makeCtx(() => ({ body: JSON.stringify({ code: 302, result: null }) }));
    const adapter = new ZhihuishuAdapter();
    await assert.rejects(() => adapter.fetchCourses(ctx, SESSION), /会话已失效|AUTH/);
  });
});

