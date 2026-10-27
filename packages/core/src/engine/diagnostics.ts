/**
 * 故障接收器：把「任何一处可能的失败」收敛成**一份可复制的材料 + 一句人话**。
 *
 * 为什么需要这个模块，而不是各报错点自己拼一段文案：
 *   1. 报错文案与真因经常不是一回事（LESSONS 第 1 条）。同一个真因会在不同位置
 *      冒出来（试抓、启用后同步、DOM 点选），如果每处自己写一句，用户拿到的材料
 *      质量随机 —— 有时只有一句"失败"，有时一堆原始 JSON。
 *   2. 免费 AI 的能力是有边界的：**它修不了会话失效、也修不了签名参数**。
 *      把这类问题做成"发给 AI"的包，等于让它编一个理由（本项目真发生过：
 *      它把 DOM 失败解释成"原 DOM 因跳转登录页失败"）。所以这里把故障分成
 *      两类：**AI 能修的**（配置里的路径/选择器/字段）和 **AI 修不了的**（会话/签名/网络），
 *      后者只给用户一个动作，不给 AI 包。
 *   3. 用户不做技术判断。他只能做两件事：点一下、复制粘贴。所以每份材料必须是
 *      **自包含**的 —— 粘到任何免费模型的对话框里就能用，不需要他补充任何背景。
 *
 * 提示词的写法受免费模型的限制：短、任务唯一、明确"只输出 JSON"、
 * 明确"你不是在提取作业"。这几条都是踩出来的（adapter-authoring.ts 顶部有记录）。
 */
import type { AdapterConfig } from './declarative-adapter.ts';
import { maskBody } from './adapter-authoring.ts';
import type { ProbeSample } from './probe.ts';

export type FailureKind =
  /** 录制了，但一条像作业列表的响应都没认出 */
  | 'probe-empty'
  /** 试抓请求本身报错（地址/结构不对） */
  | 'trial-failed'
  /** 请求成功，但解析出 0 条（listPath 或字段路径不对） */
  | 'trial-empty'
  /** 会话失效 / 没登录 */
  | 'auth'
  /** 接口要页面现算的签名参数 —— 原理上只能走 DOM 模式 */
  | 'signature'
  /** DOM 点选后抓不到 */
  | 'dom-selector'
  /** 网络/限流：等一会儿再来，AI 帮不上 */
  | 'network'
  /** 课程归属可疑（课程数异常增长 / 与课程表对不上） */
  | 'course-mismatch'
  | 'unknown';

export interface FixAction {
  /** 按钮上要写的字（用户只看这一行） */
  label: string;
  /** tap = 在应用内就能做完；copy = 复制一包给 AI；open = 打开某页面 */
  kind: 'tap' | 'copy' | 'open';
  /**
   * kind=tap 时说明"点下去到底做什么"。前端据此分发，**不要靠 label 文本匹配** ——
   * 那样改一个字就断，而且断的时候没有任何提示（按钮还在，点了没反应）。
   */
  id?: 'recollect' | 'use-dom' | 'repick' | 'retry';
  /** kind=copy 时，复制的内容（含提示词） */
  payload?: string;
  /** kind=open 时，要打开的地址 */
  url?: string;
}

export interface FixPack {
  kind: FailureKind;
  /** 一句话说清发生了什么（不含技术名词，用户要能读懂） */
  headline: string;
  /** 用户下一步做什么（一句话，可执行） */
  nextStep: string;
  /** 要执行的动作，按优先级排列。**最多两个** —— 多了用户就不选了 */
  actions: FixAction[];
  /** AI 能修吗？修不了的时候一个 AI 包都不给（避免它编理由） */
  aiCanFix: boolean;
}

/**
 * 错误码 → 修复策略。
 *
 * 为什么不再从 `error.message` 里匹配关键词：文案是给人看的，随手改一个字
 * 就会让分类静默漂移，而漂移时**没有任何提示** —— 用户只会拿到一个错的按钮
 * （比如会话失效却出现"复制给 AI"）。分类必须挂在结构化的 code 上。
 */
export function kindOfCode(code: string | undefined): FailureKind {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
    case 'CAPTCHA_REQUIRED':
      return 'auth';
    case 'SIGNATURE_REQUIRED':
    case 'SIGNER_UNAVAILABLE':
    case 'NOT_SUPPORTED':
      return 'signature';
    case 'NETWORK':
    case 'RATE_LIMITED':
      return 'network';
    case 'SELECTOR_STALE':
      return 'dom-selector';
    case 'PARSE_EMPTY':
    case 'SCHEMA_DRIFT':
      return 'trial-empty';
    case 'UPSTREAM':
      // 上游异常（地址错 / 5xx / 响应不是预期结构）：按"配置可能写错"处理，
      // 因为这是唯一我们能修的方向。真正的网络问题会在 NETWORK 里。
      return 'trial-failed';
    case 'PROBE_EMPTY':
      return 'probe-empty';
    case 'COURSE_MISMATCH':
      return 'course-mismatch';
    default:
      return 'unknown';
  }
}

/**
 * 兼容入口：接受 HubError 或裸字符串。
 *
 * 只有带 `code` 的错误才能被准确归类；裸字符串一律 `unknown`（走保守路径，
 * 由 unknown 分支给全量诊断包）。**不要**再在这里对 message 做关键词匹配。
 */
export function classifyFailure(error: unknown): FailureKind {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return kindOfCode(code);
  return 'unknown';
}

// ──────────────────────────────────────────────────────── 结构摘要

/**
 * 把一份响应压缩成「结构」：只留键名和层级，值换成占位符。
 *
 * 为什么不给 AI 原始数据：只要它看得见作业标题，它就会去**提取作业**而不是
 * **写读取规则** —— 加多少句"你不是在提取"都没用（adapter-authoring 里记着这次实测）。
 * 看不见内容，它就只能描述怎么读。
 */
export function structureOf(body: string, maxRows = 1): string {
  try {
    const limited = limitArray(JSON.parse(body), maxRows);
    return maskBody(JSON.stringify(limited));
  } catch {
    return '(不是 JSON)';
  }
}

function limitArray(v: unknown, maxRows: number, depth = 0): unknown {
  if (depth > 6) return '<deep>';
  if (Array.isArray(v)) return v.slice(0, maxRows).map((x) => limitArray(x, maxRows, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = limitArray(val, maxRows, depth + 1);
    }
    return out;
  }
  return v;
}

/** 所有样本的结构摘要（给 AI 的"候选清单"）。带上 URL，因为配置里要填它。 */
export function summarizeSamples(samples: ProbeSample[], max = 8): string {
  const rows: string[] = [];
  for (const s of samples.slice(0, max)) {
    rows.push(`### ${s.method ?? 'GET'} ${s.url}`);
    if (s.status !== undefined) rows.push(`- 状态：${s.status}`);
    rows.push('```json');
    rows.push(structureOf(s.body, 1).slice(0, 1200));
    rows.push('```');
    rows.push('');
  }
  return rows.join('\n');
}

// ──────────────────────────────────────────────────────── 预设提示词

const RULES = [
  '硬性约束：',
  '1. 只使用材料里真实出现过的 URL 和字段名；没看到就写 null，不要按命名习惯推断。',
  '2. 只输出 JSON，不要解释、不要 markdown 代码块之外的任何文字。',
  '3. 材料里的值已被替换成 <string len=N>，你看不到作业内容 —— 这是故意的。',
  '   你的任务是「以后怎么自动读」，不是「把作业抄下来」。',
].join('\n');

/** 一个接口都没认出来：让 AI 从结构摘要里挑出作业列表那个接口。 */
export const PROMPT_PICK_ENDPOINT = `你在为一个只读的作业聚合应用**挑出作业列表接口**并写出读取规则。只输出 JSON。

${RULES}

输入是录制到的若干接口响应的结构（值已被替换）。请判断**哪一个**是"作业/任务列表"：
它的数组里每条记录应当有标题类字段，通常还有时间类或状态类字段。

输出格式：
{
  "url": "材料里出现过的完整地址",
  "listPath": "$.data.list",
  "fields": {
    "id": { "path": "id" },
    "title": { "path": "name" },
    "deadline": { "path": "endTime", "format": "epoch_ms|epoch_s|iso|custom" },
    "course": { "path": "courseName" },
    "status": { "path": "status" }
  },
  "confidence": 0.0
}

如果材料里确实没有作业列表，输出 {"need_more":["还需要看到什么页面"],"confidence":0.2}。`;

/** 地址对了但解析不出东西：只让它改路径。 */
export const PROMPT_FIX_PATHS = `你在修正一份"平台接入配置"里错掉的路径。只输出 JSON。

${RULES}
4. **只改错的地方**，其余字段原样保留 —— 不要重写、不要精简、不要换风格。
5. 报「listPath 没命中」= 列表所在的路径错了；报「标题为空」= fields.title.path 错了。

输出修好的完整配置 JSON，结构不变。`;

/** 区分「课程目录」与「课程内容」：这是识别器最容易出错、也最伤人的一处。 */
export const PROMPT_CLASSIFY_COURSE = `你在判断两个数组里哪个是"课程列表"、哪个是"课程里的资料列表"。只输出 JSON。

${RULES}
4. 判断依据只能是结构：课程列表的条目通常带教师/学期/课程号，条目数少；
   课程内容的条目常带文件名、时长、大小、章节序号。
5. 如果材料不足以判断，输出 {"need_more":["还需要看到什么"],"confidence":0.2}。

输出格式：
{ "kind": "course-list" | "course-content" | "task-list", "reason": "一句话", "confidence": 0.0 }`;

/** DOM 选择器失效：只让它改选择器。 */
export const PROMPT_FIX_DOM = `你在修正一份"页面点选"配置里错掉的选择器。只输出 JSON。

${RULES}
4. **只改选择器**（readyWhen / rows / fields.*.find），其余原样保留。
5. 报「页面打不开/没出现预期元素」= readyWhen 不对；报「抓到 0 条」= rows 不对。
6. 不要改成接口模式 —— 这个平台的数据只能从页面读。`;

// ──────────────────────────────────────────────────────── 脱敏

/**
 * URL 里像凭据的查询参数值 → ***。
 *
 * 为什么必须有、而且必须在**出口处**统一做一次：修复包是要发给外部 AI 的，
 * 而录制到的 URL 里可能带着 token / sign / ticket（页面自己拼的那种）。
 * 老路径（Java 侧 buildMarkdown）做过这件事，但它只覆盖"导出证据包"一条路；
 * 现在材料由 core 生成，如果靠在各个拼装点自觉脱敏，漏一处就是一次凭据外泄。
 * 所以收口成一个函数，在 buildFixPack 返回前对**所有** payload 跑一遍。
 */
const SECRET_PARAM =
  /([?&](token|auth|access_token|sign|signature|ticket|key|session|enc|uid|uuid|secretstr|uuidstr|nonce|timestamp|dateformate)=)[^&\s"'\\,)]*/gi;

export function maskSecrets(text: string): string {
  return String(text ?? '').replace(SECRET_PARAM, '$1***');
}

// ──────────────────────────────────────────────────────── 组装

export interface FixInput {
  /**
   * 失败的**错误码** —— 分类的唯一依据。
   *
   * 刻意不接受 `kind`：一旦两处都能决定"这是什么故障"，就必然出现
   * "同一份错误在 A 处是 auth、在 B 处是 unknown"的漂移，而漂移的代价是
   * 用户拿到一个错的按钮（会话失效却让他复制给 AI）。
   */
  code: string;
  /** 错误原文（必须有：它就是用户复制出去的最有价值的一行） */
  error?: string;
  /** 当前配置（已有时带上，AI 才能"只改错处"） */
  config?: AdapterConfig | Record<string, unknown>;
  /** 录制到的样本（来自探针失败时） */
  samples?: ProbeSample[];
  /** 平台名与站点（材料自包含需要） */
  platformName?: string;
  origin?: string;
}

/**
 * 生成修复包。
 *
 * 关键取舍：**AI 修不了的故障，一个字节都不发给 AI**。
 * 会话失效、签名参数、网络不通都是"重试/换模式/重新登录"就能解决的事，
 * 交给 AI 只会得到一段看起来合理、跑起来无效的解释，还会让用户以为是自己配置错了。
 */
export function buildFixPack(input: FixInput): FixPack {
  const pack = buildFixPackInner(input);
  // 出口统一脱敏：所有要离开设备的文本都过这一道。
  // 放在这里而不是各个分支里，是因为"漏一处"的代价是凭据外泄，而漏掉一个分支太容易了。
  return {
    ...pack,
    actions: pack.actions.map((a) => (a.payload ? { ...a, payload: maskSecrets(a.payload) } : a)),
  };
}

function buildFixPackInner(input: FixInput): FixPack {
  const kind = kindOfCode(input.code);
  const { error, config, samples } = input;
  const name = input.platformName ?? '这个平台';
  const oneLine = (error ?? '').trim().split('\n')[0]?.slice(0, 300) ?? '';

  switch (kind) {
    case 'auth':
      return {
        kind,
        headline: `${name} 的登录态已经失效了。`,
        nextStep: '回平台页面重新登录一次，再回来点同步。',
        actions: [{ label: '去重新登录', kind: 'open', url: input.origin }],
        aiCanFix: false,
      };

    case 'signature':
      return {
        kind,
        headline: `${name} 的接口要用页面现场算出来的签名，App 拿不到。`,
        nextStep: '这类平台只能从页面上读，改用「点选作业行」的方式接入。',
        actions: [{ label: '改用页面点选', kind: 'tap', id: 'use-dom' }],
        aiCanFix: false,
      };

    case 'probe-empty': {
      const pack = [
        '# 需要你判断：哪个接口是作业列表',
        '',
        PROMPT_PICK_ENDPOINT,
        '',
        '===== 以下是材料 =====',
        '',
        `- 平台：${name}`,
        `- 站点：${input.origin ?? '(未知)'}`,
        '',
        summarizeSamples(samples ?? []),
      ].join('\n');
      return {
        kind,
        headline: `没能从 ${name} 的页面里认出作业列表。`,
        nextStep: '把下面这段发给任意 AI（比如聊天 App 里），再把它的回答粘回来。',
        actions: [
          { label: '重新采集', kind: 'tap', id: 'recollect' },
          { label: '复制给 AI', kind: 'copy', payload: pack },
        ],
        aiCanFix: true,
      };
    }

    case 'trial-empty':
    case 'trial-failed': {
      const isDom = (config as { mode?: string } | undefined)?.mode === 'dom';
      const prompt = isDom ? PROMPT_FIX_DOM : PROMPT_FIX_PATHS;
      const pack = [
        '# 接入配置需要修正',
        '',
        prompt,
        '',
        '===== 以下是材料 =====',
        '',
        '## 出了什么问题',
        '',
        error ? error.slice(0, 1500) : '(没有拿到具体错误)',
        '',
        '## 当前配置',
        '',
        '```json',
        JSON.stringify(config ?? {}, null, 2),
        '```',
        '',
        ...(samples?.length
          ? ['## 接口实际返回（值已脱敏）', '', summarizeSamples(samples, 3)]
          : []),
      ].join('\n');
      return {
        kind,
        headline: isDom
          ? `${name} 的页面能打开，但没有抓到作业。`
          : `${name} 的接口访问到了，但里面的作业读不出来。`,
        nextStep: '把这段发给 AI，它会把要改的那一处指出来；粘回来就行。',
        actions: [{ label: '复制给 AI', kind: 'copy', payload: pack }],
        aiCanFix: true,
      };
    }

    case 'dom-selector': {
      const pack = [
        '# 点选规则需要修正',
        '',
        PROMPT_FIX_DOM,
        '',
        '===== 以下是材料 =====',
        '',
        '## 出了什么问题',
        '',
        error ? error.slice(0, 1000) : '(没抓到作业)',
        '',
        '## 当前配置',
        '',
        '```json',
        JSON.stringify(config ?? {}, null, 2),
        '```',
      ].join('\n');
      return {
        kind,
        headline: `${name} 的页面上没抓到作业。`,
        nextStep: '重新点选一次通常就好；还不行就把这段发给 AI。',
        actions: [
          { label: '重新点选', kind: 'tap', id: 'repick' },
          { label: '复制给 AI', kind: 'copy', payload: pack },
        ],
        aiCanFix: true,
      };
    }


    case 'network':
      // 网络与限流不需要任何解释，也不需要 AI。等一会儿、再点一次就是全部内容。
      return {
        kind: 'network',
        headline: `${name} 那边没连上（网络问题或请求太密被限流）。`,
        nextStep: '等半分钟再点一次同步；连续失败就先别反复点，平台可能会暂时限制请求。',
        actions: [{ label: '重试一次', kind: 'tap', id: 'retry' }],
        aiCanFix: false,
      };

    case 'course-mismatch':
      // 课程归属对不上时，「再采一次」大概率比让 AI 猜更快 —— 因为课程目录在**上一层页面**，
      // 而用户当时录的是课内页面。这条提示的重点是把他引导回课程列表页。
      return {
        kind,
        headline: `${name} 的课程有点对不上（可能把课程里的资料当成了课程）。`,
        nextStep: '回到这个平台的「课程列表」页（不要点进某一门课），再采集一次；只接当前这门课也可以。',
        actions: [
          { label: '重新采集', kind: 'tap', id: 'recollect' },
          {
            label: '复制给 AI',
            kind: 'copy',
            payload: [
              '# 判断这些数组是课程目录还是课程内容',
              '',
              PROMPT_CLASSIFY_COURSE,
              '',
              '===== 以下是材料 =====',
              '',
              `- 平台：${name}`,
              `- 录制页：${input.origin ?? '(未知)'}`,
              error ? `- 现象：${error.slice(0, 800)}` : '',
              '',
              '## 当前配置',
              '```json',
              JSON.stringify(config ?? {}, null, 2),
              '```',
              ...(samples?.length ? ['', '## 采集到的响应（值已脱敏）', summarizeSamples(samples, 3)] : []),
            ].join('\n'),
          },
        ],
        aiCanFix: true,
      };

    default:
      return {
        kind: 'unknown',
        headline: `${name} 出了点问题：${oneLine || '没有更多信息'}`,
        nextStep: '先把这段复制给 AI；如果它还看不出来，就重新录制一次。',
        actions: [
          {
            label: '复制给 AI',
            kind: 'copy',
            payload: [
              '# 平台接入出错了',
              '',
              `- 平台：${name}`,
              `- 错误：${oneLine || '(没有)'}`,
              '',
              '## 当前配置',
              '```json',
              JSON.stringify(config ?? {}, null, 2),
              '```',
            ].join('\n'),
          },
        ],
        aiCanFix: true,
      };
  }
}

/**
 * 注意：这里**不**引 adapter-import（那在 apps/web 里）。
 * core 是包、web 是应用，依赖只能 web → core。修复包与初始导入共用同一个
 * 容错解析器这一点由调用方保证（api.ts 里两者都走 parseImport）。
 */
