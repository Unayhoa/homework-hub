/**
 * 学习通适配器的纯解析函数测试。
 *
 * 测试数据按社区公开抓包信息构造（52pojie「定时推送未完成作业」、
 * GreasyFork「学习通作业统一查看」描述的页面/JSON 结构）。
 * 拿到真实响应后如果结构有出入，改这里的夹具就能定位差异。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseBackclazzData,
  parseTaskListHtml,
  dedupeById,
  tagSkeleton,
  examPageDiagnosis,
  parseExamListHtml,
  ChaoxingAdapter,
} from '../chaoxing/src/index.ts';

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

describe('chaoxing · 同一任务重复出现（假变更的根源）', () => {
  const now = new Date('2026-11-01T10:30:00+08:00');

  it('同 id 出现两次且信息冲突 → 合并成一条，取保守值', () => {
    // 真机（2026-11-01）：同一份作业的截止时间在两次同步间来回跳
    // （10/22 ↔ 11/5）、状态也跳（已交 ↔ 待完成），用户什么都没做。
    // 原因是页面里同一任务被渲染了多次，后写覆盖前写，谁在后面看渲染顺序。
    const html = `
      <ul>
        <li><div><span>已交</span><p>数据结构上机实验</p></div>
            <span>2026-10-22 23:50</span>
            <a href="/work?workId=700001">看</a></li>
        <li><div><span>未交</span><p>数据结构上机实验</p></div>
            <span>2026-11-05 15:15</span>
            <a href="/work?workId=700001">看</a></li>
      </ul>`;
    const { items, conflicts } = dedupeById(parseTaskListHtml(html, now));
    assert.equal(items.length, 1, '同一个 id 只能有一条');
    assert.equal(conflicts, 1, '冲突次数要能被上报（不然用户只能看到"它自己在变"）');
    assert.equal(items[0]!.deadline, '2026-11-05 15:15', '截止时间取较晚 —— 取早的会被判逾期藏进折叠组');
    assert.equal(items[0]!.status, 'pending', '状态取保守（未交）—— 误判成已交会让作业从待办消失');
  });

  it('同 id 但信息一致 → 不算冲突', () => {
    const html = `
      <ul>
        <li><div><span>未交</span><p>作业</p></div><span>2026-11-05 15:15</span><a href="/w?workId=800001">看</a></li>
        <li><div><span>未交</span><p>作业</p></div><span>2026-11-05 15:15</span><a href="/w?workId=800001">看</a></li>
      </ul>`;
    const { items, conflicts } = dedupeById(parseTaskListHtml(html, now));
    assert.equal(items.length, 1);
    assert.equal(conflicts, 1, '重复出现本身就是异常信号（哪怕值一样）');
  });
});

describe('chaoxing · 平台原话要保留（「未开放」不是「待完成」）', () => {
  it('未开放作答 → pending，且原话带出去', () => {
    // 用户真机反馈：这几份实验在超星上是「未开放作答」，却显示成「待完成」，
    // 于是以为现在就该做。分类没错（它确实是待办），缺的是"平台怎么说的"。
    const [item] = parseTaskListHtml(
      '<ul><li><div><span>未开放作答</span><p>实验09 动态数据组织</p></div><span>2026-11-08 23:59</span></li></ul>',
      new Date('2026-11-01T10:30:00+08:00'),
    );
    assert.equal(item!.status, 'pending', '仍是待办，不能从待办里消失');
    assert.equal(item!.statusText, '未开放', '原话要带出去给界面显示');
  });

  it('「未交」这种和默认文案同义的也算命中，但界面不会用它顶替', () => {
    const [item] = parseTaskListHtml(
      '<ul><li><div><span>未交</span><p>作业</p></div></li></ul>',
      new Date('2026-11-01T10:30:00+08:00'),
    );
    assert.equal(item!.statusText, '未交');
  });
});

describe('chaoxing · 考试 id 的三种写法', () => {
  const now = new Date('2026-11-01T10:00:00+08:00');
  const wrap = (attr: string) =>
    `<ul><li><div><span>未开始</span><p>期中考试</p></div>${attr}</li></ul>`;

  it('examId=数字（query 形式）', () => {
    assert.equal(parseTaskListHtml(wrap('<a href="?examId=900001">进</a>'), now, 'exam')[0]!.platformTaskId, '900001');
  });
  it('data-examid="数字"（属性形式）', () => {
    assert.equal(parseTaskListHtml(wrap('<div data-examid="900002"></div>'), now, 'exam')[0]!.platformTaskId, '900002');
  });
  it('"examId":123（JSON 形态）', () => {
    assert.equal(
      parseTaskListHtml(wrap('<script>var d = {"examId":900003};</script>'), now, 'exam')[0]!.platformTaskId,
      '900003',
    );
  });
  it('作业规则不认 examId（防两类 id 撞车）', () => {
    assert.equal(parseTaskListHtml(wrap('<div data-examid="900004"></div>'), now, 'homework')[0]!.platformTaskId, undefined);
  });
});

describe('chaoxing · 结构骨架（拿不到数据时唯一的取证手段）', () => {
  it('只留标签，文字一律替换 —— 能看出结构，不泄漏内容', () => {
    const s = tagSkeleton(
      '<ul><li><span>张三</span><p class="title">期中考试</p><a href="/exam?examId=900001">进入考试</a></li></ul>',
    );
    assert.ok(!s.includes('张三'), '姓名绝不能出现在日志里');
    assert.ok(!s.includes('期中考试'), '标题也是内容');
    assert.ok(s.includes('href'), '但属性要留着 —— 排查要看的就是"有没有 href / examId"');
    assert.ok(s.includes('examId=900001'));
  });

  it('脚本与样式被整段丢弃', () => {
    const s = tagSkeleton('<li><script>var a=1</script><span>x</span><style>.a{color:red}</style></li>');
    assert.ok(!s.includes('var a=1'));
    assert.ok(!s.includes('color:red'));
  });
});

describe('chaoxing · 没有 id 的同名任务也必须合并', () => {
  const now = new Date('2026-11-01T12:30:00+08:00');

  it('无 id + 同名 → 合并成一条（否则引擎会生成相同指纹，两条互相覆盖）', () => {
    // 引擎对无 id 的任务用 `fp_<指纹>` 兜底，指纹只含「平台+课程+类型+标题」。
    // 于是页面上两份同名条目会落到**同一个 id**，在同一轮里互相覆盖 ——
    // 谁在后面取决于渲染顺序，所以每次同步"更新"的那一条都不一样。
    const html = `
      <ul>
        <li><div><span>已交</span><p>第一次上机</p></div><span>2026-10-22 23:50</span></li>
        <li><div><span>未交</span><p>第一次上机</p></div><span>2026-11-05 15:15</span></li>
      </ul>`;
    const { items, conflicts } = dedupeById(parseTaskListHtml(html, now));
    assert.equal(items.length, 1, '同名无 id 两条必须合并成一条');
    assert.equal(conflicts, 1);
    assert.equal(items[0]!.deadline, '2026-11-05 15:15');
  });

  it('标题有空格/全角差异也算同名', () => {
    const html = `
      <ul>
        <li><div><span>未交</span><p>实验 09　动态数据组织</p></div><span>2026-11-08 23:59</span></li>
        <li><div><span>未交</span><p>实验09 动态数据组织</p></div><span>2026-11-08 23:59</span></li>
      </ul>`;
    const { items } = dedupeById(parseTaskListHtml(html, now));
    assert.equal(items.length, 1);
  });
});

describe('chaoxing · 考试页诊断（要能在日志里一眼看懂）', () => {
  it('跳过 head，只报关键统计', () => {
    const html = `<!DOCTYPE html><html><head>
      <meta name="viewport" content="width=device-width"><link rel="stylesheet" href="//x/a.css">
      <title>作业考试</title></head>
      <body><ul><li><span>未开始</span><p>期中考试</p></li><li><span>已结束</span><p>期末</p></li></ul></body></html>`;
    const d = examPageDiagnosis(html);
    assert.ok(d.includes('<li> 2 个'), `实际：${d}`);
    assert.ok(d.includes('带 href 的 0 个'));
    assert.ok(!d.includes('viewport'), '不能再把 head 里的 meta 倒出来 —— 那等于什么都没看到');
    assert.ok(d.includes('期中考试') === false, '文字仍要被替换掉');
  });
});

describe('chaoxing · 考试列表（HAR 实证的真实结构）', () => {
  const now = new Date('2026-11-01T16:00:00+08:00');

  // 这段是从用户提供的 HAR（mooc2-ans.chaoxing.com.har）里原样摘出来的，
  // 只去掉了内联样式。结构、类名、onclick 参数顺序都是真实的。
  const REAL = `
  <ul id="examList">
    <li>
      <div style="float: left;" tabindex="0" role="option"
           onclick="goTest('204587864',11006129,0,'2026-11-02 11:40:00.0',196703545,false,'8cb49e73db04027f6f3b5653680b84a9', '0');">
        <div class="tag icon-exam icon-exam"></div>
        <div class="right-content">
          <p class="overHidden2 fl">期中考试</p>
          <div class="clear"></div>
          <p class="status fl">未开始</p>
        </div>
      </div>
      <div class="clear"></div>
    </li>
    <li>
      <div tabindex="0" role="option"
           onclick="goTest('204587864',11006001,0,'2026-10-20 10:00:00.0',196700001,false,'aaaa','0');">
        <div class="right-content">
          <p class="overHidden2 fl">第一次测验</p>
          <p class="status fl">已参加</p>
        </div>
      </div>
    </li>
  </ul>`;

  const items = parseExamListHtml(REAL, now);

  it('标题 / examId / 时间 / 状态全都能取到', () => {
    assert.equal(items.length, 2);
    assert.equal(items[0]!.title, '期中考试');
    assert.equal(items[0]!.platformTaskId, '11006129', 'examId 在 goTest 的第二个参数');
    assert.equal(items[0]!.deadline, '2026-11-02 11:40', '时间在 goTest 的第四个参数');
    assert.equal(items[0]!.status, 'pending');
    assert.equal(items[0]!.statusText, '未开始');
  });

  it('已参加的考试是终态（不该继续挂在待办里催）', () => {
    assert.equal(items[1]!.status, 'submitted');
    assert.equal(items[1]!.deadline, '2026-10-20 10:00');
  });

  it('页面上根本不显示时间 —— 所以按文本找日期永远是空的', () => {
    // 这是之前一直拿不到时间的真正原因：只有"未开始"，没有"11-02 11:40"这段文字。
    const visibleText = REAL.replace(/onclick="[^"]*"/g, '');
    assert.ok(!/(\d{4})-(\d{2})-(\d{2})/.test(visibleText), '去掉 onclick 后页面上没有任何日期');
    assert.equal(items[0]!.deadline, '2026-11-02 11:40', '但解析器仍然拿到了');
  });

  it('空壳页面（只有隐藏 input、没有 <li>）必须解析出 0 条', () => {
    // 上一版就是打到了这种页面：HTTP 200，但 `<li> 0 个`，数据由 JS 再拉。
    const shell = `<html><body>
      <input type="hidden" id="courseId" value="215129863"/>
      <input type="hidden" id="classId" value="155527044"/>
      <input type="hidden" id="pageNum" value="0"/>
      <input type="hidden" id="vx" value="0"/>
    </body></html>`;
    assert.equal(parseExamListHtml(shell, now).length, 0);
    assert.ok(examPageDiagnosis(shell).includes('<li> 0 个'));
  });
});
