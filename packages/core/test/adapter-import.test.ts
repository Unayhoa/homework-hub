/**
 * 「AI 回复 → 导入作业」的解析测试。
 *
 * 样本**原样取自 2026-10-23 真机**：用户在手机端 AI 上粘了我们给的提示词，
 * 回来的是「作业数据」而不是「接入配置」。
 *
 * 这就是为什么要两种都认 —— 提示词写得再清楚，模型也常给数据。
 * 如果只认配置，用户会看到"格式不对"然后卡死；认数据，他当场就能看到作业。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJson,
  looksDone,
  looksLikeNeedsSignature,
  normalizeDeadline,
  parseImport,
} from '../../../apps/web/src/adapter-import.ts';

/** 真机原样回复（未做任何修改）。 */
const REAL_AI_REPLY = `{
  "platform": "zhihuishu",
  "courseId": "11430986",
  "courseName": "～2025秋本科生舞蹈欣赏",
  "teacherName": "王宁",
  "homeworkList": [
    {
      "homeworkId": "3661764",
      "title": "假条提交",
      "desc": "同学们可提交以下假条：病假，大型考试，大型活动。",
      "deadline": "2025-12-07 23:25",
      "status": "已迟交"
    },
    {
      "homeworkId": "3618418",
      "title": "期末结课论文",
      "desc": "从本学期课程中鉴赏过的中外经典舞蹈或舞剧作品中选取一部进行深入评鉴。字数800。",
      "deadline": "2025-12-02 00:00",
      "status": "待批阅"
    },
    {
      "homeworkId": "3534104",
      "title": "平时作业（10.19）",
      "desc": "简述汉代舞蹈的特点，无字数要求。",
      "deadline": "2025-11-16 23:59",
      "status": "待批阅"
    }
  ]
}`;

describe('识别真机回来的「作业数据」格式', () => {
  it('三条作业全部识别出来，课程名与平台名都在', () => {
    const r = parseImport(REAL_AI_REPLY);
    assert.equal(r.kind, 'homework');
    assert.equal(r.error, undefined);
    assert.equal(r.homework?.length, 3);
    assert.equal(r.courseName, '～2025秋本科生舞蹈欣赏');
    assert.equal(r.platformName, 'zhihuishu');
    assert.equal(r.homework?.[0]?.title, '假条提交');
    assert.equal(r.homework?.[2]?.title, '平时作业（10.19）');
  });

  it('「2025-12-07 23:25」按本地时间解析，不是丢掉也不是当 UTC', () => {
    const r = parseImport(REAL_AI_REPLY);
    const iso = r.homework?.[0]?.deadline;
    assert.ok(iso, '必须有截止时间');
    const d = new Date(iso!);
    assert.equal(d.getFullYear(), 2025);
    assert.equal(d.getMonth(), 11); // 12 月
    assert.equal(d.getDate(), 7);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 25);
  });

  it('「待批阅 / 已迟交」都算已交过 —— 不该再出现在待办里催命', () => {
    assert.equal(looksDone('待批阅'), true);
    assert.equal(looksDone('已迟交'), true);
    assert.equal(looksDone('未交'), false);
    assert.equal(looksDone(''), false);
  });
});

describe('容错：真实回复经常不是干净 JSON', () => {
  it('裹在 ```json 代码块里也能解析', () => {
    const wrapped = '好的，我分析了一下：\n\n```json\n' + REAL_AI_REPLY + '\n```\n\n以上是作业列表。';
    const r = parseImport(wrapped);
    assert.equal(r.homework?.length, 3, '前后有解释文字也要能抠出 JSON');
  });

  it('完全不是 JSON → 给出可操作的建议，而不是静默失败', () => {
    const r = parseImport('这个平台需要先登录才能看到作业。');
    assert.equal(r.homework, undefined);
    assert.match(String(r.error), /没有从回复里找到 JSON/);
  });

  it('认不出结构时也不崩，并且提示"换个 AI 重答"', () => {
    const r = parseImport('{"foo": 1, "bar": 2}');
    assert.match(String(r.error), /认不出/);
  });
});

describe('识别「接入配置」格式（另一种可能）', () => {
  it('有 tasks.url 与 fields 就按配置认，并说明暂不能自动同步', () => {
    const cfg = JSON.stringify({
      platform: { name: '某平台', origin: 'https://x.edu.cn' },
      tasks: { url: '/api/homework', listPath: '$.data.list' },
      fields: { id: { path: 'id' }, title: { path: 'name' } },
      confidence: 0.8,
    });
    const r = parseImport(cfg);
    assert.equal(r.kind, 'adapter');
    assert.equal(r.error, undefined);
    assert.ok(r.notes.some((n) => n.includes('/api/homework')));
    assert.ok(r.notes.some((n) => n.includes('启用为平台')), '应提示可以启用');
  });

  it('配置缺少作业列表地址时，明确说缺什么', () => {
    const r = parseImport(JSON.stringify({ tasks: { listPath: '$' }, fields: { title: {} } }));
    assert.match(String(r.error), /tasks\.url/);
  });
});

describe('基础工具', () => {
  it('extractJson 能处理前后杂字', () => {
    assert.deepEqual(extractJson('前面{"a":1}后面'), { a: 1 });
    assert.equal(extractJson('没有 json'), null);
  });

  it('epoch 秒与毫秒都能认', () => {
    assert.ok(normalizeDeadline(1792796642)?.startsWith('2026-'));
    assert.ok(normalizeDeadline(1792796642000)?.startsWith('2026-'));
    assert.equal(normalizeDeadline('不是时间'), undefined);
  });
});

describe('修复 AI 造成的 JSON 破损', () => {
  it('字符串里的裸双引号（真机原文）能被救回来', () => {
    // 2026-10-23 智慧树那次：AI 在 note 里写了 status为"200"，直接弄坏 JSON
    const broken = `{
      "probe": { "note": "响应体业务status为"200"且包含rt字段则登录有效" },
      "tasks": { "url": "https://x/api?courseId=1", "listPath": "$.rt.list" }
    }`;
    const r = parseImport(broken);
    assert.equal(r.kind, 'adapter');
    assert.ok(r.adapterDraft, '必须能解析出来');
  });

  it('中文引号和尾逗号也能处理', () => {
    const broken = '{ "a": “x”, "b": 1, }';
    assert.deepEqual(extractJson(broken), { a: 'x', b: 1 });
  });

  it('正常 JSON 不受影响', () => {
    assert.deepEqual(extractJson('{"a":"b","c":[1,2]}'), { a: 'b', c: [1, 2] });
  });
});

describe('预判「这接口需要动态签名」（该走 DOM 模式）', () => {
  it('智慧树那种 key={uuid} / dateFormate 能被识别', () => {
    const url = 'https://hiexam-server.zhihuishu.com/x?courseId=1&key={uuid}&dateFormate=${dateFormate}';
    assert.equal(looksLikeNeedsSignature(url), true);
  });

  it('普通课程接口不该误判', () => {
    assert.equal(looksLikeNeedsSignature('/api/courses/1/assignments?page=1'), false);
    assert.equal(looksLikeNeedsSignature('/api/homework?courseId=11430986'), false);
  });
});

describe('DOM 配置（点选当场生成的）能被导入', () => {
  const domCfg = JSON.stringify({
    platform: { name: 'zhihuishu', origin: 'https://wenda.zhihuishu.com' },
    mode: 'dom',
    url: 'https://wenda.zhihuishu.com/stu/courseInfo/homeworkExam/?courseId=11430986',
    readyWhen: '.homework-item',
    rows: '.homework-item',
    fields: { title: { find: '.title' }, deadline: { regex: '\\d{4}' } },
    defaultCourseId: '11430986',
  });

  it('认成 adapter 而不是"认不出"', () => {
    const r = parseImport(domCfg);
    assert.equal(r.kind, 'adapter');
    assert.equal(r.error, undefined);
    assert.ok(r.notes.some((n) => n.includes('已在本机试抓通过')));
  });

  it('缺 url 时说清楚缺什么', () => {
    const bad = JSON.stringify({ mode: 'dom', rows: '.x', fields: { title: {} } });
    const r = parseImport(bad);
    assert.match(String(r.error), /url/);
  });
});
