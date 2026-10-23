/**
 * 「自己加平台」用的接入模板与提示词。
 *
 * 这里的每一条注意事项都来自**真实接入过程**（超星 / 长江 / iSmart / PTA），
 * 不是通用建议。写的时候刻意区分了两类东西：
 *
 *   ① 接入要做的事（找接口、对字段、判状态）—— 模板负责
 *   ② 接入之后的表现（三态、进度条、提醒、UI）—— **不属于接入**，模板里一句不提
 *
 * PTA 那次之所以顺，就是因为全程只做了 ①：接口和字段全部照抄抓到的响应，
 * 没有一步是推断出来的。后面几轮改动（三态、进度、改名）都在 app 侧，
 * 跟"这个平台怎么读"无关 —— 这条边界必须写进模板，否则 AI 会把两件事混着做。
 */

/** 需要用户复制给 AI 的提示词。刻意短：AI 读得完才会照做。 */
export const ADAPTER_PROMPT = `你在为一个只读的作业聚合应用生成「平台接入配置」。只输出 JSON。

## 前提（不要重新设计）
- 登录态已就绪：用户已在应用内置浏览器里登录，cookie 由系统保管，不需要你描述登录流程。
- 请求由应用原生发出，会自动带 cookie。你只描述「读哪个地址、取哪个字段」。
- **只读**：只允许 GET / HEAD。不要设计任何 POST 写入。

## 输入
1. 平台页面在「用户能看到作业列表」那一刻的可见文本；
2. 该会话期间发出的网络请求（已脱敏：cookie / authorization / 登录请求都已剔除）。

## 硬性规则
1. **只使用输入里真实出现过的 URL 和字段名**。没看到就写 null，不要按命名规律推断。
2. 不要硬编码课程 id / 用户 id / 学期 id，用占位符 \${courseId} 这种形式。
3. 时间字段必须写清原始格式：epoch 秒 / epoch 毫秒 / ISO 字符串 / 自定义格式样例。
4. 状态字段必须列出**全部**取值和它们的含义；如果它描述的不是「我做没做」而是别的
   （比如题目集自身的发布阶段），明确标注"不可用于判断完成"。
5. 跳转链接：如果页面里有现成的 href，直接抄；**不要自己拼**带 enc / sign / token 的地址，
   这类参数由服务端签发、会过期。
6. 信息不足就输出 {"need_more":["还需要看到什么"], "confidence":0.3}，不要编造。

## 输出格式
{
  "platform": { "name": "...", "origin": "https://...", "notes": "" },
  "probe":   { "url": "...", "expectStatus": 200, "note": "怎么判断登录还有效" },
  "courses": { "url": "...", "listPath": "$.data.list", "idField": "id", "nameField": "name" },
  "tasks":   { "url": "...", "listPath": "$.data.list", "pagination": { "type": "page|none|cursor", "param": "page", "start": 0 } },
  "fields": {
    "id":    { "path": "id",    "note": "" },
    "title": { "path": "name",  "note": "" },
    "deadline": { "path": "endAt", "format": "epoch_ms|epoch_s|iso|custom", "sample": "" },
    "course":   { "path": "courseName", "note": "" },
    "status":   { "path": "status", "values": { "原值": "含义" }, "usableForCompletion": true }
  },
  "link": { "type": "href|template|none", "value": "", "note": "" },
  "confidence": 0.0
}

只输出 JSON。`;

/**
 * 接入时必须逐条核对的坑。都是踩过的，不是"可能"。
 * 展示在「添加平台」界面上，也可以拼进证据包一起给 AI。
 */
export const ADAPTER_PITFALLS = [
  {
    key: 'accept',
    title: '要带 Accept: application/json',
    detail:
      '有些平台（PTA）不带这个头会直接返回 protobuf 二进制，表现成"接口坏了"。适配器里凡是取 JSON 的请求都要显式带上。',
  },
  {
    key: 'status-is-not-completion',
    title: '列表里的 status 未必是"我做没做"',
    detail:
      'PTA 的题目集 status 在"已结束/进行中/未开始"三种情况下都是 PENDING，它描述的是题目集自身的阶段。真正的完成态要从每题状态聚合。',
  },
  {
    key: 'no-self-made-enc',
    title: '不要自己拼带 enc/sign/token 的链接',
    detail:
      '超星和长江的跳转地址里有服务端签发的短命参数，同步时抓到的那份，过一会儿就失效。能抄 href 就抄，抄不到就退回平台首页。',
  },
  {
    key: 'session-is-cookie',
    title: '会话就是 cookie，不要在适配器里搬运 token',
    detail:
      '应用内登录后 cookie 落在系统 CookieManager，原生请求自动带上。适配器不需要、也不应该去读 localStorage 里的 token —— 只有个别平台（雨课堂）例外。',
  },
  {
    key: 'pagination-shape',
    title: '分页参数不是统一的',
    detail: '有的是 page/limit，有的是 offset，有的直接返回全量。照抄抓到的请求参数，不要套模板。',
  },
  {
    key: 'empty-vs-broken',
    title: '「0 条」和「解析失败」必须分开',
    detail:
      '平台改版时最常见的故障是"返回了数据但我们解析出 0 条"。适配器要把这两种情况区分开报错，否则用户会以为作业做完了。',
  },
] as const;

/**
 * 证据包的拼装模板（脱敏后发给 AI 的那份 .md）。
 *
 * 为什么不是直接给 HAR：HAR 里有 cookie / authorization / 登录请求体，
 * 分享给第三方 AI 等于交出账号；而且几百 KB 的文件免费模型常常读不完。
 */
export function buildEvidencePack(input: {
  platformName: string;
  origin: string;
  pageText: string;
  requests: Array<{
    method: string;
    url: string;
    status?: number;
    mimeType?: string;
    bodyPreview?: string;
  }>;
}): string {
  const lines: string[] = [];
  lines.push('# 平台接入证据包');
  lines.push('');
  lines.push('> 已脱敏：cookie、authorization、登录请求、URL 中的 token 参数均已移除。');
  lines.push('');
  lines.push(`- 平台名（用户填写）：${input.platformName || '(未填)'}`);
  lines.push(`- 站点：${input.origin}`);
  lines.push('');
  lines.push('## 1. 用户看到作业列表时，页面上可见的文本');
  lines.push('');
  lines.push('```text');
  lines.push(truncate(input.pageText, 4000));
  lines.push('```');
  lines.push('');
  lines.push('## 2. 该会话期间的网络请求（已按时间排序，只保留 JSON 响应）');
  lines.push('');
  for (const r of input.requests.slice(0, 40)) {
    lines.push(`### ${r.method} ${r.url}`);
    if (r.status !== undefined) lines.push(`- 状态：${r.status}`);
    if (r.mimeType) lines.push(`- 类型：${r.mimeType}`);
    if (r.bodyPreview) {
      lines.push('- 响应片段：');
      lines.push('```json');
      lines.push(truncate(r.bodyPreview, 2500));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('请按提示词里的 JSON 格式输出平台接入配置。');
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`;
}
