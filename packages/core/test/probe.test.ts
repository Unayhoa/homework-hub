/**
 * 探查器测试。
 *
 * 这里刻意用**多种互不相像的响应形状**来测同一个分析器（不是按平台测）——
 * 因为通用性正是这个模块存在的全部理由。如果它只认一种形状，
 * 那就等于把"猜"从 AI 那里搬到了自己身上。
 *
 * 最后一个用例是**闭环**：分析出来的配置必须真的能被 DeclarativeAdapter 跑起来。
 * 只测"分析输出长得对"是不够的 —— 配置的错误往往在跑起来那一刻才暴露。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSamples, buildConfig, configIsUsable, detectTimeFormat } from '../src/engine/probe.ts';
import { DeclarativeAdapter } from '../src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/index.ts';
import { materializeTask } from '../src/index.ts';

const ORIGIN = 'https://unknown.example.edu';

/** 造一条"录制到的响应"。 */
function sample(url: string, body: unknown) {
  return { url, body: JSON.stringify(body) };
}

describe('探查：能认出不同形状的作业列表', () => {
  it('经典两层：{data:{list:[...], total}}', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/api/homework/list?page=1`, {
        code: 0,
        msg: 'ok',
        data: {
          total: 42,
          list: [
            { id: 1001, name: '第一章习题', endTime: '2025-12-07 23:25', status: '未提交', courseName: '高等数学' },
            { id: 1002, name: '矩阵作业', endTime: '2025-12-08 23:25', status: '已提交', courseName: '线性代数' },
            { id: 1003, name: '行列式练习', endTime: '2025-12-09 23:25', status: '未提交', courseName: '线性代数' },
          ],
        },
      }),
    ]);
    assert.equal(r.tasks.length, 1);
    const t = r.tasks[0]!;
    assert.equal(t.listPath, '$.data.list');
    assert.equal(t.fields.title?.path, 'name');
    assert.equal(t.fields.deadline?.path, 'endTime');
    assert.equal(t.fields.deadline?.format, 'custom', '「2025-12-07 23:25」必须认出是本地时间写法');
    assert.equal(t.fields.status?.path, 'status');
    assert.equal(t.fields.course?.path, 'courseName');
    assert.equal(t.fields.id?.path, 'id');
    assert.ok(t.pagination, 'URL 里带 page= 就要识别成翻页，否则只拉到第一页');
    assert.equal(t.pagination?.param, 'page');
    assert.ok(t.confidence >= 0.8, `高信息量的列表置信度应很高，实际 ${t.confidence}`);
  });

  it('不同命名：{result:{records:[...]}} + 毫秒时间戳 + 英文键', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/v2/task/page`, {
        result: {
          records: [
            { taskId: 'a1', title: 'Assignment 1', dueAt: 1765036800000, state: 'pending', subject: 'Math' },
            { taskId: 'a2', title: 'Assignment 2', dueAt: 1765123200000, state: 'done', subject: 'Math' },
          ],
        },
      }),
    ]);
    assert.equal(r.tasks.length, 1);
    const t = r.tasks[0]!;
    assert.equal(t.listPath, '$.result.records');
    assert.equal(t.fields.deadline?.format, 'epoch_ms');
    assert.equal(t.fields.course?.path, 'subject', '英文的课程字段也要认出来');
  });

  it('顶层就是数组（没有任何包装）', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/api/todo`, [
        { homeworkId: 'h1', title: '实验报告', deadline: '2025-12-10T23:59:00+08:00' },
        { homeworkId: 'h2', title: '课程设计', deadline: '2025-12-20T23:59:00+08:00' },
      ]),
    ]);
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0]!.listPath, '$');
    assert.equal(r.tasks[0]!.fields.deadline?.format, 'iso');
  });

  it('课程列表单独一个接口 → 也能认出来，且不会被当成作业', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/api/courses`, {
        data: [
          { id: 'c1', name: '高等数学' },
          { id: 'c2', name: '线性代数' },
        ],
      }),
    ]);
    assert.equal(r.tasks.length, 0, '没有标题/时间列的 id+name 表是课程，不是作业');
    assert.equal(r.courses.length, 1);
    assert.equal(r.courses[0]!.idField, 'id');
    assert.equal(r.courses[0]!.nameField, 'name');
  });

  it('不是列表的响应 → 明确排除，并说明理由', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/api/user/info`, { data: { userId: 1, nickName: '张同学', school: '某大学' } }),
      sample(`${ORIGIN}/api/menu`, { data: [{ key: 'home', icon: 'x' }] }),
    ]);
    assert.equal(r.tasks.length, 0);
    assert.equal(r.courses.length, 0);
    assert.ok(r.rejected.length >= 1);
    assert.ok(r.needsMore.length > 0, '什么都没找到时，必须告诉用户下一步做什么，不能只是空');
  });

  it('带动态签名的接口 → 降置信度并明确告知只能走 DOM', () => {
    const r = analyzeSamples([
      sample(`${ORIGIN}/api/list?key={uuid}&dateFormate={ts}`, {
        data: [{ id: '1', title: '作业一', endTime: '2025-12-07 23:25' }],
      }),
    ]);
    const t = r.tasks[0]!;
    assert.ok(t.warnings.some((w) => w.includes('DOM')), `应提示走 DOM，实际：${t.warnings.join(' / ')}`);
    assert.ok(t.confidence <= 0.4);
  });
});

describe('探查：时间格式判定', () => {
  it('认得四种真实写法', () => {
    assert.equal(detectTimeFormat(1765036800), 'epoch_s');
    assert.equal(detectTimeFormat(1765036800000), 'epoch_ms');
    assert.equal(detectTimeFormat(1765036800), 'epoch_s');
    assert.equal(detectTimeFormat(1765036800000), 'epoch_ms');
    assert.equal(detectTimeFormat('2025-12-07T23:25:00+08:00'), 'iso');
    assert.equal(detectTimeFormat('2025-12-07 23:25'), 'custom');
    assert.equal(detectTimeFormat('待定'), undefined);
    assert.equal(detectTimeFormat(0), 'epoch_s');
  });
});

describe('探查闭环：分析出来的配置必须真的能跑', () => {
  const BODY = {
    data: {
      list: [
        { id: 1, name: '第一章习题', endTime: '2025-12-07 23:25', status: '未提交', courseName: '高等数学' },
        { id: 2, name: '矩阵作业', endTime: '2025-12-08 23:25', status: '已提交', courseName: '线性代数' },
      ],
    },
  };

  const http: HttpClient = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async request(req: HttpRequest): Promise<HttpResponse> {
      const text = JSON.stringify(BODY);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        url: req.url,
        setCookies: [],
        text: async () => text,
        json: async <T,>() => JSON.parse(text) as T,
        bytes: async () => new TextEncoder().encode(text),
      };
    },
  };

  it('analyze → buildConfig → DeclarativeAdapter 能解析出作业，且按课程分开', async () => {
    const url = `${ORIGIN}/api/homework/list`;
    const r = analyzeSamples([sample(url, BODY)]);
    const cfg = buildConfig(r.tasks[0]!, { key: 'probe', name: '探查平台', origin: ORIGIN });

    const usable = configIsUsable(cfg);
    assert.equal(usable.ok, true, `配置应可用，缺：${usable.missing.join('、')}`);

    const adapter = new DeclarativeAdapter(cfg);
    const page = await adapter.fetchTasks(
      // 只用到 ctx.http，其余端口给最小桩
      { http, clock: { now: () => new Date() }, logger: { debug() {}, info() {}, warn() {}, error() {} }, limiter: { take: async () => {} }, signer: { available: false, sign: async () => '' } } as never,
      { platformId: adapter.id, accountId: 'a', origin: 'imported', cookies: {}, headers: {}, issuedAt: new Date().toISOString() },
      {},
    );

    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]!.title, '第一章习题');
    // 课程维度：两条作业必须分属不同课程，否则课程页只有一门"假课"
    assert.notEqual(page.items[0]!.courseId, page.items[1]!.courseId);
    assert.equal(page.items[0]!.courseName, '高等数学');

    // 状态映射：平台的"已提交"必须变成终态，否则它会一直留在待办里催
    const t2 = materializeTask({
      platformId: adapter.id,
      accountId: 'a',
      platformTask: page.items[1]!,
      now: new Date(),
    });
    assert.equal(t2.status, 'submitted', '「已提交」要映射成终态');
  });
});
