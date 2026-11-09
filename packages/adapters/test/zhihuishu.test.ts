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
  parseZhihuishuSharedCourses,
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

  it('解析共享课（心理健康在“已完成”栏，带 recruitId/secret）', () => {
    const shared = parseZhihuishuSharedCourses([
      {
        courseId: 1000006248,
        courseName: '大学生心理健康',
        teacherName: '杨振斌',
        progress: '100.0%',
        recruitId: 368799,
        secret: '495e515f4c504859454a585958435b4750',
        courseStatus: 2,
      },
    ]);
    assert.equal(shared.length, 1);
    assert.equal(shared[0]!.platformCourseId, '1000006248');
    assert.equal(shared[0]!.name, '大学生心理健康');
    assert.equal((shared[0]!.raw as { recruitId: number }).recruitId, 368799);
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

  it('平台明确说「未登录」→ AUTH_REQUIRED', async () => {
    const ctx = makeCtx(() => ({ body: JSON.stringify({ code: 403, message: '未登录', result: null }) }));
    const adapter = new ZhihuishuAdapter();
    await assert.rejects(() => adapter.fetchCourses(ctx, SESSION), /会话已失效|AUTH/);
  });

  it('非登录类异常（平台 302 空 result）→ UPSTREAM，不误报登录失效', async () => {
    const ctx = makeCtx(() => ({ body: JSON.stringify({ code: 302, result: null }) }));
    const adapter = new ZhihuishuAdapter();
    await assert.rejects(() => adapter.fetchCourses(ctx, SESSION), /接口异常|UPSTREAM/);
  });

  it('保活探测指向登录用户信息接口，且间隔不短于 15 分钟', () => {
    const p = new ZhihuishuAdapter().keepAliveProbe;
    assert.match(p.url, /getLoginUserInfo/);
    assert.equal(p.method, 'GET');
    assert.ok(p.intervalMs >= 15 * 60 * 1000);
    assert.equal(new RegExp(p.alivePattern).test('{"code":200,"result":{"uuid":"x"}}'), true);
    assert.equal(new RegExp(p.alivePattern).test('<html>login</html>'), false);
    // 必须排除「未登录」错误 JSON：里面没有 uuid 值
    assert.equal(new RegExp(p.alivePattern).test('{\"result\":null,\"code\":403,\"message\":\"未登录\"}'), false);
    // 必须带 time 参数，否则平台会误回未登录
    assert.match(p.url, /time=/);
  });

  it('共享课列表与学习进度（免加密接口）能算出视频任务点', async () => {
    const ctx = makeCtx((url) => {
      if (url.includes('getLoginUserInfo')) return { body: JSON.stringify({ code: 200, result: { uuid: 'u' } }) };
      if (url.includes('getStudentCourseList')) {
        return { body: JSON.stringify({ status: 200, rt: { studyCourses: [], archiveCourses: [] } }) };
      }
      if (url.includes('queryShareCourseInfo')) {
        return {
          body: JSON.stringify({
            result: {
              courseOpenDtos: [
                {
                  courseId: 1000006248,
                  courseName: '大学生心理健康',
                  teacherName: '杨振斌',
                  recruitId: 368799,
                  secret: '495e515f4c504859454a585958435b4750',
                  courseStatus: 2,
                },
              ],
            },
          }),
        };
      }
      if (url.includes('loadStuLearingTab')) {
        return {
          body: JSON.stringify({
            chapterOrLesson: {
              clList: [
                {
                  lessonTempDtos: [
                    { videoId: 1, watchStatus: 1, lessonVideoTempDtos: [] },
                    { videoId: 2, watchStatus: 0, lessonVideoTempDtos: [] },
                  ],
                },
              ],
            },
          }),
        };
      }
      return { body: '{}', status: 404 };
    });
    const adapter = new ZhihuishuAdapter();
    const courses = await adapter.fetchCourses(ctx, SESSION);
    assert.equal(courses.items.length, 1, '共享课要合并进课程列表');
    const course = courses.items[0]!;
    assert.equal(course.platformCourseId, '1000006248');
    const progress = await adapter.fetchCourseProgress(ctx, SESSION, [
      { ...course, id: 'c1', accountId: 'u1', platformId: 'zhihuishu', lastSeenAt: '' } as never,
    ]);
    assert.deepEqual(progress.items[0], {
      platformCourseId: '1000006248',
      total: 2,
      done: 1,
      hasOpenNow: true,
      availableNow: 1,
    });
  });
});



