/**
 * 长江雨课堂解析测试 —— 夹具直接取自 2026-09-29 的真实抓包（changjiang.yuketang2.cn.har）：
 * 课程列表 /v2/api/web/courses/list?identity=2 + 章节树 /mooc-api/v1/lms/learn/course/chapter。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseYuketangCourses, collectChangjiangLeaves } from '../yuketang/src/index.ts';
import type { UnifiedTask } from '../../core/src/index.ts';

// ---- 真实抓包片段（/v2/api/web/courses/list?identity=2）----
const COURSE_ROW = {
  term: 202601,
  name: '2026秋-25网络空间01；25网络空间02；25网络空间03；',
  students_count: 110,
  teacher: { user_id: 31004150, name: '董旭初' },
  role: 5,
  classroom_id: 26617021,
  course: {
    name: '信息安全数学基础',
    id: 2857235,
    university_name: '吉林大学',
  },
};

// ---- 真实抓包片段（/mooc-api/v1/lms/learn/course/chapter 的章节树，节选）----
const CHAPTER_TREE = {
  success: true,
  data: {
    course_id: 2857235,
    course_name: '信息安全数学基础',
    course_chapter: [
      {
        name: '第一章',
        section_leaf_list: [
          { name: '1.1 视频', leaf_type: 0, id: 111 },
          {
            name: '信安第一次作业(1)',
            leaf_type: 9,
            id: 48593961,
            start_time: 1789443535000,
            end_time: 0,
            score_deadline: 1790092740000, // 已过（9/23）→ expired
            is_assessed: true,
          },
          {
            name: '信安第二次作业(1)',
            leaf_type: 9,
            id: 48594018,
            start_time: 1789443570000,
            end_time: 0,
            score_deadline: 1790092740000, // 已过 → expired
          },
        ],
      },
      {
        name: '第三章',
        section_leaf_list: [
          {
            name: '信安第三次作业(1)',
            leaf_type: 9,
            id: 49547448,
            start_time: 1790744235000,
            end_time: 0,
            score_deadline: 1791734340000, // 未到 → pending
            is_assessed: false,
          },
          {
            name: '信安第四次作业(1)',
            leaf_type: 9,
            id: 49547451,
            score_deadline: 1791734340000,
          },
          {
            name: '信安第五次作业（王班）',
            leaf_type: 9,
            id: 49547456,
            score_deadline: 1791734340000,
          },
        ],
      },
    ],
  },
};

describe('yuketang-changjiang · parseYuketangCourses（真实抓包夹具）', () => {
  it('course.name 才是课程名，id 用 classroom_id', () => {
    const courses = parseYuketangCourses([COURSE_ROW]);
    assert.equal(courses.length, 1);
    assert.equal(courses[0]?.platformCourseId, '26617021');
    assert.equal(courses[0]?.name, '信息安全数学基础');
    assert.equal(courses[0]?.teacher, '董旭初');
  });

  it('缺 classroom_id 或课程名的行被跳过', () => {
    assert.equal(parseYuketangCourses([{ name: 'x' }, { classroom_id: 1 }]).length, 0);
  });
});

describe('yuketang-changjiang · collectChangjiangLeaves（真实抓包夹具）', () => {
  const nowMs = 1791200000000; // 2026-10-05 前后：第一次/第二次已过期，三/四/五次未到
  const out: UnifiedTask[] = [];
  collectChangjiangLeaves(CHAPTER_TREE, out, '26617021', '信息安全数学基础', nowMs);

  it('跨两层章节收集全部 5 个作业叶子，忽略视频等非作业节点', () => {
    assert.equal(out.length, 5);
    assert.equal(out[0]?.title, '信安第一次作业(1)');
  });

  it('计分截止已过 → expired；未到 → pending', () => {
    const byTitle = new Map(out.map((t) => [t.title, t.status]));
    assert.equal(byTitle.get('信安第一次作业(1)'), 'expired');
    assert.equal(byTitle.get('信安第二次作业(1)'), 'expired');
    assert.equal(byTitle.get('信安第三次作业(1)'), 'pending');
    assert.equal(byTitle.get('信安第五次作业（王班）'), 'pending');
  });

  it('deadline 用 score_deadline（毫秒转 ISO），courseId/courseName 正确', () => {
    const third = out.find((t) => t.title === '信安第三次作业(1)');
    assert.ok(third, '第三次作业应被收集');
    assert.equal(third.deadline, new Date(1791734340000).toISOString());
    assert.equal(third.courseId, '26617021');
    assert.equal(third.courseName, '信息安全数学基础');
    assert.equal(third.platformTaskId, '49547448');
  });
});
