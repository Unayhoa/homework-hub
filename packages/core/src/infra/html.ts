/**
 * 极简 HTML 提取工具。
 *
 * 为什么需要：不是所有平台都提供 JSON。超星的课程列表、
 * 多数高校教务系统，返回的都是 HTML 页面。真实项目里
 * （比如 WakeUp课程表 的 CourseAdapter）用 jsoup 之类的 DOM 解析器，
 * 但那会引入一个重量级依赖，而且对「从页面里抠几个属性」这个需求来说过重。
 *
 * 这里的策略是「正则 + 显式失败」：
 * 抽取失败时不是返回空数组，而是抛 schemaDrift。
 * 正则解析的最大风险是页面改版后静默返回空 —— 显式失败把这个风险转换成
 * 一个可观测的错误，用户看到的是「平台改版了」而不是「我的作业不见了」。
 */

/** 解码常用 HTML 实体。 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 收集某个标签内所有匹配项。 */
export function matchAll(html: string, pattern: RegExp): RegExpMatchArray[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...html.matchAll(new RegExp(pattern.source, flags))];
}

/** 取第一个匹配的指定捕获组。 */
export function firstGroup(html: string, pattern: RegExp, group = 1): string | undefined {
  const m = pattern.exec(html);
  return m?.[group];
}

/**
 * 按块切分 HTML。
 *
 * 页面里「课程卡片」「作业行」这类重复结构没有可靠的 DOM 边界，
 * 常规做法是先按某个稳定的容器标签切块，再在每块里抽字段。
 * 这样单个卡片结构异常只影响这一块，不会污染整页解析。
 */
export function splitBlocks(html: string, containerPattern: RegExp): string[] {
  const blocks: string[] = [];
  const re = new RegExp(containerPattern.source, containerPattern.flags.includes('g') ? containerPattern.flags : `${containerPattern.flags}g`);
  let lastIndex = 0;
  for (const m of html.matchAll(re)) {
    if (m.index === undefined) continue;
    if (lastIndex > 0) blocks.push(html.slice(lastIndex, m.index));
    lastIndex = m.index;
  }
  if (lastIndex > 0) blocks.push(html.slice(lastIndex));
  return blocks.filter((b) => b.trim().length > 0);
}

/** 从形如 `<a href="x" ...>text</a>` 里同时取属性和文本。 */
export function extractLink(html: string, pattern: RegExp): { href: string; text: string } | undefined {
  const m = pattern.exec(html);
  if (!m) return undefined;
  return { href: decodeEntities(m[1] ?? ''), text: stripTags(m[2] ?? '') };
}

/** 从 URL 的 query 里取参数，常用于从跳转链接里反解 courseId / clazzid。 */
export function queryParam(url: string, key: string): string | undefined {
  const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/** 判断响应体是否像登录页/验证码页 —— 用于把「被风控拦截」和「真的没数据」区分开。 */
export function looksLikeAuthWall(html: string): boolean {
  const head = html.slice(0, 4000);
  return /name=["']?(uname|password|pwd)["']?/i.test(head) || /(登录|扫码登录|请先登录|安全验证|拖动滑块)/.test(head);
}
