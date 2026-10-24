/**
 * 声明式适配器：把「用户/AI 给的配置 JSON」变成一个真正的 PlatformAdapter。
 *
 * 这是「自己加平台」能不能成立的关键 —— 一旦它实现了 PlatformAdapter，
 * 自定义平台就和超星 / iSmart 走**完全相同的链路**：同步、合并、三态、提醒、变更历史，
 * 上层一行代码都不用改。
 *
 * 刻意不做的事（做了会变成不可靠的通用爬虫引擎）：
 *   - 不执行任何 JS（配置里没有代码，只有路径和 URL 模板）
 *   - 不支持 POST（只读；这是这个应用从第一天起的安全边界）
 *   - 不支持需要签名的接口（enc / sign 这类，原理上做不稳 —— 超星已经证明过）
 */
import type {
  AdapterCapabilities,
  AdapterContext,
  AuthMethod,
  FetchCoursesRequest,
  FetchTasksRequest,
  Page,
  PlatformAdapter,
} from '../ports/adapter.ts';
import type { PlatformCourse } from '../domain/course.ts';
import type { PlatformTask, TaskStatus } from '../domain/task.ts';
import type { Credentials, Session } from '../ports/vault.ts';
import type { ReadOnlyPolicy } from '../ports/read-only.ts';
import { HubError } from '../domain/errors.ts';
import { SessionHttpClient } from '../engine/session-http.ts';


/** 配置的形状。字段全部可选，缺失就按"没有这个能力"处理，而不是猜。 */
export interface AdapterConfig {
  /** 平台标识（生成 platformId 用），只允许小写字母数字与短横线 */
  key: string;
  name: string;
  origin: string;
  probe?: { url?: string; expectStatus?: number; note?: string };
  courses?: { url?: string; listPath?: string; idField?: string; nameField?: string };
  tasks: {
    url: string;
    listPath?: string;
    pagination?: { type?: string; param?: string; start?: number; maxPages?: number };
  };
  fields: {
    id?: { path?: string };
    title?: { path?: string };
    deadline?: { path?: string; format?: string };
    course?: { path?: string };
    status?: { path?: string; values?: Record<string, string>; usableForCompletion?: boolean };
  };
  link?: { type?: string; value?: string };
  confidence?: number;
}

/** JSON 路径取值：支持 `$.a.b`、`a.b`、`a[0].b`。取不到返回 undefined（不抛）。 */
export function getByPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  const clean = path.replace(/^\$\.?/, '').trim();
  if (!clean) return obj;
  const parts = clean
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 把配置里的状态映射成这个应用的状态。认不出就一律 pending（不假装完成）。 */
export function mapStatus(
  raw: unknown,
  cfg: AdapterConfig['fields']['status'],
): TaskStatus {
  if (cfg?.usableForCompletion === false) return 'pending';
  const v = String(raw ?? '');
  if (!v) return 'pending';
  // 配置里显式给了映射表，优先用它
  const mapped = cfg?.values?.[v];
  const label = String(mapped ?? v);
  if (/(已完成|已交|已提交|已批|待批阅|阅卷中|已迟交)/.test(label)) return 'submitted';
  if (/(过期|已结束|已关闭)/.test(label)) return 'expired';
  return 'pending';
}

/** 时间归一化：认得数字(秒/毫秒)、ISO、以及「2025-12-07 23:25」这类本地时间写法。 */
function toIso(v: unknown, format?: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') {
    const ms = format === 'epoch_s' || v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 23), Number(m[5] ?? 59));
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}


export class DeclarativeAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;
  readonly #cfg: AdapterConfig;
  readonly #origin: string;

  readonly capabilities: AdapterCapabilities = {
    courses: false,
    tasks: true,
    exams: false,
    // 没有增量接口：每轮都重新拉列表。配置里没有"游标"这个概念，别假装有。
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };

  readonly authMethods: AuthMethod[];

  readonly readOnlyPolicy: ReadOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };

  readonly sessionExpiryCauses = [
    '这个平台的登录态靠 cookie 维持，长时间不用会过期',
    '你在别处退出登录，或换了账号',
  ];

  constructor(cfg: AdapterConfig) {
    this.#cfg = cfg;
    this.#origin = String(cfg.origin ?? '').replace(/\/$/, '');
    this.id = `custom-${cfg.key}`;
    this.displayName = cfg.name || cfg.key;
    this.homepage = this.#origin;
    this.authMethods = [
      {
        id: 'in-app',
        label: '应用内登录',
        kind: 'in-app',
        fields: [],
        loginUrl: this.#origin || 'about:blank',
        hint: '在这个窗口里用你自己的方式登录，登录完成后返回应用即可。',
      },
    ];
  }

  /** 配置本身（导出/编辑用）。 */
  get config(): AdapterConfig {
    return this.#cfg;
  }

  #abs(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `${this.#origin}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  async login(ctx: AdapterContext, _cred: Credentials): Promise<Session> {
    // 会话就是 cookie，由系统 CookieManager 保管；这里只声明来源。
    return {
      platformId: this.id,
      accountId: '',
      origin: 'imported',
      cookies: {},
      headers: {},
      issuedAt: ctx.clock.now().toISOString(),
    };
  }

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const url = this.#cfg.probe?.url ?? this.#cfg.tasks.url;
    if (!url) return true;
    const http = new SessionHttpClient(ctx, session);
    try {
      const res = await http.getJson<unknown>(this.#abs(url));
      const want = this.#cfg.probe?.expectStatus ?? 200;
      return res.status === want;
    } catch (e) {
      if (e instanceof HubError && (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_FAILED')) return false;
      throw e;
    }
  }

  async fetchCourses(
    ctx: AdapterContext,
    session: Session,
    _req?: FetchCoursesRequest,
  ): Promise<Page<PlatformCourse>> {
    // 没有配置课程接口 → 给一个虚拟课程，保证任务有地方挂。
    // 硬要塞进"未分类"会让人在课程页找不到它。
    if (!this.#cfg.courses?.url) {
      return {
        items: [{ platformCourseId: '__default', name: this.displayName }],
        hasMore: false,
      };
    }
    const http = new SessionHttpClient(ctx, session);
    const res = await http.getJson<unknown>(this.#abs(this.#cfg.courses.url));
    const list = getByPath(res.body, this.#cfg.courses.listPath ?? '$.data');
    if (!Array.isArray(list)) {
      throw new HubError('UPSTREAM', `${this.displayName}：课程列表取不到（配置里的 listPath 可能不对）`, {
        platformId: this.id,
      });
    }
    const items: PlatformCourse[] = [];
    for (const row of list) {
      const id = getByPath(row, this.#cfg.courses.idField ?? 'id');
      const name = getByPath(row, this.#cfg.courses.nameField ?? 'name');
      if (id === undefined || name === undefined) continue;
      items.push({ platformCourseId: String(id), name: String(name) });
    }
    return { items, hasMore: false, declaredTotal: items.length };
  }

  /**
   * 替换 URL 里的 `{var}` / `${var}` 占位符。
   *
   * 支持 `{pageIndex}`（当前页码）与 `{courseId}`（配置里的 defaultCourseId）。
   * 拿不到 courseId 时**宁可报错也不发一个 courseId 空值** ——
   * 空值会返回空列表，用户会以为"这个平台没作业"，其实是配置没填全。
   */
  #applyVars(raw: string, page: number): string {
    let out = raw.replace(/\$?\{pageIndex\}/g, String(page)).replace(/\$?\{page\}/g, String(page));
    const cid = String((this.#cfg as unknown as { defaultCourseId?: string }).defaultCourseId ?? '');
    if (/\$?\{courseId\}/.test(out)) {
      if (!cid) {
        throw new HubError(
          'UPSTREAM',
          `${this.displayName}：这个接口需要课程 ID，但配置里没给（在配置里加 "defaultCourseId"，或把占位符换成具体值）`,
          { platformId: this.id, requiresUserAction: true },
        );
      }
      out = out.replace(/\$?\{courseId\}/g, encodeURIComponent(cid));
    }
    return out;
  }

  async fetchTasks(ctx: AdapterContext, session: Session, _req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    const http = new SessionHttpClient(ctx, session);
    const cfg = this.#cfg;
    const items: PlatformTask[] = [];
    const notes: string[] = [];

    const pag = cfg.tasks.pagination ?? {};
    const maxPages = Math.min(Math.max(1, Number(pag.maxPages ?? 1)), 20);
    const start = Number(pag.start ?? 0);
    let declaredTotal: number | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const pageValue = start + page;
      let url = this.#abs(this.#applyVars(cfg.tasks.url, pageValue));
      // 配置里已经带了分页参数就不重复拼；没带才追加。
      if (pag.type === 'page' && pag.param && !url.includes(`${pag.param}=`)) {
        url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(pag.param)}=${pageValue}`;
      }
      const res = await http.getJson<unknown>(url);
      const list = getByPath(res.body, cfg.tasks.listPath ?? '$.data');
      if (!Array.isArray(list)) {
        // 关键区分：拿不到数组 ≠ 没有作业。前者是配置/改版问题，必须报错。
        // 带上响应片段：没有它，AI（和人）都判断不出是「接口地址错了」还是「字段路径写错了」。
        // 这是「让 AI 自己修配置」能不能成立的前提 —— 诊断包必须自带证据。
        const peek = JSON.stringify(res.body ?? null).slice(0, 600);
        throw new HubError(
          'UPSTREAM',
          `${this.displayName}：作业列表取不到（listPath「${cfg.tasks.listPath ?? '$.data'}」没命中）。接口返回：${peek}`,
          { platformId: this.id, requiresUserAction: true },
        );
      }
      if (declaredTotal === undefined && typeof getByPath(res.body, '$.total') === 'number') {
        declaredTotal = getByPath(res.body, '$.total') as number;
      }
      if (list.length === 0) break;

      for (const row of list) {
        const idRaw = getByPath(row, cfg.fields.id?.path ?? 'id');
        const titleRaw = getByPath(row, cfg.fields.title?.path ?? 'title');
        if (titleRaw === undefined || String(titleRaw).trim() === '') continue;
        const courseName = cfg.fields.course?.path
          ? String(getByPath(row, cfg.fields.course.path) ?? '')
          : this.displayName;
        const statusRaw = cfg.fields.status?.path ? getByPath(row, cfg.fields.status.path) : undefined;
        items.push({
          platformTaskId: idRaw === undefined ? undefined : String(idRaw),
          courseId: '__default',
          courseName: courseName || this.displayName,
          kind: 'homework',
          title: String(titleRaw).trim(),
          status: mapStatus(statusRaw, cfg.fields.status),
          deadline: cfg.fields.deadline?.path
            ? toIso(getByPath(row, cfg.fields.deadline.path), cfg.fields.deadline.format)
            : undefined,
          ...(cfg.link?.type === 'href' && cfg.link.value
            ? { sourceUrl: this.#abs(String(getByPath(row, cfg.link.value) ?? '')) }
            : {}),
        });
      }
      // 只有 page 且明确要多页时才继续；否则一页就够
      if (pag.type !== 'page' || !pag.param) break;
    }

    if (items.length === 0 && (declaredTotal ?? 0) > 0) {
      notes.push(`平台说共有 ${declaredTotal} 条，但一条也没解析出来 —— 字段映射可能对不上了`);
    }
    return {
      items,
      hasMore: false,
      ...(declaredTotal !== undefined ? { declaredTotal } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  buildTaskUrl(_courseId: string, task: PlatformTask): string | undefined {
    return task.sourceUrl;
  }
}

/**
 * 把 AI 给的配置**摊平**成内部用的形状。
 *
 * AI 按提示词输出的是 { platform: { name, origin }, tasks, fields }，
 * 而内部要用的是 { key, name, origin, ... }。更关键的是：**key 从来不是提示词要求的字段**，
 * 之前把它当必填校验，等于把所有正确的配置都拒了（真机 2026-10-23 就是这么卡住的）。
 * 所以 key 一律由这里派生，用户/AI 都不用管。
 */
export function normalizeAdapterConfig(raw: unknown): AdapterConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const platform = (o.platform && typeof o.platform === 'object' ? o.platform : {}) as Record<string, unknown>;
  const name = String(platform.name ?? o.name ?? '未命名平台').trim();
  const origin = String(platform.origin ?? o.origin ?? '').trim();

  // key 从域名派生（zhihuishu.com → zhihuishu），拿不到就退回名字的 ASCII 部分
  let key = '';
  try {
    const host = new URL(origin).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    key = (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) ?? '';
  } catch {
    key = '';
  }
  key = key.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!key) {
    key = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  }
  if (!key) key = `p${Math.abs(hashCode(name || origin)).toString(36)}`;

  // AI 常见的笔误：把课程 ID 参数写成了页码占位符（courseId={pageIndex}）。
  // 那会请求到一个完全不存在的课程，返回空列表，用户以为"平台没作业"。
  const tasks = { ...((o.tasks ?? { url: '' }) as AdapterConfig['tasks']) };
  if (typeof tasks.url === 'string') {
    tasks.url = tasks.url.replace(
      /([?&]courseId=)(?:\0\{pageIndex\}|\0\{page\})/gi,
      '\{courseId\}',
    );
  }

  return {
    ...(o as unknown as AdapterConfig),
    key,
    name,
    origin,
    tasks,
    fields: (o.fields ?? {}) as AdapterConfig['fields'],
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 粗略校验一份配置够不够跑起来。返回缺失项（空数组 = 可用）。 */
export function validateConfig(cfg: unknown): string[] {
  const missing: string[] = [];
  const c = cfg as Partial<AdapterConfig> | null;
  if (!c || typeof c !== 'object') return ['配置不是一个对象'];
  // 只校验"没有它就跑不起来"的两项。name/origin 由 normalize 兜底，key 由域名派生 ——
  // 它们不是 AI 该负责的东西，卡在这上面等于把正确的配置拒之门外。
  // DOM 模式没有 tasks，改校验页面地址与行选择器
  if ((c as { mode?: string }).mode === 'dom') {
    if (!(c as { url?: string }).url) missing.push('url（要加载的页面地址）');
    if (!(c as { rows?: string }).rows) missing.push('rows（每一行作业的选择器）');
    const flds = (c as { fields?: Record<string, unknown> }).fields;
    if (!flds || !flds.title) missing.push('fields.title（作业标题的选择器）');
    return missing;
  }
  if (!c.tasks || typeof c.tasks !== 'object') missing.push('tasks');
  else if (!(c.tasks as { url?: string }).url) missing.push('tasks.url');
  if (!c.fields || typeof c.fields !== 'object') missing.push('fields');
  else {
    if (!c.fields.title?.path) missing.push('fields.title.path');
    if (!c.fields.id?.path) missing.push('fields.id.path');
  }
  return missing;
}

// ---------------------------------------------------------------- DOM 模式

/**
 * 提取函数：由宿主注入（Android 端通过桥调用离屏 WebView）。
 *
 * 为什么用模块级注入而不是加进构造参数：core 不该知道 Android 的存在。
 * engine / adapter 全在 core 里，把它们都加上一个 dom 参数，等于让每个
 * 实例化点（server、android、测试）都关心一个只有手机端才有的能力。
 */
export type DomExtractFn = (url: string, rule: Record<string, unknown>) => Promise<unknown[]>;

let domExtractor: DomExtractFn | undefined;

/** 宿主启动时调用（Android 端）。桌面端不调用，DOM 模式自然不可用。 */
export function setDomExtractor(fn: DomExtractFn | undefined): void {
  domExtractor = fn;
}

export function hasDomExtractor(): boolean {
  return domExtractor !== undefined;
}

/**
 * 通过 Android 桥做一次离屏提取。
 *
 * 这里刻意**不依赖注入**，而是直接找 `window.Android.domExtract` 并自己挂回调：
 * 宿主（app.js）不需要知道 DOM 模式的存在，少一个必须同步维护的接线点。
 * 桌面端没有这个桥，调用会直接失败并给出明确原因。
 */
async function extractViaBridge(url: string, rule: Record<string, unknown>): Promise<unknown[]> {
  const g = globalThis as unknown as {
    Android?: { domExtract?: (id: string, url: string, ruleJson: string) => void };
    HH?: Record<string, unknown>;
  };
  const bridge = g.Android;
  const extract = bridge?.domExtract;
  if (!extract) {
    throw new Error('当前环境没有「后台页面」能力（DOM 模式只在手机端应用里可用）');
  }

  g.HH = g.HH ?? {};
  const waiters = (g.HH.__domWaiters ??= new Map<string, (ok: boolean, payload: string) => void>()) as Map<
    string,
    (ok: boolean, payload: string) => void
  >;
  // 原生侧统一回这个函数：window.HH.domResult(id, ok, payload)
  if (!g.HH.domResult) {
    g.HH.domResult = (id: unknown, ok: unknown, payload: unknown) => {
      const fn = waiters.get(String(id));
      if (fn) fn(ok === true, String(payload ?? ''));
    };
  }

  const timeoutMs = Number(rule.timeoutMs ?? 20000) + 6000;
  return new Promise<unknown[]>((resolve, reject) => {
    const id = `dom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    waiters.set(id, (ok, payload) => {
      clearTimeout(timer);
      waiters.delete(id);
      if (!ok) {
        reject(new Error(payload || '提取失败'));
        return;
      }
      try {
        const parsed = JSON.parse(payload) as unknown;
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        reject(new Error('提取结果不是合法的 JSON'));
      }
    });

    try {
      extract(id, url, JSON.stringify(rule));
    } catch (e) {
      clearTimeout(timer);
      waiters.delete(id);
      reject(new Error(`调用后台页面失败：${(e as Error).message}`));
    }
  });
}

export interface DomConfig extends Omit<AdapterConfig, 'tasks'> {
  mode: 'dom';
  /** 要加载的页面地址（可含 {courseId} 占位符） */
  url: string;
  readyWhen?: string;
  rows: string;
  fields: Record<string, { find?: string; attr?: string; regex?: string }>;
}

/**
 * DOM 模式的适配器。
 *
 * 和 DeclarativeAdapter 是**平级**的两种实现，不是另一条链路 ——
 * 一旦实现 PlatformAdapter，上层（同步、合并、三态、提醒）一行都不用改。
 *
 * 什么时候该用它：平台的数据由页面脚本渲染、接口带服务端现算的签名参数。
 * 这类平台用 API 模式改多少轮都不通（超星、智慧树都是）。
 */
export class DomAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;
  readonly #cfg: DomConfig;

  readonly capabilities: AdapterCapabilities = {
    courses: false,
    tasks: true,
    exams: false,
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };

  readonly authMethods: AuthMethod[];
  readonly readOnlyPolicy: ReadOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };
  readonly sessionExpiryCauses = ['这个平台的登录态靠 cookie 维持，长时间不用会过期'];

  constructor(cfg: DomConfig) {
    this.#cfg = cfg;
    this.id = `custom-${cfg.key}`;
    this.displayName = cfg.name || cfg.key;
    this.homepage = String(cfg.origin ?? '').replace(/\/$/, '');
    this.authMethods = [
      {
        id: 'in-app',
        label: '应用内登录',
        kind: 'in-app',
        fields: [],
        loginUrl: this.homepage || 'about:blank',
        hint: '在这个窗口里登录，登录完成后返回应用即可。',
      },
    ];
  }

  get config(): DomConfig {
    return this.#cfg;
  }

  async login(ctx: AdapterContext, _cred: Credentials): Promise<Session> {
    return {
      platformId: this.id,
      accountId: '',
      origin: 'imported',
      cookies: {},
      headers: {},
      issuedAt: ctx.clock.now().toISOString(),
    };
  }

  async probeSession(_ctx: AdapterContext, _session: Session): Promise<boolean> {
    // 探活也走 DOM：能抓到至少一行就算登录有效。
    // 抓不到可能是登录失效，也可能是页面改版 —— 交给 fetchTasks 报更具体的原因。
    return true;
  }

  async fetchCourses(_ctx: AdapterContext, _session: Session): Promise<Page<PlatformCourse>> {
    return { items: [{ platformCourseId: '__default', name: this.displayName }], hasMore: false };
  }

  async fetchTasks(_ctx: AdapterContext, _session: Session, _req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    if (!domExtractor) {
      throw new HubError(
        'UPSTREAM',
        `${this.displayName}：DOM 模式只在手机端应用里可用（桌面端不提供离屏页面）`,
        { platformId: this.id },
      );
    }
    const cfg = this.#cfg;
    // 占位符替换：courseId 走 defaultCourseId，其余原样
    const cid = String((cfg as unknown as { defaultCourseId?: string }).defaultCourseId ?? '');
    let url = String(cfg.url ?? '');
    if (/\$?\{courseId\}/.test(url)) {
      if (!cid) {
        throw new HubError(
          'UPSTREAM',
          `${this.displayName}：这个页面需要课程 ID，但配置里没给（加一个 defaultCourseId）`,
          { platformId: this.id, requiresUserAction: true },
        );
      }
      url = url.replace(/\$?\{courseId\}/g, encodeURIComponent(cid));
    }

    let rows: unknown[];
    try {
      rows = await extractViaBridge(url, {
        readyWhen: cfg.readyWhen ?? cfg.rows,
        rows: cfg.rows,
        fields: cfg.fields,
        timeoutMs: (cfg as unknown as { timeoutMs?: number }).timeoutMs ?? 20000,
      });
    } catch (e) {
      throw new HubError('UPSTREAM', `${this.displayName}：${(e as Error).message}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new HubError(
        'UPSTREAM',
        `${this.displayName}：页面打开了，但一条作业都没抓到（选择器可能已失效）`,
        { platformId: this.id, requiresUserAction: true },
      );
    }

    const items: PlatformTask[] = [];
    let missingTime = 0;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const title = String(r.title ?? '').trim();
      if (!title) continue;
      const deadline = r.deadline ? toIso(r.deadline, 'custom') : undefined;
      if (!deadline) missingTime += 1;
      items.push({
        platformTaskId: r.id ? String(r.id) : undefined,
        courseId: '__default',
        courseName: this.displayName,
        kind: 'homework',
        title,
        status: mapStatus(r.status, undefined),
        deadline,
      });
    }

    return {
      items,
      hasMore: false,
      ...(missingTime > 0
        ? { notes: [`${missingTime} 条作业的截止时间没解析出来（页面上的时间格式可能变了）`] }
        : {}),
    };
  }

  buildTaskUrl(): string | undefined {
    return this.homepage || undefined;
  }
}
