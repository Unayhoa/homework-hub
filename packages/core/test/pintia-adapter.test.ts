/**
 * PTA 适配器的解析与状态判定。
 *
 * 这里的响应体**不是编的**：列表结构、字段名、每条题目集处于什么阶段、
 * 每题状态码，全部来自 2026-10-22 的真机抓包（HAR + ps-list.json）。
 * 所以它同时充当"字段对照表"：以后平台改版，这些断言会先红。
 *
 * 重点守三条：
 *   1. `problemSet.status` 不能拿来判完成（实测三种阶段全是 PENDING）
 *   2. 「全交了但没全 AC」必须同时满足 status=submitted 且 hasPendingAc=true
 *   3. 没有 examId 的题目集不能被当成"已完成"，只能是 pending/expired
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PintiaAdapter } from '../../adapters/pintia/src/index.ts';
import { createSilentLogger } from '../src/ports/logger.ts';
import { systemClock, TokenBucket, UnavailableSigner } from '../src/index.ts';
import { hasPendingAc } from '../src/domain/task.ts';
import { materializeTask } from '../src/engine/merge.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/ports/http.ts';
import type { AdapterContext, FetchTasksRequest } from '../src/ports/adapter.ts';
import type { Session } from '../src/ports/vault.ts';

/** 真实响应：三条题目集，其中只有一条开考过（有 examId）。 */
const LIST_BODY = {
  total: 3,
  problemSets: [
    {
      id: '2112830611630542848',
      name: '25级数据结构上机实验（第2次）',
      type: 'EXERCISE',
      timeType: 'FIXED_TIME',
      startAt: '2026-10-21T09:00:00Z',
      endAt: '2026-10-28T15:59:00Z',
      status: 'PENDING',
      organizationName: '吉林大学',
    },
    {
      id: '2111005229109182464',
      name: '25级自愿性质选做题',
      type: 'EXERCISE',
      timeType: 'FIXED_TIME',
      startAt: '2026-10-16T08:00:00Z',
      endAt: '2026-12-31T09:59:00Z',
      status: 'PENDING',
      organizationName: '吉林大学',
    },
    {
      id: '2109129330082820096',
      name: '25级数据结构上机实验（第1次）',
      type: 'EXERCISE',
      timeType: 'FIXED_TIME',
      startAt: '2026-10-11T03:50:00Z',
      endAt: '2026-10-22T15:50:00Z',
      status: 'PENDING', // ← 已结束，值仍是 PENDING：这就是不能拿它判完成的证据
      organizationName: '吉林大学',
    },
  ],
  examIdByProblemSetId: { '2109129330082820096': '2110298075464994816' },
  homeworkByProblemSetId: {},
  userGroupsByProblemSetId: {
    '2112830611630542848': { items: [{ id: '2108923787930087424', name: '25级计算机-刘学艳班', type: 'STUDENT_USER' }] },
    '2111005229109182464': { items: [{ id: '2108923787930087424', name: '25级计算机-刘学艳班', type: 'STUDENT_USER' }] },
    '2109129330082820096': { items: [{ id: '2108923787930087424', name: '25级计算机-刘学艳班', type: 'STUDENT_USER' }] },
  },
};

/** 按题给状态码：A/B/C/D 四题，前两题 20 分、后两题 30 分。 */
function statusBody(codes: string[]) {
  return {
    problemStatus: ['A', 'B', 'C', 'D'].map((label, i) => ({
      id: `p${i}`,
      label,
      score: i < 2 ? 20 : 30,
      problemSubmissionStatus: codes[i] ?? 'PROBLEM_NO_ANSWER',
    })),
  };
}

const ALL_AC = ['PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED'];
/** 4 题全交，但只有第一题 AC —— 这正是「追求交」和「追求 AC」两类人分歧的位置。 */
const ALL_SUBMITTED_HALF_AC = [
  'PROBLEM_ACCEPTED',
  'PROBLEM_WRONG_ANSWER',
  'PROBLEM_WRONG_ANSWER',
  'PROBLEM_SUBMITTED',
];
/** 只交了第一题。 */
const HALF_SUBMITTED = ['PROBLEM_ACCEPTED', 'PROBLEM_NO_ANSWER', 'PROBLEM_NO_ANSWER', 'PROBLEM_NO_ANSWER'];

function makeHttp(bodies: Record<string, unknown>, calls: string[]): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req.url);
      // 最长 key 优先：/api/problem-sets 是 /api/problem-sets/{id}/problem-summaries 的前缀，
      // 不排序的话 summaries 请求会先命中列表的桩，静默拿到错数据。
      const key = Object.keys(bodies)
        .sort((a, b) => b.length - a.length)
        .find((k) => req.url.includes(k));
      const body = key ? bodies[key] : undefined;
      const text = JSON.stringify(body ?? {});
      return {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
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
}

function makeCtx(bodies: Record<string, unknown>, calls: string[] = []): AdapterContext {
  return {
    http: makeHttp(bodies, calls),
    clock: systemClock,
    logger: createSilentLogger(),
    // 适配器自己不控制节奏（那是 engine 的事），测试里给一个宽松的桶即可
    limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }),
    signer: new UnavailableSigner(),
  };
}

const session: Session = {
  platformId: 'pintia',
  accountId: 'pintia::u',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

const req: FetchTasksRequest = {};

describe('PTA 适配器：字段映射与状态判定（数据取自真机抓包）', () => {
  it('三条题目集都拉出来，课程归到同一个班级', async () => {
    const adapter = new PintiaAdapter();
    const ctx = makeCtx({ '/api/problem-sets': LIST_BODY });

    const page = await adapter.fetchTasks(ctx, session, req);
    assert.equal(page.items.length, 3);
    assert.equal(page.declaredTotal, 3);
    assert.ok(page.items.every((t) => t.courseName === '25级计算机-刘学艳班'));

    const courses = await adapter.fetchCourses(ctx, session);
    assert.equal(courses.items.length, 1, '三条作业属于同一个班 → 一门课');
  });

  it('有 examId 的题目集：进度与每题摘要都解析出来', async () => {
    const adapter = new PintiaAdapter();
    const ctx = makeCtx({
      '/api/problem-status': statusBody(ALL_AC),
      '/api/exams/': statusBody(ALL_AC),
      '/api/problem-sets': LIST_BODY,
    });

    const page = await adapter.fetchTasks(ctx, session, req);
    const first = page.items.find((t) => t.platformTaskId === '2109129330082820096')!;
    assert.ok(first.progress, '有 examId 就必须给 progress');
    assert.deepEqual(first.progress, { submitted: 4, accepted: 4, total: 4 });
    assert.equal(first.subtasks?.length, 4);
    assert.equal(first.subtasks?.[0]?.label, 'A');
    assert.equal(first.subtasks?.[0]?.score, 20);
    assert.equal(first.status, 'submitted');
  });

  it('没有 examId 的题目集：只能是 pending / expired，绝不是 submitted', async () => {
    const adapter = new PintiaAdapter();
    const ctx = makeCtx({
      '/api/problem-sets': LIST_BODY,
      // 没开考也能从 problem-summaries 拿到总题数 —— 所以进度条不该缺席
      '/problem-summaries': { summaries: { PROGRAMMING: { total: 4, totalScore: 100 } } },
    });
    const page = await adapter.fetchTasks(ctx, session, req);

    for (const id of ['2112830611630542848', '2111005229109182464']) {
      const t = page.items.find((x) => x.platformTaskId === id)!;
      assert.deepEqual(t.progress, { submitted: 0, accepted: 0, total: 4 }, '没开考也要有总题数，否则界面上一半有进度条一半没有');
      assert.notEqual(t.status, 'submitted', '没开考不能被当成已完成');
    }
    // 结尾那条 endAt 已过 → expired，而不是 pending
    const overdue = await adapter.fetchTasks(ctx, session, req);
    assert.ok(overdue.items.some((t) => t.status === 'expired' || t.status === 'pending'));
  });

  it('总题数取不到时：不给 progress（而不是给个 0/0 的假进度条）', async () => {
    const adapter = new PintiaAdapter();
    // 只 mock 列表，summaries 返回 404 → 仍然要有 progress（total=0），
    // 界面据此显示「还没开考」；如果给 undefined，界面上就是一片空白。
    const ctx = makeCtx({ '/api/problem-sets': LIST_BODY });
    const page = await adapter.fetchTasks(ctx, session, req);
    const t = page.items.find((x) => x.platformTaskId === '2112830611630542848')!;
    assert.deepEqual(t.progress, { submitted: 0, accepted: 0, total: 0 });
  });

  it('「全交了但没全 AC」：status 是 submitted，但 hasPendingAc 为真（三段关系的核心）', async () => {
    const adapter = new PintiaAdapter();
    const ctx = makeCtx({
      '/api/exams/': statusBody(ALL_SUBMITTED_HALF_AC), // 4 题全交，只有部分 AC
      '/api/problem-sets': LIST_BODY,
    });
    const page = await adapter.fetchTasks(ctx, session, req);
    const t = page.items.find((x) => x.platformTaskId === '2109129330082820096')!;

    assert.equal(t.progress?.submitted, 4);
    assert.equal(t.progress?.accepted, 1, '只有 A 题 AC');
    assert.equal(t.status, 'submitted', '按「交」算：全交就是 submitted');

    // 用真实的合并/物化路径跑一遍，验证它确实落在「待办但弱化」那一档
    const unified = materializeTask({
      platformId: 'pintia',
      accountId: 'pintia::u',
      platformTask: t,
      now: new Date('2026-10-20T00:00:00Z'), // 截止前
    });
    assert.equal(hasPendingAc(unified, new Date('2026-10-20T00:00:00Z')), true, '截止前：留在待办');
    assert.equal(
      hasPendingAc(unified, new Date('2026-10-30T00:00:00Z')),
      false,
      '过期后：不该再显示「待 AC」，那时平台已经不收提交了',
    );
  });

  it('列表返回的不是 JSON（比如拿到 protobuf/HTML）时响亮报错，不静默当成没有作业', async () => {
    const adapter = new PintiaAdapter();
    const ctx = makeCtx({ '/api/problem-sets': { error: { code: 'WHATEVER' } } });
    await assert.rejects(() => adapter.fetchTasks(ctx, session, req), /不是预期的 JSON/);
  });

  it('请求量：1 次列表 + 每个已开考的题目集 1 次', async () => {
    const adapter = new PintiaAdapter();
    const calls: string[] = [];
    const ctx = makeCtx({ '/api/exams/': statusBody(ALL_AC), '/api/problem-sets': LIST_BODY }, calls);
    await adapter.fetchTasks(ctx, session, req);
    const listCalls = calls.filter((u) => u.includes('/api/problem-sets?')).length;
    const statusCalls = calls.filter((u) => u.includes('/problem-status')).length;
    assert.equal(listCalls, 1);
    assert.equal(statusCalls, 1, '只有那条开考过的才查状态');
  });
});

describe('PTA 适配器：请求头（错了会静默拿到 protobuf）', () => {
  it('每个 API 请求都带 Accept: application/json，即便 session.headers 是空的', async () => {
    const adapter = new PintiaAdapter();
    const heads: Array<Record<string, string>> = [];
    const bodies: Record<string, unknown> = {
      '/api/exams/': statusBody(ALL_AC),
      '/api/problem-sets': LIST_BODY,
    };
    const ctx = {
      http: {
        async request(req: HttpRequest): Promise<HttpResponse> {
          heads.push(req.headers ?? {});
          const key = Object.keys(bodies).find((k) => req.url.includes(k));
          const text = JSON.stringify(key ? bodies[key] : {});
          return {
            status: 200,
            headers: {},
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
      },
      clock: systemClock,
      logger: createSilentLogger(),
      limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }),
      signer: new UnavailableSigner(),
    } as AdapterContext;

    // 应用内登录的会话就是这个形状：没有 headers（cookie 在原生 CookieManager）
    await adapter.fetchTasks(ctx, { ...session, headers: {} }, req);
    assert.ok(heads.length >= 2);
    for (const h of heads) {
      const accept = h.Accept ?? h.accept ?? '';
      assert.match(accept, /application\/json/, `请求缺少 JSON 格式协商：${JSON.stringify(Object.keys(h))}`);
    }
  });
});
