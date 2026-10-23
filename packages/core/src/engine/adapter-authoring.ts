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

**注意：你不是在提取作业内容，而是在写「以后怎么自动读取」的规则。**
上面的页面文本只是帮你定位字段名用的，不要把它里面的作业抄进结果 ——
只有写对了规则，应用才能每天自动同步，而不是只能看一次。

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
      lines.push(truncate(maskBody(r.bodyPreview), 2500));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('请按提示词里的 JSON 格式输出平台接入配置。');
  return lines.join('\n');
}

/**
 * 把响应里的」内容「换成占位符，只留结构。
 *
 * 为什么必须这么做（2026-10-23 实测）：只要证据包里能看见作业标题，
 * 手机端 AI 就会去「提取作业」，而不是「写读取规则」——连着两次都是这样，
 * 加多少句约束都没用。看不见内容，它就只能描述怎么读。
 *
 * 日期/数字类字符串**保留**：AI 需要知道时间字段长什么样才能填对 format。
 */
function maskValues(v: unknown, depth = 0): unknown {
  if (depth > 6) return '<deep>';
  if (Array.isArray(v)) return v.slice(0, 1).map((x) => maskValues(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = maskValues(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') {
    // 保留能说明格式的：日期/时间、纯数字、短枚举
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?/.test(v)) return v;
    if (/^\d{1,6}$/.test(v)) return v;
    return `<string len=${v.length}>`;
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  return v;
}

/** 给 bodyPreview 做结构脱敏；解析不了就原样（短文本没风险）。 */
export function maskBody(body: string): string {
  try {
    return JSON.stringify(maskValues(JSON.parse(body)), null, 2);
  } catch {
    return body;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`;
}

/**
 * 诊断包：把「失败了什么」+「现在的配置」交给 AI，让它在原配置上**只改错的地方**。
 *
 * 为什么不让它重写：重写会把已经对的部分也改掉（真机上就有过把 courseId 写成页码）。
 * 只改错处，风险面小得多。
 */
export function drillPack(platformId: string, error: string, config: unknown): string {
  return [
    '# 平台接入诊断',
    '',
    `平台标识：${platformId}`,
    '',
    '## 出了什么问题',
    '',
    error || '(没有拿到具体错误信息)',
    '',
    '## 当前配置（有问题的那份）',
    '',
    '',
    '',
    '## 要求',
    '',
    '1. **只改错的地方**，其余字段原样保留 —— 不要重写、不要精简、不要换风格。',
    '2. 如果错误信息里的「接口返回」表明地址不对，用证据里出现过的真实地址替换。',
    '3. 如果表明字段路径不对，按接口返回的真实结构修正 listPath 或 fields.*.path。',
    '4. 只输出完整的修正版 JSON，不要解释。',
    '5. 仍不确定就输出 {"need_more":["还需要什么"],"confidence":0.3}。',
  ].join('\n');
}
