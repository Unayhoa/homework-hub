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
import { urlRequiresSignature } from './probe.ts';
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
    /**
     * 课程。`path` 取课程名，`idPath` 取课程 ID（可选）。
     *
     * 只有名字也够：课程名在同一个平台内是稳定的，用它当平台课程 ID
     * （`name:<课程名>`）就能把作业按课程分开 —— 否则所有作业都会挤在
     * 一条 `__default` 课程里，课程页只能看到一门"课"，点课程名筛选也失效。
     */
    course?: { path?: string; idPath?: string };
    status?: { path?: string; values?: Record<string, string>; usableForCompletion?: boolean };
  };
  link?: { type?: string; value?: string };
  confidence?: number;
  /**
   * 这份配置**对应哪一门课**（平台原始课程 ID，或 `__default`）。
   *
   * 什么时候该填：录制时人就在某一门课里（URL 带 courseId）—— 那么这份配置
   * 天然是"这门课的读取器"，页面上任何列表都是**课程内容**，不是课程目录。
   * 不填的话，课程维度只能靠任务行上的字段推，而那个字段常常是"资料名"。
   */
  defaultCourseId?: string;
  /** 这门课叫什么。不填就退回平台名。用户随时可以改名（改名只动显示层）。 */
  courseName?: string;
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

/**
 * 从一行任务里取「它属于哪门课」。**全项目唯一**计算课程标识的地方
 * （API 模式与 DOM 模式共用，避免两处各算一遍 —— 那必然对不上）。
 *
 * 优先级从高到低：
 *   1. 配置了课程 ID 字段 → 用它（最准，是平台自己认可的标识）
 *   2. 课程名能在**课程接口给的列表**里对上 → 用列表里的真 ID
 *   3. 只有课程名 → 用 `name:<课程名>`（课程名在同一平台内稳定）
 *   4. 什么都没有 → `__default`（必须与 fetchCourses 的兜底课程对齐）
 *
 * 第 2 条是踩出来的（2026-10-27）：配置里声明了课程接口（c1/c2），而任务行上
 * 只有课程名。若这里只按名字造 ID，同一门课会同时存在 `c1` 和 `name:高等数学`
 * 两条记录 —— 课程页直接翻倍，每条作业还都挂在"假"的那一条上。
 * 课程列表是权威，任务行只是它的引用。
 */
export function courseKeyOf(
  nameRaw: unknown,
  idRaw: unknown,
  fallbackName: string,
  nameToId?: Map<string, string>,
): { id: string; name: string } {
  const name = String(nameRaw ?? '').trim() || fallbackName;
  const explicitId = idRaw === undefined || idRaw === null ? '' : String(idRaw).trim();
  if (explicitId) return { id: explicitId, name };
  const known = nameToId?.get(name);
  if (known) return { id: known, name };
  if (name === fallbackName) return { id: '__default', name };
  return { id: `name:${name}`, name };
}

/**
 * 这条任务该挂到哪门课。
 *
 * **锚点优先**：配置里声明了 `defaultCourseId`，就说明"这份配置读的就是这一门课"，
 * 于是任务行上的任何"课程"字段都不该参与判断 —— 那个字段是课程**内容**的名字
 * （芭蕾舞 / 某个 .mp4），拿它切会切出假课（真机 2026-10-27）。
 */
export function courseOfTask(
  cfg: { defaultCourseId?: string; courseName?: string },
  platformName: string,
  nameRaw: unknown,
  idRaw: unknown,
  nameToId?: Map<string, string>,
): { id: string; name: string } {
  if (cfg.defaultCourseId) {
    return { id: cfg.defaultCourseId, name: cfg.courseName?.trim() || platformName };
  }
  return courseKeyOf(nameRaw, idRaw, platformName, nameToId);
}

/** 课程名 → 平台课程 ID。索引来自引擎传进来的课程表（也就是 fetchCourses 存下的那批）。 */
export function courseIndexOf(courses: readonly PlatformCourse[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of courses ?? []) {
    const name = String(c.name ?? '').trim();
    if (name && !m.has(name)) m.set(name, c.platformCourseId);
  }
  return m;
}

/**
 * 这条「待完成」是平台说的，还是我们推的？
 *
 * 判据只有一条：**配置里有没有一个能表达完成状态的字段**。
 *   · 有 status 字段且 usableForCompletion !== false → 平台说的（'platform'）
 *   · 没有 / 明确不可用于判断完成 → 我们推的（'inferred'）
 *
 * 为什么这条必须分清（真机教训，与雨课堂章节树同源）：标成 'platform' 之后，
 * 「平台优先」规则会认为"平台明确说未完成"，于是 `canMarkCompleted` 返回 false ——
 * 用户点不动「标记已完成」。一个没配状态字段的自定义平台，作业做完后**永远无法标记**、
 * 永远留在待办里催他。它跟内置平台的差别不该是"少个功能"，而这正是配置决定的事。
 */
function statusSourceOf(cfg: AdapterConfig['fields']['status']): 'platform' | 'inferred' {
  if (!cfg?.path) return 'inferred';
  if (cfg.usableForCompletion === false) return 'inferred';
  return 'platform';
}

/** 把配置里的状态映射成这个应用的状态。认不出就一律 pending（不假装完成）。 */
export function mapStatus(
  raw: unknown,
  cfg: AdapterConfig['fields']['status'],
): TaskStatus {
  if (cfg?.usableForCompletion === false) return 'pending';
  const v = String(raw ?? '').trim();
  if (!v) return 'pending';
  // 配置里显式给了映射表，优先用它
  const mapped = cfg?.values?.[v];
  const label = String(mapped ?? v);

  // **先判"没交"再判"交了"**。顺序不能反：
  // 英文状态里 "not submitted" / "incomplete" 都含有完成类词根，
  // 先判完成会把这些全部误判成已交 —— 于是作业从待办里消失，用户以为做完了。
  if (/(未完成|未交|待交|未提交|未批|not\s*submit|unsubmit|incomplete|not\s*done|pending|todo|undone)/i.test(label)) {
    return 'pending';
  }
  if (/(已完成|已交|已提交|已批|待批阅|阅卷中|已迟交|submit|complet|done|finished|graded|approved|passed)/i.test(label)) {
    return 'submitted';
  }
  if (/(过期|已结束|已关闭|expired|overdue|ended|closed)/i.test(label)) return 'expired';
  return 'pending';
}

/**
 * 一组状态取值里，有没有任何一个能被认出"交了/没交"。
 *
 * 用途是决定 `usableForCompletion`：认不出就不要假装平台报了完成状态
 * （否则「平台优先」会压住手动标记，用户作业做完永远标不掉）。
 * 注意这里**不猜数字语义**（status: 0/1 到底哪个是已交，没有通用答案）。
 */
export function statusLooksUsable(values: unknown[]): boolean {
  const seen = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (seen.length === 0) return false;
  return seen.some((v) => mapStatus(v, undefined) !== 'pending');
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


/**
 * 能力 = **配置的函数**，不是常量。
 *
 * 这是「自定义平台和内置平台等价」的第一条前提，也是真机故障（2026-10-27）的根因：
 * 这里原本写死 `courses: false`，而引擎只在 capabilities.courses 为真时才调用
 * fetchCourses（sync-engine 的 shouldRefreshCourses）—— 于是下面那个
 * **已经写好**的 fetchCourses 从头到尾没被执行过，课程表永远是空的：
 * 待办里有作业，课程页却写着"这个账号下还没有课程"。
 *
 * `courses` 恒为真：最差的情况（平台没有任何课程概念）我们也能给出一条兜底课程。
 * 声明"没有课程能力"只会让引擎跳过课程，而**课程页空白和"平台没课程"在用户眼里
 * 没有区别** —— 这正是本项目反复踩的「留白 = 坏了」。
 */
export function resolveCapabilities(cfg: {
  courses?: { url?: string };
  exams?: unknown;
}): AdapterCapabilities {
  return {
    courses: true,
    tasks: true,
    exams: Boolean(cfg.exams),
    // 没有增量接口：每轮都重新拉列表。配置里没有"游标"这个概念，别假装有。
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };
}

export class DeclarativeAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;
  readonly #cfg: AdapterConfig;
  readonly #origin: string;

  /**
   * 注意：**不能**用字段初始化器（`readonly capabilities = resolveCapabilities(this.#cfg)`）——
   * 字段初始化器在构造函数体之前执行，那时 #cfg 还是 undefined，
   * 于是所有能力都变成 false，又回到这次故障的原点。必须在构造函数里赋值。
   */
  readonly capabilities: AdapterCapabilities;

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
    this.capabilities = resolveCapabilities(cfg);
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
    // 没有课程接口 → 两种情况必须分开，否则课程页会说谎：
    //   ① 任务行里带课程名（fields.course）→ 课程由任务投影出来，这里**不要**造虚拟课程。
    //      造了就会和投影出来的真课程并存，课程页平白多一条 0 作业的"平台名"课程。
    //   ② 连课程名都没有 → 给一条兜底课程，保证作业有地方挂，课程页不至于空白。
    //      （硬塞进"未分类"会让人在课程页找不到它。）
    if (!this.#cfg.courses?.url) {
      // ① 锚点课程：这份配置就是"某一门课"的读取器（录制时人在那门课里）。
      //    这时不能再按任务行上的字段切课程 —— 那个字段是课程**内容**的名字，
      //    拿它当课程名会把「芭蕾舞」「xxx.mp4」变成三门课（真机 2026-10-27 就是这么错的）。
      const anchor = this.#cfg.defaultCourseId;
      if (anchor || this.#cfg.courseName) {
        return {
          items: [{ platformCourseId: anchor ?? '__default', name: this.#cfg.courseName || this.displayName }],
          hasMore: false,
        };
      }
      // ② 任务行里有课程名 → 课程由任务投影出来（引擎补齐），这里不要造虚拟课程
      if (this.#cfg.fields?.course?.path) return { items: [], hasMore: false };
      // ③ 什么都没有 → 一条兜底课程，保证作业有地方挂
      return {
        items: [{ platformCourseId: '__default', name: this.displayName }],
        hasMore: false,
      };
    }
    const http = new SessionHttpClient(ctx, session);
    const res = await http.getJson<unknown>(this.#abs(this.#cfg.courses.url));
    const list = getByPath(res.body, this.#cfg.courses.listPath ?? '$.data');
    if (!Array.isArray(list)) {
      throw new HubError('PARSE_EMPTY', `${this.displayName}：课程列表取不到（配置里的 listPath 可能不对）`, {
        platformId: this.id,
        requiresUserAction: true,
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
          'PARSE_EMPTY',
          `${this.displayName}：这个接口需要课程 ID，但配置里没给（在配置里加 "defaultCourseId"，或把占位符换成具体值）`,
          { platformId: this.id, requiresUserAction: true },
        );
      }
      out = out.replace(/\$?\{courseId\}/g, encodeURIComponent(cid));
    }
    return out;
  }

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    const http = new SessionHttpClient(ctx, session);
    const cfg = this.#cfg;
    const items: PlatformTask[] = [];
    const notes: string[] = [];

    // 签名接口：**原理上**跑不通（参数由页面 JS 现算、寿命几十秒）。
    // 在这里挡住的好处是错误分类准确 —— 否则会表现为"接口返回 403/空列表"，
    // 用户以为配置写错了，一路往错的方向修。
    if (urlRequiresSignature(cfg.tasks.url ?? '')) {
      throw new HubError(
        'SIGNATURE_REQUIRED',
        `${this.displayName}：这个接口要页面现算的签名参数，声明式配置拿不到（改用「点选页面」接入）`,
        { platformId: this.id, requiresUserAction: true },
      );
    }

    /** 课程名 → 真课程 ID：来自引擎传进来的课程表，保证任务和课程表挂在同一门课上 */
    const nameToId = courseIndexOf(req.courses);

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
          'PARSE_EMPTY',
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
        // 这条作业属于哪门课 —— 决定课程页能不能按课程分开，不是显示细节
        const course = courseOfTask(
          cfg,
          this.displayName,
          cfg.fields.course?.path ? getByPath(row, cfg.fields.course.path) : undefined,
          cfg.fields.course?.idPath ? getByPath(row, cfg.fields.course.idPath) : undefined,
          nameToId,
        );
        const statusRaw = cfg.fields.status?.path ? getByPath(row, cfg.fields.status.path) : undefined;
        items.push({
          platformTaskId: idRaw === undefined ? undefined : String(idRaw),
          courseId: course.id,
          courseName: course.name,
          kind: 'homework',
          title: String(titleRaw).trim(),
          status: mapStatus(statusRaw, cfg.fields.status),
          // 「平台能不能报告完成状态」在任务上必须显式标出来，
          // 否则界面会替平台断言"你还没交"，用户也标不动（见 statusSourceOf）
          statusSource: statusSourceOf(cfg.fields.status),
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
  // **不要解构**成 const extract = bridge.domExtract。
  // Java 桥方法必须在注入对象上调用 —— 解构之后 this 丢了，
  // Chromium 会抛 "Java bridge method can't be invoked on a non-injected object"，
  // 看起来像"手机端不支持 DOM 模式"，其实只是 this 没了（真机 2026-10-24）。
  const hasExtract = typeof bridge?.domExtract === 'function';
  if (!hasExtract) {
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
      // 用可选链调用，this 仍然是 bridge —— 这是桥方法能被执行的前提
      bridge.domExtract?.(id, url, JSON.stringify(rule));
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

  readonly capabilities: AdapterCapabilities;

  readonly authMethods: AuthMethod[];
  readonly readOnlyPolicy: ReadOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };
  readonly sessionExpiryCauses = ['这个平台的登录态靠 cookie 维持，长时间不用会过期'];

  constructor(cfg: DomConfig) {
    this.#cfg = cfg;
    this.id = `custom-${cfg.key}`;
    this.displayName = cfg.name || cfg.key;
    this.homepage = String(cfg.origin ?? '').replace(/\/$/, '');
    this.capabilities = resolveCapabilities(cfg);
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
    // 与 API 模式同一套规矩：页面里能选课程名就让任务投影出真课程，
    // 选不到才给一条兜底课程。这个分支决定了课程页是 1 门"平台名"还是真的几门课。
    if (this.#cfg.fields?.course?.find) return { items: [], hasMore: false };
    return { items: [{ platformCourseId: '__default', name: this.displayName }], hasMore: false };
  }

  async fetchTasks(_ctx: AdapterContext, _session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    // 不要在这里检查 domExtractor —— 真正的可用性判断在 extractViaBridge 里
    //（它找的是 window.Android.domExtract）。之前这里多了一道「模块变量是否注入」的检查，
    // 而宿主根本不注入（改成直接找桥了），于是每次同步都在这里被拦下：
    // 报「DOM 模式只在手机端可用」，而实际手机端完全能跑。
    const cfg = this.#cfg;
    // 占位符替换：courseId 走 defaultCourseId，其余原样
    const cid = String((cfg as unknown as { defaultCourseId?: string }).defaultCourseId ?? '');
    let url = String(cfg.url ?? '');
    if (/\$?\{courseId\}/.test(url)) {
      if (!cid) {
        throw new HubError(
          'PARSE_EMPTY',
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
      throw new HubError('SELECTOR_STALE', `${this.displayName}：${(e as Error).message}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new HubError(
        'SELECTOR_STALE',
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
      // 页面上选过「课程名」就按课程分开；没选过就归到兜底课程。
      // 与 API 模式同一套判据（courseKeyOf），不另写一份。
      const course = courseOfTask(cfg, this.displayName, r.course, r.courseId, courseIndexOf(req.courses));
      items.push({
        platformTaskId: r.id ? String(r.id) : undefined,
        courseId: course.id,
        courseName: course.name,
        kind: 'homework',
        title,
        status: mapStatus(r.status, undefined),
        // 页面上没选「状态」这一列 → 平台沉默，用户自己说了算（否则他永远标不动）
        statusSource: r.status === undefined || String(r.status).trim() === '' ? 'inferred' : 'platform',
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
