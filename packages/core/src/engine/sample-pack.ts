/**
 * 诊断样本包：把一次采集**脱敏后**固化成可重放的样本。
 *
 * 为什么必须有这个东西（这是识别器能不能持续变好的唯一前提）：
 * 现在每改一次 `probe.ts`，只能靠手写 fixture 去验证。而真实的坑几乎全部来自
 * 「真机上那一次的响应形状」—— 智慧树的 `recruitName`、课后资料列表长得像课程目录、
 * 课程 ID 被当成课程名……这些都不是想出来的，是撞出来的。
 * 没有样本库，"识别率提升了"就是一句感觉。
 *
 * 三条铁律（都对应真实教训）：
 *   1. **不含作业正文**。值一律换成 `<string len=N>`（时间/数字样例保留，否则判定不出格式）。
 *      原因：材料一旦能被读成"作业列表"，人和 AI 都会去抄内容，而不是修规则。
 *   2. **剔除身份类响应**。user/info、profile、学号、手机号这类东西对一个只读作业聚合器
 *      毫无用处，留着只有风险。
 *   3. **保留多行**（默认 3 行）。只留 1 行就没法算"这一列取值是否唯一/重复"，
 *      而课程名与标题的区别恰恰靠这个统计。
 */
import { maskBody } from './adapter-authoring.ts';
import { maskSecrets } from './diagnostics.ts';
import type { ProbeSample } from './probe.ts';

export interface SamplePack {
  schema: 1;
  platformHint: string;
  platformId?: string;
  capturedAt: string;
  context: { pageUrl: string; pageTitle: string };
  requests: Array<{ url: string; method?: string; status?: number; body: string }>;
  /** 识别结果的结构事实（条数是数字，不含任何标题正文） */
  result?: {
    taskCount: number;
    courseCount: number;
    courseName?: string;
    taskUrl?: string;
  };
  /** 用户确认识别结果后回填，作为回归判据（方案 §6） */
  expect?: { taskCount?: number; courseCount?: number; courseName?: string };
  /** 被剔除/截断的东西，测试要能检查它 */
  dropped: { url: string; reason: string }[];
}

/** 身份类响应：对作业聚合没有价值，只有隐私风险。 */
const IDENTITY_URL = /(^|\/)(user|users|profile|account|student|member)(\/|$)|userinfo|getuser/i;
/** 身份类字段：出现任何一个就把整条响应丢掉（而不是打码 —— 打码后它仍然没有用途）。 */
const IDENTITY_KEY = /^(phone|mobile|tel|idcard|idno|studentid|studentno|realname|nickname|email|address|avatar)$/i;

const MAX_REQUESTS = 30;
const MAX_BODY = 6000;
const KEEP_ROWS = 3;

function hasIdentityField(body: string): boolean {
  try {
    return scanKeys(JSON.parse(body), 0);
  } catch {
    return false;
  }
}

function scanKeys(v: unknown, depth: number): boolean {
  if (depth > 6 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.slice(0, 3).some((x) => scanKeys(x, depth + 1));
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (IDENTITY_KEY.test(k)) return true;
    if (scanKeys(val, depth + 1)) return true;
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/**
 * 构造样本包。纯函数：不写盘、不看环境，方便在测试里反复跑。
 *
 * 行数保留 3 行、值做结构脱敏，但**时间与数字样例保留** —— 否则重放时
 * `detectTimeFormat` 会全部失明，样本就失去了"能验证识别"的意义。
 */
export function buildSamplePack(input: {
  samples: ProbeSample[];
  context: { pageUrl?: string; pageTitle?: string };
  platformId?: string;
  result?: SamplePack['result'];
  now: Date;
}): SamplePack {
  const dropped: SamplePack['dropped'] = [];
  const requests: SamplePack['requests'] = [];
  const pageUrl = String(input.context.pageUrl ?? input.samples[0]?.url ?? '');
  const host = hostOf(pageUrl || input.samples[0]?.url || '');

  for (const s of input.samples) {
    if (requests.length >= MAX_REQUESTS) {
      dropped.push({ url: truncateUrl(s.url), reason: '超过单包条数上限' });
      continue;
    }
    const body = String(s.body ?? '');
    if (!/^[[{]/.test(body.trim())) {
      dropped.push({ url: truncateUrl(s.url), reason: '不是 JSON 对象/数组' });
      continue;
    }
    if (IDENTITY_URL.test(new URL(s.url, 'http://x.invalid').pathname)) {
      dropped.push({ url: truncateUrl(s.url), reason: '身份类接口' });
      continue;
    }
    if (hasIdentityField(body)) {
      dropped.push({ url: truncateUrl(s.url), reason: '含身份类字段' });
      continue;
    }
    let masked: string;
    try {
      // keepCardinality：样本库要能重放识别，"这一列有多少种不同取值"必须保住
      masked = maskBody(body, KEEP_ROWS, true);
    } catch {
      dropped.push({ url: truncateUrl(s.url), reason: 'JSON 解析失败' });
      continue;
    }
    requests.push({
      url: maskSecrets(truncateUrl(s.url)),
      ...(s.method ? { method: s.method } : {}),
      ...(s.status !== undefined ? { status: s.status } : {}),
      body: maskSecrets(masked).slice(0, MAX_BODY),
    });
  }

  return {
    schema: 1,
    platformHint: host,
    ...(input.platformId ? { platformId: input.platformId } : {}),
    capturedAt: input.now.toISOString(),
    context: {
      pageUrl: maskSecrets(pageUrl),
      pageTitle: String(input.context.pageTitle ?? '').slice(0, 120),
    },
    requests,
    ...(input.result ? { result: input.result } : {}),
    dropped,
  };
}

/** URL 太长会把包撑大，而且超长 URL 里往往就是签名参数 —— 截断 + 脱敏一起做。 */
function truncateUrl(url: string): string {
  const s = String(url ?? '');
  return s.length > 300 ? `${s.slice(0, 300)}…(len=${s.length})` : s;
}

/**
 * 样本包 → 重放用的样本数组。
 *
 * 单独抽出来是因为「写进去」和「读出来」必须是一对：如果重放时字段名对不上，
 * 样本库就变成一堆没人能用的死文件 —— 而且不会有任何报错提示。
 */
export function samplesFromPack(pack: SamplePack): ProbeSample[] {
  return (pack.requests ?? []).map((r) => ({
    url: r.url,
    ...(r.method ? { method: r.method } : {}),
    ...(r.status !== undefined ? { status: r.status } : {}),
    body: r.body,
  }));
}

/** 落盘/存档用：一个平台一个键，保留最近 N 份（避免手机端无限增长）。 */
export function packStorageKey(platformId: string): string {
  return `sample:${platformId}`;
}

export function appendPackHistory(prev: string | undefined, pack: SamplePack, keep = 3): SamplePack[] {
  let list: SamplePack[] = [];
  if (prev) {
    try {
      const v = JSON.parse(prev) as unknown;
      if (Array.isArray(v)) list = v as SamplePack[];
    } catch {
      list = [];
    }
  }
  list.push(pack);
  return list.slice(-keep);
}
