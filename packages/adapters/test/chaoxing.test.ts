/**
 * 学习通适配器的纯解析函数测试。
 *
 * 测试数据按社区公开抓包信息构造（52pojie「定时推送未完成作业」、
 * GreasyFork「学习通作业统一查看」描述的页面/JSON 结构）。
 * 拿到真实响应后如果结构有出入，改这里的夹具就能定位差异。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseBackclazzData, parseTaskListHtml, ChaoxingAdapter } from '../chaoxing/src/index.ts';

describe('chaoxing · parseBackclazzData（课程 JSON）', () => {
  const fixture = JSON.stringify({
    channelList: [
      {
        cpi: '12345',
        content: {
          course: {
            data: [
              {
                name: '数据结构',
                teacherName: '张三',
                courseSquareUrl: 'https://mooc1-2.chaoxing.com/mycourse/stu?courseId=200001&classId=100001&cpi=12345',
              },
            ],
          },
        },
      },
      {
        // 没有 cpi 的频道（往期学期）—— 照收，作业接口少带一个参数
        content: {
          course: {
            data: [
              {
                name: '大学物理',
                courseSquareUrl: 'https://mooc1-2.chaoxing.com/mycourse/stu?courseId=200002&classId=100002',
              },
            ],
          },
        },
      },
      // 非课程频道：没有 course.data
      { content: { other: true } },
      // 重复课程：courseId 相同 → 去重
      {
        cpi: '12345',
        content: {
          course: {
            data: [
              { name: '数据结构', courseSquareUrl: 'https://x/?courseId=200001&classId=100001' },
            ],
          },
        },
      },
    ],
  });

  it('解析出课程与 classId/cpi，并去重', () => {
    const refs = parseBackclazzData(fixture);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.name, '数据结构');
    assert.equal(refs[0]!.platformCourseId, '200001');
    assert.equal(refs[0]!.classId, '100001');
    assert.equal(refs[0]!.cpi, '12345');
    assert.equal(refs[1]!.name, '大学物理');
    assert.equal(refs[1]!.cpi, undefined);
  });

  it('非 JSON / 缺 channelList 时抛 schemaDrift，绝不静默返回空', () => {
    assert.throws(() => parseBackclazzData('<html>请登录</html>'), /非 JSON|改版/);
    assert.throws(() => parseBackclazzData('{"foo":1}'), /channelList/);
  });
});

describe('chaoxing · parseTaskListHtml（作业 HTML）', () => {
  const now = new Date('2026-09-25T12:00:00+08:00');

  const html = `
  <div class="wrap">
    <ul>
      <li>
        <div><span>未交</span><p>第一次作业：链表</p></div>
        <span class="fr">剩余24小时30分钟</span>
      </li>
      <li>
        <div><span>已交</span><p>第二次作业：二叉树</p></div>
        <span class="fr">已截止 2026-09-20 23:59</span>
      </li>
      <li>
        <div><p>第三次作业：图论（无状态字段）</p></div>
      </li>
      <li><div><span>未交</span></div></li>
    </ul>
  </div>`;

  it('解析标题、状态与相对倒计时截止', () => {
    const items = parseTaskListHtml(html, now);
    assert.equal(items.length, 3); // 没有 title 的 li 被跳过

    const first = items[0]!;
    assert.equal(first.title, '第一次作业：链表');
    assert.equal(first.status, 'pending');
    // 剩余 24h30m → now + 24.5h
    const expected = now.getTime() + (24 * 3600 + 30 * 60) * 1000;
    assert.ok(first.deadline);
    assert.equal(new Date(first.deadline!).getTime(), expected);

    const second = items[1]!;
    assert.equal(second.title, '第二次作业：二叉树');
    assert.equal(second.status, 'submitted');
    assert.equal(second.deadline, '2026-09-20 23:59');

    const third = items[2]!;
    assert.equal(third.status, 'unknown');
    assert.equal(third.deadline, undefined);
  });

  it('解析天级倒计时', () => {
    const items = parseTaskListHtml('<li><div><span>未交</span><p>实验报告</p></div><span class="fr">剩余3天2小时</span></li>', now);
    const expected = now.getTime() + (3 * 24 * 3600 + 2 * 3600) * 1000;
    assert.equal(new Date(items[0]!.deadline!).getTime(), expected);
  });

  it('页面里没有 li 条目时返回空数组（由上层决定是否算异常）', () => {
    assert.equal(parseTaskListHtml('<html><body>没有作业</body></html>', now).length, 0);
  });
});

describe('chaoxing · 适配器装配', () => {
  it('端点可被覆盖（为按学校定制留口子）且能力声明正确', () => {
    const a = new ChaoxingAdapter({ endpoints: { workTaskList: 'https://school.example.com/work/task-list' } });
    assert.equal(a.id, 'chaoxing');
    assert.equal(a.capabilities.cookieOnlySession, true);
    assert.equal(
      a.readOnlyPolicy.allowPost?.some((p) => p.pattern instanceof RegExp && p.pattern.source.includes('getAllWork')),
      true,
    );
  });
});

describe('chaoxing · 考试列表（2026-11-01 之前的接口是死路径）', () => {
  const now = new Date('2026-11-01T10:00:00+08:00');

  // 超星的考试页和作业页同构（都是 <li> 列表），只是状态词和 id 参数不同。
  const html = `
  <div class="exam-wrap">
    <ul>
      <li>
        <div><span>未开始</span><p>期中考试</p></div>
        <a href="https://mooc1.chaoxing.com/mooc-ans/exam/test/reVersionTestStartNew?courseId=1&amp;classId=2&amp;examId=900001">进入</a>
        <span class="fr">2026-11-08 14:00</span>
      </li>
      <li>
        <div><span>未参加</span><p>补考（没参加）</p></div>
        <a href="/mooc-ans/exam/test/reVersionTestStartNew?examId=900002">进入</a>
      </li>
      <li>
        <div><span>已参加</span><p>第一次测验</p></div>
        <span class="fr">2026-10-20 10:00</span>
      </li>
      <li>
        <div><span>已结束</span><p>上学期的考试</p></div>
      </li>
    </ul>
  </div>`;

  const items = parseTaskListHtml(html, now, 'exam');

  it('能按 examId 认出考试条目（不是 workId）', () => {
    assert.equal(items.length, 4);
    assert.equal(items[0]!.platformTaskId, '900001', '考试用的是 examId');
    assert.equal(items[0]!.title, '期中考试');
  });

  it('状态词按考试那套映射：未开始 → pending（不能因为认不出就丢掉）', () => {
    assert.equal(items[0]!.status, 'pending', '未开始必须是待办');
    assert.equal(items[2]!.status, 'submitted', '已参加 = 已交');
    assert.equal(items[3]!.status, 'expired', '已结束 = 过期');
  });

  it('「未参加」绝不能被判成「已参加」', () => {
    // 两者只差一个字，而判错的后果是：没考的试从待办里消失，用户以为考完了。
    assert.equal(items[1]!.status, 'pending', '未参加是没考，必须留在待办');
  });

  it('直达链接原样搬（含 &amp; 解码），相对路径不猜 host', () => {
    assert.equal(
      items[0]!.sourceUrl,
      'https://mooc1.chaoxing.com/mooc-ans/exam/test/reVersionTestStartNew?courseId=1&classId=2&examId=900001',
      '&amp; 要还原成 &，否则链接带 %26 打不开',
    );
    assert.equal(items[1]!.sourceUrl, undefined, '相对路径不猜 host —— 猜错就是一个打不开的页面');
  });

  it('截止时间从绝对时间取（考试时间窗固定，没有「剩余X小时」）', () => {
    assert.equal(items[0]!.deadline, '2026-11-08 14:00');
  });

  it('作业页与考试页共用解析器，但 id 规则按 kind 切换（不跨类型兜底）', () => {
    // 状态词表是**共用**的：作业页里出现「未完成」「已结束」也很正常，
    // 按类型分两套词表反而会让某些表述落在 unknown 里。
    // 但 id 必须按类型分开 —— 两类 id 混用会在同一空间撞车。
    const asWork = parseTaskListHtml(html, now, 'homework');
    assert.equal(asWork[0]!.platformTaskId, undefined, '作业规则不该从 examId 取值');
    assert.equal(asWork[0]!.status, 'pending', '状态词共用，所以照样认得出「未开始」');
  });

  it('多日期时取最晚的（截止语义），不取第一个', () => {
    // 真机：截止时间在两次同步间来回跳（10/22 ↔ 11/5），因为行里同时有
    // 发布/开始时间与截止时间，而原来取的是"文本中第一个"。
    const twoDates = `
      <ul><li>
        <div><span>未交</span><p>数据结构上机实验</p></div>
        <span>发布于 2026-10-22 23:50</span>
        <span class="fr">截止 2026-11-05 15:15</span>
      </li></ul>`;
    const [item] = parseTaskListHtml(twoDates, now);
    assert.equal(item!.deadline, '2026-11-05 15:15', '取最晚，才不会被判成逾期，也不会来回跳');
  });

  it('日期格式要放宽：2026.11.08 / 2026年11月8日 都要认（考试页常见）', () => {
    const dot = parseTaskListHtml(
      '<ul><li><div><span>未开始</span><p>期末</p></div><span>2026.11.08 14:00</span></li></ul>',
      now,
      'exam',
    );
    assert.equal(dot[0]!.deadline, '2026-11-08 14:00');

    const cn = parseTaskListHtml(
      '<ul><li><div><span>未开始</span><p>期末</p></div><span>2026年11月8日 14:00</span></li></ul>',
      now,
      'exam',
    );
    assert.equal(cn[0]!.deadline, '2026-11-08 14:00', '中文年月日以前完全解析不出来 → 落进「截止未知」');
  });

  it('状态按优先级判定，与词的出现位置无关', () => {
    // 行里同时出现两个词时，取"文本中最先出现的"会随渲染顺序抖动，
    // 表现就是变更历史里「已提交 ↔ 待完成」来回跳。
    const both = parseTaskListHtml(
      '<ul><li><div><span>已交</span><p>作业</p></div><span>未交 2 项</span></li></ul>',
      now,
    );
    assert.equal(both[0]!.status, 'pending', '有"未交"就是没做完，不能被前面的"已交"带走');
  });
});
