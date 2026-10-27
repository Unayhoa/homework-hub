/**
 * 诊断样本包。
 *
 * 这个文件的断言全部对应"能不能安全地把真机现场存下来、以后还能重放"：
 *   · 存下来的东西里**不能有作业正文**，也不能有身份信息（学号/手机号/昵称）；
 *   · 但**必须保留**时间格式与多行数据 —— 否则重放时判定不出截止时间格式、
 *     也算不出"这一列取值是否重复"，样本就失去意义；
 *   · 读回来的样本必须能重新跑出同样的识别结果（写入/读取是一对，不能各改一边）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSamples } from '../src/engine/probe.ts';
import { buildSamplePack, samplesFromPack, appendPackHistory } from '../src/engine/sample-pack.ts';
import type { ProbeSample } from '../src/engine/probe.ts';

const ORIGIN = 'https://wenda.zhihuishu.example';
const NOW = new Date('2026-10-27T10:00:00.000Z');

const HOMEWORK: ProbeSample = {
  url: `${ORIGIN}/api/homework/list?courseId=11430986&token=SECRET123`,
  method: 'GET',
  status: 200,
  body: JSON.stringify({
    rt: {
      dataList: [
        { recruitId: 1, recruitName: '第一章 同余方程（机密标题）', endTime: '2025-12-07 23:25', courseId: 11430986 },
        { recruitId: 2, recruitName: '第二章 二次剩余', endTime: '2025-12-14 23:25', courseId: 11430986 },
        { recruitId: 3, recruitName: '第三章 原根', endTime: '2025-12-21 23:25', courseId: 11430986 },
      ],
    },
  }),
};

const USER_INFO: ProbeSample = {
  url: `${ORIGIN}/api/user/info`,
  body: JSON.stringify({ data: { nickName: '张三', school: '某大学' } }),
};

const PROFILE_WITH_PHONE: ProbeSample = {
  url: `${ORIGIN}/api/mine/detail`,
  body: JSON.stringify({ data: { userId: 9, phone: '13800000000', name: '张三' } }),
};

const NOISE: ProbeSample = { url: `${ORIGIN}/api/ping`, body: 'ok' };

function pack(samples: ProbeSample[], extra: Partial<Parameters<typeof buildSamplePack>[0]> = {}) {
  return buildSamplePack({
    samples,
    context: { pageUrl: `${ORIGIN}/stu/courseInfo/homeworkExam/?courseId=11430986`, pageTitle: '舞蹈欣赏 - 智慧树' },
    now: NOW,
    ...extra,
  });
}

describe('样本包：存下来的东西必须能安全回传', () => {
  it('不含作业标题正文，但保留字段名与时间样例', () => {
    const p = pack([HOMEWORK]);
    const text = JSON.stringify(p);
    assert.ok(!text.includes('同余方程'), '作业标题泄漏进样本包');
    assert.ok(text.includes('recruitName'), '字段名必须留着，否则重放时不知道列叫什么');
    assert.ok(text.includes('2025-12-07'), '时间样例必须保留，否则判定不出日期格式');
    // 占位符带序号：同值同号、异值异号。序号保住"这一列有几种不同取值"，
    // 否则重放时所有列看起来都只有 1 种取值，标题列会直接认不出来。
    assert.ok(/<s\d+ len=\d+>/.test(text), '普通字符串应被替换成带基数的占位符');
  });

  it('URL 里的 token 被脱敏', () => {
    const p = pack([HOMEWORK]);
    assert.ok(!JSON.stringify(p).includes('SECRET123'), 'token 泄漏');
    assert.ok(p.requests[0]!.url.includes('/api/homework/list'), '接口地址本身要留着');
  });

  it('身份类响应整条剔除，并说明原因', () => {
    const p = pack([USER_INFO, PROFILE_WITH_PHONE, HOMEWORK]);
    assert.equal(p.requests.length, 1, '身份类响应不该进包');
    assert.equal(p.requests[0]!.url.includes('/api/homework/list'), true);
    const reasons = p.dropped.map((d) => d.reason);
    assert.ok(reasons.some((r) => r.includes('身份类接口')), 'URL 命中身份类要留痕');
    assert.ok(reasons.some((r) => r.includes('身份类字段')), '字段命中身份类要留痕');
    // 剔除必须留痕：静默丢掉会让人以为"当时就没有这些请求"
    assert.ok(p.dropped.length >= 2);
  });

  it('非 JSON 响应不进包', () => {
    const p = pack([NOISE, HOMEWORK]);
    assert.equal(p.requests.length, 1);
    assert.ok(p.dropped.some((d) => d.reason.includes('不是 JSON')));
  });

  it('保留多行（否则算不出列的重复度，课程名与标题就分不开）', () => {
    const p = pack([HOMEWORK]);
    const rows = (JSON.parse(p.requests[0]!.body) as { rt: { dataList: unknown[] } }).rt.dataList;
    assert.ok(rows.length >= 3, `至少要保留 3 行，实际 ${rows.length} 行`);
  });
});

describe('样本包：写进去和读出来必须是一对', () => {
  it('重放后能认出同样的作业接口与字段', () => {
    const p = pack([HOMEWORK]);
    const r = analyzeSamples(samplesFromPack(p), {
      pageUrl: p.context.pageUrl,
      pageTitle: p.context.pageTitle,
    });
    assert.ok(r.tasks.length >= 1, '重放后应该仍能认出作业列表');
    const t = r.tasks[0]!;
    assert.equal(t.fields.title?.path, 'recruitName');
    assert.equal(t.fields.deadline?.path, 'endTime');
    assert.equal(t.fields.deadline?.format, 'custom', '日期格式必须在脱敏后仍能判出来');
    // 课内锚点信息也要跟着重建 —— 它来自 context 的地址
    assert.equal(r.singleCourse?.platformCourseId, '11430986');
  });

  it('result 只记结构事实（条数/课程名），不含条目内容', () => {
    const p = pack([HOMEWORK], { result: { taskCount: 3, courseCount: 1, courseName: '舞蹈欣赏' } });
    assert.equal(p.result?.taskCount, 3);
    assert.equal(p.result?.courseName, '舞蹈欣赏');
  });
});

describe('样本包：存档策略', () => {
  it('同一平台只留最近 3 份，避免手机端无限增长', () => {
    let hist = undefined as ReturnType<typeof appendPackHistory> | undefined;
    for (let i = 0; i < 5; i += 1) {
      const p = pack([HOMEWORK], { now: new Date(NOW.getTime() + i * 1000) });
      hist = appendPackHistory(hist ? JSON.stringify(hist) : undefined, p);
    }
    assert.equal(hist!.length, 3);
    assert.equal(hist![2]!.capturedAt, new Date(NOW.getTime() + 4000).toISOString(), '最新的那份要在最后');
  });

  it('历史数据损坏时重新开始，而不是抛错', () => {
    const p = pack([HOMEWORK]);
    const hist = appendPackHistory('{不是 JSON', p);
    assert.equal(hist.length, 1);
  });
});
