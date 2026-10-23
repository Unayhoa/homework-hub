/**
 * 演示用夹具数据。
 *
 * 刻意包含真实平台里会遇到的每一种「脏」形态，用来验证归一化层：
 *   - ISO 字符串、epoch 毫秒、中文相对时长（「还剩 3 天」）
 *   - 不限时 / 未公布
 *   - 已提交、已批阅（不应出现在待办里）
 *   - 缺少 workId（验证指纹兜底路径）
 *
 * 时间全部相对「当前时刻」生成，保证任何时候跑演示都能看到合理的倒计时。
 */
import type { MockCourse, MockTask } from './server.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface Fixtures {
  courses: MockCourse[];
  tasks: MockTask[];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 生成「本地墙上时间」字符串，形如 `2026-09-25 15:00`。
 *
 * 注意不要用 toISOString() —— 那是 UTC 时间，会被核心的解析器按本地时间读入，
 * UTC+8 的用户会整体偏移 8 小时。真实平台返回的也是本地时间，这里保持一致。
 */
function localDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createFixtures(now: Date): Fixtures {
  const t = now.getTime();

  const courses: MockCourse[] = [
    { id: 'C1001', name: '数据库系统原理', teacher: '李国强' },
    { id: 'C1002', name: '计算机网络', teacher: '王敏' },
    { id: 'C1003', name: '大学英语（三）', teacher: 'Sarah Chen' },
  ];

  const tasks: MockTask[] = [
    {
      id: 'work_88001',
      courseId: 'C1001',
      kind: 'homework',
      title: '第三章 关系数据库设计 课后作业',
      status: 'pending',
      // ISO 风格字符串（超星最常见）
      deadline: localDateTime(t + 2 * DAY + 3 * HOUR),
      publishedAt: localDateTime(t - 2 * DAY),
      totalScore: 100,
    },
    {
      id: 'work_88002',
      courseId: 'C1001',
      kind: 'exam',
      title: '期中考试（闭卷）',
      status: 'pending',
      // 离考试还有 9 天 —— 应触发 T-7d 提醒
      deadline: localDateTime(t + 9 * DAY),
      publishedAt: localDateTime(t - DAY),
      totalScore: 100,
    },
    {
      id: 'work_88003',
      courseId: 'C1002',
      kind: 'quiz',
      title: '第 2 章 物理层 随堂小测',
      status: 'pending',
      // epoch 毫秒（雨课堂风格）
      deadline: t + 20 * HOUR,
      publishedAt: localDateTime(t - 6 * HOUR),
      totalScore: 20,
    },
    {
      id: 'work_88004',
      courseId: 'C1002',
      kind: 'task-point',
      title: '第一章 绪论 视频任务点（4 个）',
      status: 'pending',
      deadline: localDateTime(t + 5 * DAY),
    },
    {
      id: 'work_88005',
      courseId: 'C1003',
      kind: 'discussion',
      title: 'Unit 3 Discussion: Describe your hometown',
      status: 'pending',
      // 中文相对时长 —— 必须在归一化时折算成绝对时刻
      deadline: '还剩 3 天',
    },
    {
      id: 'work_88006',
      courseId: 'C1003',
      kind: 'homework',
      title: 'Unit 3 Writing Task',
      status: 'pending',
      // 开放态
      deadline: '不限时',
    },
    {
      id: 'work_88007',
      courseId: 'C1001',
      kind: 'homework',
      title: '第二章 课后作业',
      status: 'submitted',
      deadline: localDateTime(t - 3 * DAY),
      totalScore: 100,
    },
    {
      id: 'work_88008',
      courseId: 'C1002',
      kind: 'homework',
      title: '第一章 概述 作业',
      status: 'graded',
      deadline: localDateTime(t - 8 * DAY),
      score: 92,
      totalScore: 100,
    },
    {
      id: 'work_88009',
      courseId: 'C1001',
      kind: 'homework',
      title: '实验一 数据建模 报告',
      status: 'pending',
      deadline: localDateTime(t + 6 * HOUR),
      totalScore: 30,
      // 关键：服务端不返回它的 ID，用来验证核心的「指纹兜底主键」路径。
      // 真实平台确实存在这种情况（接口按章节组织，任务本身没有全局 ID）。
      omitWireId: true,
    },
  ];

  return { courses, tasks };
}

