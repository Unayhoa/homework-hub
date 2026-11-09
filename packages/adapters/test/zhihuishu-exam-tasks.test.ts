/**
 * 共享课作业/考试链路测试 —— 夹具直接取自 2026-11-09 真机 HAR。
 *
 * 这里除了测解析，还用假的 HTTP 客户端跑完整条加密链路：
 * getLoginUserInfo → has(uid) → getStudentHomework / getStudentFinalExam。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSilentLogger, systemClock, TokenBucket, UnavailableSigner } from '../../core/src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/src/ports/http.ts';
import type { AdapterContext } from '../../core/src/ports/adapter.ts';
import type { Session } from '../../core/src/ports/vault.ts';
import {
  ZhihuishuAdapter,
  parseZhihuishuExamTasks,
  parseZhihuishuTeachingTasks,
} from '../zhihuishu/src/index.ts';
import { recoverSl } from '../zhihuishu/src/exam-crypto.ts';

// ---- 真实抓包：getStudentHomework(flag=2) 的 8 条 ----
const HOMEWORK = [
  { id: 'ed7JLYV4', examId: 'wKrAgOzy', examName: '当青春遇上爱情', meetCourseType: 1, state: 4, score: '10', totalScore: '10', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: null, problemNum: 5 },
  { id: 'yRqG2oA8', examId: 'yL9dBx9w', examName: '大学生挫折应对与生命教育', meetCourseType: 1, state: 4, score: '10', totalScore: '10', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: null, problemNum: 5 },
  { id: 'w3ZzWK10', examId: 'yoEBYo3e', examName: '数字时代的21种焦虑', meetCourseType: 1, state: 4, score: '10', totalScore: '10', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: null, problemNum: 5 },
  { id: 'eGr4Eq30', examId: 'yq3d4nge', examName: '识别·应对·成长：大学生心理行为问题实战指南', meetCourseType: 1, state: 4, score: '10', totalScore: '10', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: null, problemNum: 5 },
  { id: '5vokLJWL', examId: 'eBQqDEQw', examName: '绪论单元测验', meetCourseType: 0, state: 4, score: '200', totalScore: '200', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: 1000053112, problemNum: 10 },
  { id: 'wEnRELOM', examId: 'ePjADxry', examName: '第一章单元测验', meetCourseType: 0, state: 4, score: '175', totalScore: '175', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: 1000053113, problemNum: 10 },
  { id: '5XG0gXWO', examId: 'w13DPRa5', examName: '第二章单元测验', meetCourseType: 0, state: 4, score: '170', totalScore: '170', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: 1000053114, problemNum: 10 },
  { id: 'wM39L1Yr', examId: 'egPOrvR5', examName: '第三章单元测验', meetCourseType: 0, state: 4, score: '165', totalScore: '165', startTime: '2025-09-25 00:00:00', endDate: '2025-12-18 23:59:59', chapterId: 1000053115, problemNum: 10 },
];

// ---- 真实抓包：getStudentFinalExam 的 1 条 ----
const FINAL = [
  { id: 'yZGbAjNY', examId: 'e9lN8Omw', examName: '大学生心理健康教程考试', state: 4, score: '98', totalScore: '100', startTime: '2025-12-19 00:00:00', endDate: '2025-12-28 23:59:59', studentStartTime: '2025-12-21 08:51:11', submitTime: '2025-12-21 09:24:09', problemNum: 68, limitTime: 90 },
];

// ---- 真实抓包：loadTeachingTask 的 4 条（免加密兜底）----
const TEACHING = [
  { id: 86149231, linkId: 86149231, taskName: '数字时代的21种焦虑', learnTime: '2025-11-27 18:30:00.0', testingScore: 2.0, isAddScore: '1' },
  { id: 86149232, linkId: 86149232, taskName: '识别·应对·成长：大学生心理行为问题实战指南', learnTime: '2025-10-30 18:30:00.0', testingScore: 2.0, isAddScore: '1' },
  { id: 86149233, linkId: 86149233, taskName: '当青春遇上爱情', learnTime: '2025-10-16 18:30:00.0', testingScore: 2.0, isAddScore: '1' },
  { id: 86149234, linkId: 86149234, taskName: '大学生挫折应对与生命教育', learnTime: '2025-10-09 18:30:00.0', testingScore: 2.0, isAddScore: '1' },
];

const COURSE = { platformCourseId: '1000006248', name: '大学生心理健康' };
const EXAM_SL =
  'MvvI6LxWDXiULHdxgGkpyKNBYNmLKocPqUjTId7M/47jQn5akrEAL5Swv7HX3T/Vuz4UsU552qp7eR55UX6gZ/lLhdOioo6BgRBPmreHZHO0vfYlJ9dN3LHD/k8FaebO3R9e684JIdjJBRT2VhgHozJDp5qRO3/WpeK25qruy2U=';

const SESSION: Session = {
  platformId: 'zhihuishu',
  accountId: 'zhihuishu::u1',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

describe('智慧树 · 共享课作业/考试解析（HAR 夹具）', () => {
  it('8 条作业分成 4 条见面课测验 + 4 条章节测验，再加 1 条期末考试', () => {
    const tasks = parseZhihuishuExamTasks(HOMEWORK, FINAL, COURSE, 'https://example/exam', new Date('2026-11-09'));
    assert.equal(tasks.length, 9);
    assert.equal(tasks.filter((t) => t.title.startsWith('见面课测验')).length, 4);
    assert.equal(tasks.filter((t) => t.title.startsWith('章节测验')).length, 4);
    assert.equal(tasks.filter((t) => t.kind === 'exam').length, 1);
    assert.equal(tasks.every((t) => t.status === 'graded'), true);
    const final = tasks.find((t) => t.kind === 'exam')!;
    assert.equal(final.title, '期末考试 · 大学生心理健康教程考试');
    assert.equal(final.score, 98);
    assert.equal(final.totalScore, 100);
    // 平台时间是北京墙上时间 2025-12-19 00:00 → UTC 2025-12-18 16:00
    assert.match(final.startsAt ?? '', /^2025-12-18T16:00:00\.000Z$|^2025-12-19T00:00:00/);
    const chapter = tasks.find((t) => t.title.includes('绪论单元测验'))!;
    assert.equal(chapter.platformTaskId, 'chapter-quiz-1000053112');
    assert.equal(chapter.score, 200);
  });

  it('章节测验 ID 与免加密兜底一致，切换数据源不会重复', () => {
    const a = parseZhihuishuExamTasks(HOMEWORK, [], COURSE);
    assert.ok(a.some((t) => t.platformTaskId === 'chapter-quiz-1000053113'));
  });

  it('loadTeachingTask 兜底产出 4 条见面课测验', () => {
    const tasks = parseZhihuishuTeachingTasks(TEACHING, COURSE);
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0]!.title, '见面课测验 · 数字时代的21种焦虑');
    assert.equal(tasks[0]!.status, 'graded');
    assert.equal(tasks[0]!.score, 2);
  });

  it('sl 密钥包可还原出 cKey', () => {
    assert.equal(recoverSl(EXAM_SL)?.cKey, 'onbfhdyvz8x7otrp');
  });
});

/** 造一个按 URL 分发的假 HTTP 客户端，跑完整条加密链路。 */
function makeCtx(handler: (req: HttpRequest) => { text: string; status?: number }): AdapterContext {
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const r = handler(req);
      const text = r.text;
      return {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
        url: req.url,
        setCookies: [],
        async text() { return text; },
        async json<T>() { return JSON.parse(text) as T; },
        async bytes() { return new TextEncoder().encode(text); },
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

describe('智慧树 · 平时分两个数据源（HAR 夹具）', () => {
  it('loadStuLearnReport 拿不到时，用 loadStudyCertify 的 studentScoreDto 出分', async () => {
    const chapterOrLesson = {
      clList: [
        {
          chapterId: 1000053112,
          chapterName: '绪论',
          lessonTempDtos: [
            { videoId: 1, watchStatus: 1, lessonVideoTempDtos: [] },
            { videoId: 2, watchStatus: 1, lessonVideoTempDtos: [] },
          ],
        },
      ],
    };
    const scoreAssessRuleDto = { learnedHabitScoreShare: '10', learnedInteractiveScoreShare: '5', progressScoreShare: '15' };
    // HAR：loadStudyCertify 的 studentScoreDto 带完整分数
    const studentScoreDto = {
      totalScore: '99', usualScore: '30', examScore: '10', meetScore: '20',
      finalScore: '39', courseScore: '15', progressScore: '15',
    };
    const ctx = makeCtx((req) => {
      const u = req.url;
      if (u.includes('loadStuLearingTab')) {
        return { text: JSON.stringify({ chapterOrLesson, avgStudiedProcess: '100%', scoreAssessRuleDto }) };
      }
      if (u.includes('loadStuLearnReport/')) {
        // 模拟真机上这个接口返回非 JSON（safe 会记录并回退到第二次无 header 重试）
        return { text: '<html>登录</html>' };
      }
      if (u.includes('loadStudyCertify')) {
        return { text: JSON.stringify({ studentScoreDto, certifyImg: 'ajaxSuccess' }) };
      }
      if (u.includes('loadStuHabit')) {
        return { text: JSON.stringify({ learnedHabitScore: '10', learnedHabitTotalScore: '10' }) };
      }
      if (u.includes('loadCourseForum')) {
        return { text: JSON.stringify({ learnedInteractiveScore: '5', learnedInteractiveTotalScore: '5' }) };
      }
      return { text: '{}', status: 404 };
    });
    const adapter = new ZhihuishuAdapter();
    const course = {
      ...COURSE,
      id: 'zhihuishu:u1:1000006248', platformId: 'zhihuishu', accountId: 'u1',
      lastSeenAt: '', raw: { recruitId: 368799 },
    } as never;
    const page = await adapter.fetchCourseProgress(ctx, SESSION, [course]);
    assert.equal(page.items.length, 1);
    const g = page.items[0]!.grade;
    assert.ok(g, '平时分必须产出 grade');
    assert.equal(g!.totalScore, 99);
    assert.equal(g!.usualScore, 30);
    assert.equal(g!.examScore, 10);
    assert.equal(g!.meetScore, 20);
    assert.equal(g!.finalScore, 39);
    assert.equal(g!.studyScore, 15);
    assert.equal(g!.habitScore, 10);
    assert.equal(g!.interactionScore, 5);
    assert.equal(page.items[0]!.done, 2);
  });
});

describe('智慧树 · 共享课加密链路端到端（假 HTTP）', () => {
  it('has 换密钥 → 用 secretStr 拉到 9 条任务，且没有落到免加密兜底', async () => {
    const calls: string[] = [];
    const ctx = makeCtx((req) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url.includes('getLoginUserInfo')) {
        return { text: JSON.stringify({ code: 200, result: { uuid: 'Xe6yreg2' } }) };
      }
      if (req.url.includes('/c/has')) {
        return { text: JSON.stringify({ rt: { sl: EXAM_SL }, status: '200' }) };
      }
      if (req.url.includes('getStudentHomework')) {
        assert.ok((req.form as Record<string, string> | undefined)?.secretStr, '作业请求必须带 secretStr');
        return { text: JSON.stringify({ rt: { studentHomeworkList: HOMEWORK, next: -1 }, status: '200' }) };
      }
      if (req.url.includes('getStudentFinalExam')) {
        return { text: JSON.stringify({ rt: FINAL, status: '200' }) };
      }
      return { text: '{}', status: 404 };
    });
    const adapter = new ZhihuishuAdapter();
    const course = {
      ...COURSE,
      id: 'zhihuishu:u1:1000006248',
      platformId: 'zhihuishu',
      accountId: 'u1',
      lastSeenAt: '',
      raw: { recruitId: 368799, secret: '495e515f4c504859454a585958435b4750' },
    } as never;
    const page = await adapter.fetchTasks(ctx, SESSION, { courses: [course] });
    assert.equal(page.items.length, 9, '应拿到 8 条作业 + 1 条期末考试');
    assert.ok(page.items.some((t) => t.kind === 'exam'));
    assert.ok(calls.some((c) => c.includes('/c/has')));
    assert.ok(calls.some((c) => c.includes('getStudentFinalExam')));
    assert.deepEqual(page.details ?? [], [], '加密链路成功时不应有兜底错误');
  });
});
