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
