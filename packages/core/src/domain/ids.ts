/**
 * 稳定标识与内容指纹。
 *
 * 跨平台聚合最容易被低估的难点：
 * 平台侧「任务」往往没有可作为主键的稳定 ID（有的用 chapterId_workId 拼接、
 * 有的干脆每次请求都变）。所以我们采用两级标识策略：
 *
 *   1. 首选 platformTaskId —— 平台给了就用它，稳定且免费。
 *   2. 兜底 fingerprint  —— 由 (课程, 类型, 归一化标题, 截止时间) 派生。
 *      标题归一化必须剥离「（第2次）」「[已修改]」这类老师手动改的噪音后缀。
 *
 * 两级都进 UnifiedTask，让 merge 层可以「换主键而不重建记录」。
 *
 * 关于哈希实现：用纯 JS 的 sha1Hex（domain/sha1.ts）而不是 node:crypto ——
 * 因为这一层要能跑在 Android WebView 里，而那里没有 node:crypto。
 * 两者输出逐字节一致，所以指纹不会因为换实现而变化。
 */
import { sha1Hex } from './sha1.ts';

const SEP = '\u0001';

export { sha1Hex };

export function hashOf(...parts: Array<string | number | null | undefined>): string {
  return sha1Hex(parts.map((p) => (p ?? '').toString().trim()).join(SEP));
}

/**
 * 全局主键：平台 + 账号 + 平台内 ID。三者缺一不可。
 *
 * 为什么必须带账号：同一个平台可以挂多个账号（两个学校的学习通、
 * 两个班的雨课堂），而平台内 ID 只在平台内部唯一。
 * 早期版本漏掉了账号维度，导致两个账号的 work_88001 互相覆盖 ——
 * 一个账号的作业会把另一个账号的作业「顶掉」。
 *
 * 账号段用哈希而不是明文：主键会出现在 URL、日志和 UI 里，
 * 明文账号 ID 既冗长又泄露学号/手机号。
 */
export function makeTaskId(platformId: string, accountId: string, platformTaskId: string): string {
  return `${platformId}:${sha1Hex(accountId).slice(0, 8)}:${platformTaskId}`;
}

export function makeCourseId(platformId: string, accountId: string, platformCourseId: string): string {
  return `${platformId}:${sha1Hex(accountId).slice(0, 8)}:${platformCourseId}`;
}

/**
 * 标题归一化：用于生成指纹做去重。
 * 真实场景里同一份作业在两次同步中的标题可能差一个后缀，
 * 不归一化就会重复入库，用户会看到两条一模一样的待办。
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[（(【\[][^）)】\]]{0,12}[）)】\]]\s*$/, '') // 结尾括号备注
    .replace(/[·•\-—_]+$/, '')
    .toLowerCase();
}

/**
 * 内容指纹。刻意不包含 status / score —— 
 * 「交了作业」不应该让指纹变化，否则每次提交都会被当成新任务重复提醒。
 * deadline 变化同样不进指纹，改期应该表现为「变更」而非「新建」。
 */
export function makeFingerprint(input: {
  platformId: string;
  courseId: string;
  kind: string;
  title: string;
}): string {
  return hashOf(input.platformId, input.courseId, input.kind, normalizeTitle(input.title)).slice(0, 32);
}

/** 提醒去重键：任务 × 规则 × 触发时间桶，保证同一提醒只发一次。 */
export function makeReminderKey(taskId: string, ruleId: string, bucket: string): string {
  return hashOf(taskId, ruleId, bucket).slice(0, 32);
}
