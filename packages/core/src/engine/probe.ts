/**
 * 平台接入探查：把「录制到的网络响应」变成「一份能跑的接入配置」。
 *
 * 存在的理由 —— 先看两条失败路线：
 *
 *   · **靠 AI**：录制 → 证据包 → 免费模型 → 粘回 JSON。模型经常不按格式回
 *     （adapter-import.ts 里那两种格式的兼容逻辑就是为此而生），而且它得**猜**
 *     哪个接口带回了作业列表。猜错的代价是用户拿到一份跑不通的配置，还得再猜一轮。
 *   · **靠配置手写**：要求用户知道 listPath / fields.*.path —— 那等于让他自己写适配器。
 *
 * 这里换第三条路：**结构特征**。任何"页面上能显示作业列表"的平台，它背后的响应
 * 必然有同样的三样东西：一个数组、每个元素有标题、有时间。缺哪个，页面上也显示不出来。
 * 所以这件事不依赖平台知识，只依赖"数据长什么样"—— 这就是通用性的来源。
 *
 * 本模块**不发请求、不碰 AI**：纯函数，输入是录制到的响应样本，输出是候选配置 + 依据。
 * 发请求验证（试抓）在调用方做，因为那需要会话。
 */
import { getByPath } from './declarative-adapter.ts';
import type { AdapterConfig } from './declarative-adapter.ts';

/** 一条录制到的响应。body 是 JSON 文本（非 JSON 的响应不该传进来）。 */
export interface ProbeSample {
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  body: string;
}

/** 一份候选配置 + 它凭什么被选中（必须能解释，否则用户没法判断要不要信）。 */
export interface TaskCandidate {
  url: string;
  listPath: string;
  rowCount: number;
  confidence: number;
  fields: AdapterConfig['fields'];
  /** 分页（探到才给） */
  pagination?: { type: 'page'; param: string; start: number; maxPages: number };
  /** 给人看的依据：每条都能对应到样本里的具体事实 */
  evidence: string[];
  /** 已知风险（例如 URL 带签名参数 → 只能走 DOM 模式） */
  warnings: string[];
}

export interface CourseCandidate {
  url: string;
  listPath: string;
  idField: string;
  nameField: string;
  rowCount: number;
  confidence: number;
}

/** 录制时的页面上下文。判断"人当时在哪一层"比任何字段启发式都可靠。 */
export interface ProbeContext {
  pageTitle?: string;
  pageUrl?: string;
}

/** 「这份配置读完的就是这一门课」—— 录制时人已经在这门课里了。 */
export interface SingleCourseHint {
  platformCourseId: string;
  /** 从页面标题猜的课程名；猜不出就不给，让上层退回平台名（用户随时能改名） */
  name?: string;
}

export interface ProbeResult {
  tasks: TaskCandidate[];
  courses: CourseCandidate[];
  singleCourse?: SingleCourseHint;
  /** 看过但不合格的东西，以及为什么 —— 「没找到」必须是可解释的 */
  rejected: Array<{ url: string; reason: string }>;
  /** 一个候选都没有时，告诉用户下一步该做什么 */
  needsMore: string[];
}

// ──────────────────────────────────────────────────────────── 字段语义识别

// 标题列：平台很少直接把字段叫 `name` —— 智慧树叫 `recruitName`、超星叫 `workName`。
// 所以按**后缀**认（xxxName / xxxTitle），而不是要求精确等于 name。
const TITLE_KEY = /(?:name|title)$|^(?:标题|名称|题目|作业名|内容)$/i;
const DEADLINE_KEY = /(deadline|endtime|endat|enddate|dueat|duedate|expire|expiretime|close|closetime|截止|结束|限时)/i;
const STATUS_KEY = /^(status|state|statuscode|statusname|状态|完成状态)$/i;
const COURSE_KEY = /(course|class|subject|课程|班级|科目)/i;
const ID_KEY = /(^id$|_id$|id$|uuid|key)/i;
const PAGE_PARAM = /^(page|pageindex|pageno|pagenum|offset|start)$/i;

/**
 * 这个名字像不像**课程名**。
 *
 * 两个必须挡住的（真机 2026-10-27 的实际输出）：
 *   · 纯数字 `11430986` —— 那是课程 ID 被当成名字用了
 *   · `大型歌舞剧《孔子》.mp4` —— 那是课程里的**资料文件**，不是课程
 * 只要出现这两种之一，就说明这个字段是"内容"，不是"课程"。
 */
export function looksLikeCourseName(v: unknown): boolean {
  const s = String(v ?? '').trim();
  if (s.length < 1) return false;
  if (/^\d+$/.test(s)) return false;
  if (/\.(mp4|mp3|m4a|pdf|docx?|pptx?|xlsx?|zip|rar|7z|txt|md|png|jpe?g|gif|wav|avi|mov)$/i.test(s)) return false;
  return true;
}

/**
 * 从页面标题里猜课程名：`舞蹈欣赏 - 智慧树` → `舞蹈欣赏`。
 *
 * 猜不出就返回 undefined —— 宁可让课程显示成平台名（用户能改名），
 * 也不要拿"在线学堂"这种站点标语当课程名，那会让他更困惑。
 */
export function courseNameFromTitle(title: unknown, platformName?: string): string | undefined {
  const raw = String(title ?? '').trim();
  if (!raw) return undefined;
  const head = raw.split(/\s*[-_|｜—–]\s*/)[0]?.trim() ?? '';
  if (!head || head.length > 40) return undefined;
  if (/^(课程|作业|任务|首页|学习|登录|我的|在线学堂|智慧树|超星|雨课堂)$/i.test(head)) return undefined;
  if (platformName && head.toLowerCase() === platformName.toLowerCase()) return undefined;
  return looksLikeCourseName(head) ? head : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 认得出就说得出它是什么格式 —— 这决定配置里 deadline.format 写什么。 */
export function detectTimeFormat(v: unknown): 'epoch_s' | 'epoch_ms' | 'iso' | 'custom' | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? 'epoch_ms' : 'epoch_s';
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/^\d{10}$/.test(s)) return 'epoch_s';
  if (/^\d{13}$/.test(s)) return 'epoch_ms';
  if (/^\d{4}-\d{1,2}-\d{1,2}T\d{2}:\d{2}/.test(s)) return 'iso';
  // 「2025-12-07 23:25」这类本地时间写法（超星 / 长江都长这样）
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2})?/.test(s)) return 'custom';
  return undefined;
}

/** 这个值像不像一个真实时刻（挡掉 0 / 1 / 1970 / 3000 年这类占位值）。 */
function looksLikeRealTime(v: unknown): boolean {
  const fmt = detectTimeFormat(v);
  if (!fmt) return false;
  const ms =
    fmt === 'epoch_s'
      ? Number(v) * 1000
      : fmt === 'epoch_ms'
        ? Number(v)
        : new Date(String(v).replace(/\//g, '-')).getTime();
  if (!Number.isFinite(ms)) return false;
  const y = new Date(ms).getUTCFullYear();
  return y >= 2015 && y <= 2100;
}

// ──────────────────────────────────────────────────────────── 数组发现

/** 在一份 JSON 里找出所有"对象数组"，附带它所在的路径。深度限制防止钻进巨型渲染树。 */
function findArrays(root: unknown, maxDepth = 4): Array<{ path: string; rows: unknown[] }> {
  const out: Array<{ path: string; rows: unknown[] }> = [];
  const walk = (node: unknown, path: string, depth: number, keyName: string) => {
    if (depth > maxDepth) return;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every(isPlainObject)) {
        out.push({ path: path || '$', rows: node });
      }
      // 数组里套数组（少数平台会包一层）
      if (node.length > 0) walk(node[0], `${path}[0]`, depth + 1, keyName);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) || isPlainObject(v)) walk(v, path ? `${path}.${k}` : k, depth + 1, k);
    }
  };
  walk(root, '', 0, '');
  return out;
}

/** 一列值的统计：用来判断"这列是不是分类值"（课程/状态）还是"这列是不是唯一值"（ID）。 */
function columnStats(rows: Array<Record<string, unknown>>, key: string) {
  const vals = rows.map((r) => r[key]);
  const filled = vals.filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const uniq = new Set(filled.map((v) => String(v)));
  const timeHit = filled.filter(looksLikeRealTime).length;
  // 「像名字」的比例：用来排除纯 ID 列和文件名列（它们不能当课程名/标题）
  const nameHit = filled.filter(looksLikeCourseName).length;
  return {
    key,
    filled: filled.length,
    total: rows.length,
    uniq: uniq.size,
    timeRatio: filled.length > 0 ? timeHit / filled.length : 0,
    nameRatio: filled.length > 0 ? nameHit / filled.length : 0,
    sample: filled[0],
  };
}

/**
 * URL 本身是不是明说「这是作业接口」。
 *
 * **只按路径分段判断**，不在整条 URL 上做裸正则 —— 踩过：域名 example.edu
 * 里的 "exam" 会让 `/exam/i` 命中，于是一张 {id, name} 的课程表被判成作业列表。
 */
function urlHintsTasks(url: string): boolean {
  if (/作业|任务|考试/.test(url)) return true;
  let path = url;
  try {
    path = new URL(url, 'http://x.invalid').pathname;
  } catch {
    /* 解析不了就用原串 */
  }
  return path
    .split('/')
    .some((seg) => /^(homeworks?|tasks?|exams?|works?|assignments?|todos?)$/i.test(seg));
}

/**
 * 认出「任务列表」并用它的结构拼出字段映射。
 *
 * 打分刻意简单可读 —— 它是给人解释的，不是黑箱。每条加分都能说成一句人话。
 */
function scoreTaskList(rows: Array<Record<string, unknown>>, url: string, path: string, evidence: string[], warnings: string[]): TaskCandidate | undefined {
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length < 2) return undefined; // 只有一个字段的数组不可能是作业列表
  const cols = keys.map((k) => columnStats(rows, k));

  // 标题：名字像标题，且是"几乎每行都有、内容各不相同"的字符串列
  const titleCol = cols
    .filter((c) => TITLE_KEY.test(c.key) && c.filled === c.total && c.uniq >= Math.min(2, rows.length))
    .sort((a, b) => b.uniq - a.uniq)[0];
  if (!titleCol) return undefined; // 没有标题列 → 不可能是作业列表，这就是判据
  evidence.push(`${rows.length} 条记录，标题字段是 \`${titleCol.key}\`（例如「${String(titleCol.sample).slice(0, 24)}」）`);

  // 截止时间：优先名字像时间的列；否则退回"值几乎都能解析成时刻"的列
  const deadlineCol =
    cols.find((c) => DEADLINE_KEY.test(c.key) && c.timeRatio >= 0.6) ??
    cols.filter((c) => c.timeRatio >= 0.8).sort((a, b) => b.timeRatio - a.timeRatio)[0];
  const timeFormat = deadlineCol ? detectTimeFormat(deadlineCol.sample) : undefined;
  if (deadlineCol && timeFormat) {
    evidence.push(`截止时间字段 \`${deadlineCol.key}\`，格式 ${timeFormat}`);
  } else {
    // 不是失败：平台可能真没有截止时间。但必须说出来 —— 否则用户会以为
    // 「为什么这些作业都没有提醒」，而系统什么都没告诉他。
    warnings.push('没找到可用的截止时间字段 —— 这些作业不会按时间提醒');
  }

  // 状态：取值少、名字像状态
  const statusCol = cols.find((c) => STATUS_KEY.test(c.key) && c.filled > 0 && c.uniq <= 12);

  // 决定性判据：**只有 id + name 两张列的表不是作业列表，是课程列表**。
  // 作业必然带"什么时候交"或"交没交"，两者都没有的 {id, name} 表，
  // 最合理的解释就是课程（真机上这种响应几乎每个平台都有）。
  // 例外：URL 本身就写着 homework / task / 作业 —— 那平台连时间都不给，
  // 属于"作业但没法提醒"，仍然要认出来（否则用户看到的是"什么都没探到"）。
  const looksLikeTasks = Boolean(deadlineCol) || Boolean(statusCol) || urlHintsTasks(url);
  if (!looksLikeTasks) return undefined;
  if (statusCol) evidence.push(`状态字段 \`${statusCol.key}\`（${statusCol.uniq} 种取值）`);

  // ID：唯一值、名字像 ID。
  // 兜底（没有 ID 命名的列）时**必须排除标题列** —— 标题通常也唯一，
  // 拿它当主键的后果是「老师改了作业名，App 里就多出一条新作业」。
  const idCol =
    cols.filter((c) => ID_KEY.test(c.key) && c.filled === c.total && c.uniq === rows.length)[0] ??
    cols.filter((c) => c.filled === c.total && c.uniq === rows.length && c.key !== titleCol.key)[0];
  if (idCol) evidence.push(`主键字段 \`${idCol.key}\``);
  else warnings.push('没有唯一主键 —— 任务靠"标题指纹"识别，标题改了会被当成新作业');

  // 课程：名字像课程；名字不像就看"取值少且重复出现"的字符串列。
  // 兜底时必须排掉状态列 —— 状态同样"取值少"，拿它当课程会得到一门叫"未完成"的课。
  const courseNameCol =
    cols.find((c) => COURSE_KEY.test(c.key) && c.filled > 0 && c.nameRatio >= 0.8 && c.key !== idCol?.key) ??
    cols
      .filter(
        (c) =>
          c.uniq > 1 &&
          c.uniq <= Math.max(2, Math.ceil(rows.length / 2)) &&
          typeof c.sample === 'string' &&
          String(c.sample).trim().length >= 2 &&
          // 兜底列也必须是"像名字"的：否则一门课会变成「11430986」或「xxx.mp4」
          c.nameRatio >= 0.8 &&
          !detectTimeFormat(c.sample) &&
          c.key !== statusCol?.key &&
          c.key !== idCol?.key,
      )
      .sort((a, b) => a.uniq - b.uniq)[0];
  if (courseNameCol) {
    evidence.push(
      courseNameCol.key !== undefined && COURSE_KEY.test(courseNameCol.key)
        ? `课程字段 \`${courseNameCol.key}\``
        : `课程字段推断为 \`${courseNameCol.key}\`（取值集中，像分类而不是标题）`,
    );
  } else {
    warnings.push('没找到课程字段 —— 所有作业会归到一条"平台名"的课程下');
  }

  // 课程 ID：有课程名之外，再找一个取值少的 ID 列（可选，有就更好）
  const courseIdCol = cols.find(
    (c) =>
      ID_KEY.test(c.key) &&
      c.key !== idCol?.key &&
      c.key !== courseNameCol?.key &&
      c.uniq <= Math.max(2, Math.ceil(rows.length / 2)) &&
      c.uniq < rows.length,
  );

  const fields: AdapterConfig['fields'] = {
    title: { path: titleCol.key },
    ...(idCol ? { id: { path: idCol.key } } : {}),
    ...(deadlineCol && timeFormat ? { deadline: { path: deadlineCol.key, format: timeFormat } } : {}),
    ...(statusCol ? { status: { path: statusCol.key } } : {}),
    ...(courseNameCol
      ? { course: { path: courseNameCol.key, ...(courseIdCol ? { idPath: courseIdCol.key } : {}) } }
      : {}),
  };

  // 置信度：标题列是硬门槛（没有就 return 了），其余按"探到几样"给分
  let confidence = 0.4;
  if (deadlineCol && timeFormat) confidence += 0.25;
  if (statusCol) confidence += 0.1;
  if (idCol) confidence += 0.1;
  if (courseNameCol) confidence += 0.1;
  if (rows.length >= 3) confidence += 0.05;

  // 签名参数：配置能描述请求，但描述不了"页面现算的签名" —— 这条必须提前说清
  if (/\$?\{[^}]*(uuid|sign|token|nonce|timestamp|dateformate)[^}]*\}/i.test(url) ||
      /[?&](key|uuid|sign|signature|token|nonce|timestamp|dateformate|secretstr)=/i.test(url)) {
    warnings.push('这个接口带动态签名参数（页面现算），API 模式跑不通，要走 DOM 模式');
    confidence = Math.min(confidence, 0.3);
  }

  // 分页：URL 里已经有 page 类参数 → 说明还有下一页；把参数名抄下来
  const pageParam = (() => {
    try {
      const u = new URL(url);
      for (const k of u.searchParams.keys()) if (PAGE_PARAM.test(k)) return k;
    } catch {
      /* 相对地址解析不了就算了 */
    }
    return undefined;
  })();

  return {
    url,
    listPath: path === '$' ? '$' : `$.${path}`,
    rowCount: rows.length,
    confidence: Math.round(confidence * 100) / 100,
    fields,
    ...(pageParam ? { pagination: { type: 'page' as const, param: pageParam, start: 0, maxPages: 20 } } : {}),
    evidence,
    warnings,
  };
}

/** 认出「课程列表」：id + name 两列，且没有时间列（有时间列就更像作业）。 */
function scoreCourseList(rows: Array<Record<string, unknown>>, url: string, path: string): CourseCandidate | undefined {
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length < 2) return undefined;
  const cols = keys.map((k) => columnStats(rows, k));
  const nameCol = cols.find(
    (c) => TITLE_KEY.test(c.key) && c.filled === c.total && c.uniq >= Math.min(2, rows.length) && c.nameRatio >= 0.8,
  );
  const idCol = cols.find((c) => ID_KEY.test(c.key) && c.uniq === rows.length);
  if (!nameCol || !idCol) return undefined;
  // 有时间列 → 更可能是作业，别抢
  if (cols.some((c) => c.timeRatio >= 0.6)) return undefined;
  return {
    url,
    listPath: path === '$' ? '$' : `$.${path}`,
    idField: idCol.key,
    nameField: nameCol.key,
    rowCount: rows.length,
    confidence: nameCol.uniq > 1 ? 0.7 : 0.5,
  };
}

// ──────────────────────────────────────────────────────────── 入口

/**
 * 分析一批录制到的响应。
 *
 * 返回**排序后的候选**，而不是"唯一答案"：探错的代价是用户白点一次，
 * 而假装确定会让他失去判断依据。每份候选都带 evidence（凭什么）和 warnings（哪里还虚）。
 */
export function analyzeSamples(samples: ProbeSample[], ctx: ProbeContext = {}, limit = 3): ProbeResult {
  const tasks: TaskCandidate[] = [];
  const courses: CourseCandidate[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];

  // 人当时在哪一层？这是**唯一**不需要猜的信息 —— 它就在地址里。
  //
  // 为什么它决定课程维度（真机 2026-10-27 的故障）：用户在「舞蹈欣赏」的作业列表页
  // 点了回应用，页面上那些带 id + name 的列表是**这门课的内容**（芭蕾舞、某个 .mp4…），
  // 结构上和"课程列表"一模一样。按结构判，它们就会被认成 4 门课。
  // 而地址里的 courseId 明确说了"你在这门课里"—— 此时课程有且只有一门。
  const anchorId = guessDefaultCourseId(ctx.pageUrl ?? samples[0]?.url ?? '');

  for (const s of samples) {
    let json: unknown;
    try {
      json = JSON.parse(s.body);
    } catch {
      rejected.push({ url: s.url, reason: '不是合法 JSON' });
      continue;
    }
    const arrays = findArrays(json);
    if (arrays.length === 0) {
      rejected.push({ url: s.url, reason: '里面没有对象数组（不像列表接口）' });
      continue;
    }
    let hit = false;
    for (const a of arrays) {
      const rows = a.rows as Array<Record<string, unknown>>;
      const t = scoreTaskList(rows, s.url, a.path, [], []);
      if (t) {
        if (anchorId) t.evidence.push(`录制页在某一门课内（课程 ID ${anchorId}），这些作业都归到这门课`);
        tasks.push(t);
        hit = true;
      } else if (!anchorId) {
        // 课内录制的页面上不存在"课程列表"，任何像课程表的数组都是课程内容 —— 不认
        const c = scoreCourseList(rows, s.url, a.path);
        if (c) {
          courses.push(c);
          hit = true;
        }
      }
    }
    if (!hit) rejected.push({ url: s.url, reason: '有数组，但没有任何一条像作业或课程（缺标题列）' });
  }

  // 同一份 URL 的多个候选只留最好的那条（否则用户在列表里看到三个一模一样的地址）
  const dedupe = <T extends { url: string; confidence: number }>(list: T[]): T[] => {
    const best = new Map<string, T>();
    for (const x of list) {
      const prev = best.get(x.url);
      if (!prev || x.confidence > prev.confidence) best.set(x.url, x);
    }
    return [...best.values()].sort((a, b) => b.confidence - a.confidence);
  };

  const topTasks = dedupe(tasks).slice(0, limit);
  const topCourses = dedupe(courses).slice(0, limit);

  const needsMore: string[] = [];
  if (topTasks.length === 0) {
    needsMore.push('没认出作业列表接口。请在平台上把"作业列表"那一页完整翻一遍再导出（列表要真的显示出来）。');
    if (rejected.length > 0) {
      needsMore.push(`看过的 ${rejected.length} 个响应都不像列表接口（比如只有用户信息、菜单、配置）。`);
    }
  }
  const name = anchorId ? courseNameFromTitle(ctx.pageTitle) : undefined;
  return {
    tasks: topTasks,
    // 课内录制 → 课程就是那一门，不参与"从响应里认课程"（那只会认成内容）
    courses: anchorId ? [] : topCourses,
    ...(anchorId ? { singleCourse: { platformCourseId: anchorId, ...(name ? { name } : {}) } } : {}),
    rejected,
    needsMore,
  };
}

/**
 * 把候选 + 平台信息拼成可以直接喂给 `DeclarativeAdapter` 的配置。
 *
 * 与 analyze 分开，是为了让「分析」保持纯函数：同一批样本可以反复分析，
 * 用户选哪份候选、平台叫什么名字，都是之后单独的一步。
 */
export function buildConfig(
  candidate: TaskCandidate,
  opts: {
    key: string;
    name: string;
    origin: string;
    courses?: CourseCandidate;
    probeUrl?: string;
    singleCourse?: SingleCourseHint;
  },
): AdapterConfig {
  // 锚点模式下**不要**按任务行切课程：那些"课程名"其实是课程内容的名字。
  const fields = { ...candidate.fields };
  if (opts.singleCourse) delete fields.course;

  return {
    key: opts.key,
    name: opts.name,
    origin: opts.origin.replace(/\/$/, ''),
    ...(opts.probeUrl ? { probe: { url: opts.probeUrl, expectStatus: 200 } } : {}),
    ...(opts.courses && !opts.singleCourse
      ? {
          courses: {
            url: opts.courses.url,
            listPath: opts.courses.listPath,
            idField: opts.courses.idField,
            nameField: opts.courses.nameField,
          },
        }
      : {}),
    ...(opts.singleCourse
      ? {
          defaultCourseId: opts.singleCourse.platformCourseId,
          ...(opts.singleCourse.name ? { courseName: opts.singleCourse.name } : {}),
        }
      : {}),
    tasks: {
      url: candidate.url,
      listPath: candidate.listPath,
      ...(candidate.pagination ? { pagination: candidate.pagination } : {}),
    },
    fields,
    confidence: candidate.confidence,
  };
}

/** 供调用方快速判断「这份配置能不能直接用」—— 缺标题就没法显示，直接判死。 */
export function configIsUsable(cfg: AdapterConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!cfg.tasks?.url) missing.push('作业列表接口');
  if (!cfg.fields?.title?.path) missing.push('标题字段');
  return { ok: missing.length === 0, missing };
}

/** 从一份 URL 里抽出课程 ID（`?courseId=11430986` 这类）—— 试抓单个课程页面时常需要。 */
export function guessDefaultCourseId(url: string): string | undefined {
  const m = /[?&](courseId|course_id|classId|class_id|cid)=([A-Za-z0-9_-]{3,})/.exec(url);
  return m?.[2];
}

/** 让 listPath 对 result 包了几层的平台也能用（少数平台把数据放在 `$.data` 之外）。 */
export function rowPathHint(cfg: AdapterConfig): string {
  return cfg.tasks.listPath ?? '$.data';
}

export { getByPath };
