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
      let url = this.#abs(cfg.tasks.url);
      if (pag.type === 'page' && pag.param) {
        const v = start + page;
        url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(pag.param)}=${v}`;
      }
      const res = await http.getJson<unknown>(url);
      const list = getByPath(res.body, cfg.tasks.listPath ?? '$.data');
      if (!Array.isArray(list)) {
        // 关键区分：拿不到数组 ≠ 没有作业。前者是配置/改版问题，必须报错。
        throw new HubError(
          'UPSTREAM',
          `${this.displayName}：作业列表取不到（listPath「${cfg.tasks.listPath ?? '$.data'}」没命中数组）`,
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

/** 粗略校验一份配置够不够跑起来。返回缺失项（空数组 = 可用）。 */
export function validateConfig(cfg: unknown): string[] {
  const missing: string[] = [];
  const c = cfg as Partial<AdapterConfig> | null;
  if (!c || typeof c !== 'object') return ['配置不是一个对象'];
  if (!c.key || !/^[a-z0-9-]+$/.test(String(c.key))) missing.push('key（只能用小写字母、数字、短横线）');
  if (!c.name) missing.push('name');
  if (!c.origin) missing.push('origin');
  if (!c.tasks || typeof c.tasks !== 'object') missing.push('tasks');
  else if (!c.tasks.url) missing.push('tasks.url');
  if (!c.fields || typeof c.fields !== 'object') missing.push('fields');
  else {
    if (!c.fields.title?.path) missing.push('fields.title.path');
    if (!c.fields.id?.path) missing.push('fields.id.path');
  }
  return missing;
}
