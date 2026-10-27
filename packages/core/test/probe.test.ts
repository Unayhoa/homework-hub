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

import {
  analyzeSamples,
  buildConfig,
  configIsUsable,
  detectTimeFormat,
  courseNameFromTitle,
  looksLikeCourseName,
} from '../src/engine/probe.ts';
import { DeclarativeAdapter } from '../src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/index.ts';
import { materializeTask } from '../src/index.ts';
import { mapStatus } from '../src/engine/declarative-adapter.ts';

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

describe('课内录制：课程有且只有一门（真机 2026-10-27 的故障）', () => {
  // 现场还原：用户在「舞蹈欣赏」的作业列表页点了回应用。
  // 页面上那些带 id + name 的列表是**这门课的内容**（资料名、文件名），
  // 结构上和课程目录一模一样 —— 按结构判就会把一门课拆成 4 门。
  const PAGE_URL = 'https://wenda.zhihuishu.com/stu/courseInfo/homeworkExam/?courseId=11430986';
  const PAGE_TITLE = '舞蹈欣赏 - 智慧树';

  const MATERIALS = {
    data: [
      { id: 11430986, name: '11430986' },
      { id: 2001, name: '芭蕾舞' },
      { id: 2002, name: '大型歌舞剧《孔子》.mp4' },
      { id: 2003, name: '古代舞蹈' },
    ],
  };
  const HOMEWORK = {
    rt: {
      dataList: [
        { recruitId: 1, recruitName: '第一次作业', endTime: '2025-12-07 23:25', courseId: 11430986 },
        { recruitId: 2, recruitName: '第二次作业', endTime: '2025-12-14 23:25', courseId: 11430986 },
      ],
    },
  };

  it('地址里的 courseId 让"课程=这一门"成为确定的事实，而不是猜', () => {
    const r = analyzeSamples(
      [
        sample(`${PAGE_URL}`, MATERIALS),
        sample('https://wenda.zhihuishu.com/api/homework/list?courseId=11430986', HOMEWORK),
      ],
      { pageUrl: PAGE_URL, pageTitle: PAGE_TITLE },
    );
    assert.ok(r.singleCourse, '必须识别出"这份配置就是这一门课"');
    assert.equal(r.singleCourse?.platformCourseId, '11430986');
    assert.equal(r.singleCourse?.name, '舞蹈欣赏', '课程名从页面标题取，不该是 11430986');
    assert.equal(r.courses.length, 0, '课内页面上的列表是课程内容，不能当成课程目录');
    assert.ok(r.tasks.length >= 1, '作业列表仍要能认出来');
  });

  it('生成的配置是锚点式的：带 defaultCourseId，且**不带**按行切课程的字段', () => {
    const r = analyzeSamples([sample(PAGE_URL, HOMEWORK)], { pageUrl: PAGE_URL, pageTitle: PAGE_TITLE });
    const cfg = buildConfig(r.tasks[0]!, {
      key: 'zhihuishu',
      name: '智慧树',
      origin: 'https://wenda.zhihuishu.com',
      ...(r.singleCourse ? { singleCourse: r.singleCourse } : {}),
    });
    assert.equal(cfg.defaultCourseId, '11430986');
    assert.equal(cfg.courseName, '舞蹈欣赏');
    assert.equal(cfg.fields.course, undefined, '锚点模式下不能按任务行切课程，那会切出"芭蕾舞"这种假课');
    assert.equal(cfg.courses, undefined);
  });

  it('没有地址线索时，也要挡住「纯 ID」和「文件名」当课程名', () => {
    // 没有 courseId 可锚（例如用户是在课程列表页录的），次要防线：
    // 课程名必须是"像名字"的取值，否则退回兜底课程（1 门）而不是 4 门。
    const r = analyzeSamples([sample('https://x.example.edu/api/material/list', MATERIALS)], {
      pageUrl: 'https://x.example.edu/api/material/list',
      pageTitle: '某平台',
    });
    assert.equal(r.courses.length, 0, '`11430986` 与 `xxx.mp4` 都不像课程名，不能当课程目录');
  });
});

describe('课程名与前缀清理', () => {
  it('从页面标题里剥掉站点后缀', () => {
    assert.equal(courseNameFromTitle('舞蹈欣赏 - 智慧树'), '舞蹈欣赏');
    assert.equal(courseNameFromTitle('舞蹈欣赏 | 在线学堂'), '舞蹈欣赏');
    // 站点标语不能当课程名 —— 那比没有名字更让人困惑
    assert.equal(courseNameFromTitle('在线学堂 - 智慧树'), undefined);
    assert.equal(courseNameFromTitle(''), undefined);
  });

  it('纯数字与文件名不是课程名', () => {
    assert.equal(looksLikeCourseName('11430986'), false);
    assert.equal(looksLikeCourseName('大型歌舞剧《孔子》.mp4'), false);
    assert.equal(looksLikeCourseName('舞蹈欣赏'), true);
  });
});

describe('状态语义：能不能看出"交没交"决定任务归谁管', () => {
  it('中文完成态 → 可用（保住"平台优先"，作业交了会自动离开待办）', () => {
    const r = analyzeSamples([
      sample('https://x.edu/api/homework', {
        data: [
          { id: 1, title: '作业一', endTime: '2025-12-07 23:25', status: '已提交' },
          { id: 2, title: '作业二', endTime: '2025-12-08 23:25', status: '未提交' },
        ],
      }),
    ]);
    assert.equal(r.tasks[0]!.fields.status?.usableForCompletion, undefined, '可用时不该写这个开关');
  });

  it('英文完成态 → 可用，且 "not submitted" 不能被当成已交', () => {
    const r = analyzeSamples([
      sample('https://x.edu/api/tasks', {
        data: [
          { id: 1, title: 'A', dueAt: '2025-12-07T23:25:00Z', state: 'submitted' },
          { id: 2, title: 'B', dueAt: '2025-12-08T23:25:00Z', state: 'not submitted' },
        ],
      }),
    ]);
    const st = r.tasks[0]!.fields.status!;
    assert.notEqual(st.usableForCompletion, false, 'submit 类词根应该认得出来');
    assert.equal(mapStatus('not submitted', undefined), 'pending', 'not submitted 绝不能判成已交');
    assert.equal(mapStatus('submitted', undefined), 'submitted');
  });

  it('取值看不出语义（阶段/数字）→ 标记"不可用于判断完成"，交给用户自己标', () => {
    // 数字状态是最典型的：0/1 到底哪个是已交，没有通用答案。猜错会让作业
    // 从待办里凭空消失（用户以为做完了），比"标不了"严重得多。
    const r = analyzeSamples([
      sample('https://x.edu/api/tasks', {
        data: [
          { id: 1, title: 'A', dueAt: '2025-12-07T23:25:00Z', state: '进行中' },
          { id: 2, title: 'B', dueAt: '2025-12-08T23:25:00Z', state: '未开始' },
        ],
      }),
    ]);
    assert.equal(r.tasks[0]!.fields.status?.usableForCompletion, false);
    assert.ok(
      r.tasks[0]!.evidence.some((e) => e.includes('交给你自己标')),
      '必须解释为什么它不自动判断完成',
    );
  });
});

describe('用户动作是信号：翻页之后出现的接口更可能是完整列表', () => {
  it('mark > 0 的候选会被小幅加权，并说明依据', () => {
    const body = {
      data: [
        { id: 1, title: '作业一', endTime: '2025-12-07 23:25' },
        { id: 2, title: '作业二', endTime: '2025-12-08 23:25' },
      ],
    };
    const plain = analyzeSamples([sample('https://x.edu/api/tasks', body)]).tasks[0]!;
    const late = analyzeSamples([{ ...sample('https://x.edu/api/tasks', body), mark: 2 }]).tasks[0]!;
    assert.ok(late.confidence > plain.confidence, '翻页后出现的候选置信度应更高');
    assert.ok(
      late.evidence.some((e) => e.includes('翻页')),
      '必须把「凭什么更可信」写出来，否则用户看到的只是一个更高的分数',
    );
    // 加权只影响排序，不改变判据：两份都仍然是作业列表
    assert.equal(plain.rowCount, 2);
    assert.equal(late.rowCount, 2);
  });
});
