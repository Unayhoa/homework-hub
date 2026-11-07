/**
 * 智慧树（在线学堂 / zhihuishu.com）适配器。
 *
 * 数据来源：2026-11-07 真机 HAR（onlineweb.zhihuishu.com）。只做**账号登录 + 作业待办**，
 * 任务点/考试先不做（任务点统计在用户版不作为首批能力）。
 *
 * 真实链路（HAR 实证）：
 *   1. getLoginUserInfo → 拿 `uuid`（后续接口都要）
 *   2. getStudentCourseList → 学习中的课程（studyCourses / archiveCourses）
 *   3. homeworkUser/List → 每门课全部作业（completeTab=0 全部，2=未完成，1=已完成）
 *
 * 注意：
 *   - 智慧树的接口全部要求 `uuid` + `dateFormate`；uuid 每次同步现取，不缓存。
 *   - `status` 是提交状态：1=未提交、2=被打回、3=待批阅/批阅中、4=已批阅、5=已出分。
 *   - 截止时间用 `endTime`（epoch 毫秒），`homeworkEndDate` 作为兜底。
 *   - 这是一个 **cookie-only** 平台：应用内登录后由原生 CookieManager 保管会话。
 */
import type {
  AdapterCapabilities,
  AdapterContext,
  AuthMethod,
  FetchCoursesRequest,
  FetchTasksRequest,
  Page,
  PlatformAdapter,
} from '#core/ports/adapter.ts';
import type { PlatformCourse } from '#core/domain/course.ts';
import type { PlatformTask, TaskStatus } from '#core/domain/task.ts';
import type { Credentials, Session } from '#core/ports/vault.ts';
import type { ReadOnlyPolicy } from '#core/ports/read-only.ts';
import { HubError, schemaDrift } from '#core/domain/errors.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';

export interface ZhihuishuEndpointMap {
  /** 当前登录用户（含 uuid）。GET。 */
  userInfo: string;
  /** 学生学习中的课程列表。GET。 */
  courseList: string;
  /** 一门课的作业列表。GET。 */
  homeworkList: string;
  /** 作业列表页面（buildTaskUrl 兜底，不是具体作业）。 */
  homeworkPage: string;
}

export const ZhihuishuEndpoints: ZhihuishuEndpointMap = {
  userInfo: 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo',
  courseList: 'https://hike-teaching.zhihuishu.com/educational/platform/getStudentCourseList',
  homeworkList: 'https://hiexam-server.zhihuishu.com/zhsathome/homeworkUser/List',
  homeworkPage: 'https://wenda.zhihuishu.com/stu/courseInfo/homeworkExam/',
};

export interface ZhihuishuAdapterOptions {
  endpoints?: Partial<ZhihuishuEndpointMap>;
}

export class ZhihuishuAdapter implements PlatformAdapter {
  readonly id = 'zhihuishu';
  readonly displayName = '智慧树';
  readonly homepage = 'https://onlineweb.zhihuishu.com/';
  readonly #ep: typeof ZhihuishuEndpoints;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    // 首批只做作业待办；考试/任务点按用户确认先不做
    exams: false,
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };

  readonly authMethods: AuthMethod[] = [
    {
      id: 'in-app',
      label: '应用内登录',
      kind: 'in-app',
      fields: [],
      loginUrl: 'https://onlineweb.zhihuishu.com/',
      hint:
        '会打开智慧树官方页面。你正常登录即可，cookie 由系统保管，本应用读不到也存不了；' +
        '返回应用后会自动读取课程与作业。',
    },
  ];

  readonly readOnlyPolicy: ReadOnlyPolicy = {
    allowMethods: ['GET', 'HEAD'],
  };

  readonly sessionExpiryCauses = [
    '智慧树登录态靠 cookie 维持，长时间不用会过期',
    '你在别处退出登录或换了账号',
    '平台要求重新验证（短信/图形验证码）',
  ];

  constructor(opts: ZhihuishuAdapterOptions = {}) {
    this.#ep = { ...ZhihuishuEndpoints, ...opts.endpoints };
  }

  /**
   * 只在「粘贴 cookie」路线下被调用；应用内登录走原生 CookieManager，
   * 不会经过这里。没有 cookie 时明确报错，不静默接受。
   */
  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const session: Session = {
      platformId: this.id,
      accountId: '',
      origin: 'imported',
      cookies: {},
      headers: {},
      issuedAt: ctx.clock.now().toISOString(),
    };
    const raw = cred.cookie?.trim();
    if (raw) {
      if (!raw.includes('=')) {
        throw new HubError('AUTH_FAILED', '智慧树需要粘贴完整 cookie（形如 SESSION=xxx），不是单个 token', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) session.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      return session;
    }
    throw new HubError('AUTH_FAILED', '智慧树请使用「应用内登录」或粘贴完整 cookie', {
      platformId: this.id,
      requiresUserAction: true,
    });
  }

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    try {
      const http = new SessionHttpClient(ctx, session);
      const body = await this.#getJson(http, `${this.#ep.userInfo}?time=${ctx.clock.nowMs()}`);
      return Number(body.code) === 200 && Boolean((body.result as { uuid?: unknown } | undefined)?.uuid);
    } catch {
      // 探活只回答「还能不能用」；任何不能解析的形态都视为失效
      return false;
    }
  }

  async fetchCourses(ctx: AdapterContext, session: Session, _req?: FetchCoursesRequest): Promise<Page<PlatformCourse>> {
    const http = new SessionHttpClient(ctx, session);
    const uuid = await this.#uuid(http, ctx);
    const body = await this.#getJson(
      http,
      `${this.#ep.courseList}?year=&term=&uuid=${encodeURIComponent(uuid)}&dateFormate=${ctx.clock.nowMs()}`,
    );
    if (Number(body.status) !== 200 || !body.rt || typeof body.rt !== 'object') {
      throw schemaDrift(this.id, `课程列表缺少 rt（响应键：${Object.keys(body).join(',')}）`);
    }
    const rt = body.rt as { studyCourses?: unknown[]; archiveCourses?: unknown[] };
    const courses = [...(Array.isArray(rt.studyCourses) ? rt.studyCourses : []), ...(Array.isArray(rt.archiveCourses) ? rt.archiveCourses : [])];
    return { items: parseZhihuishuCourses(courses), hasMore: false };
  }

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    if (!req.courses || req.courses.length === 0) {
      throw new HubError('UPSTREAM', '缺少课程列表，无法拉取智慧树作业（课程缓存可能为空）', {
        platformId: this.id,
      });
    }
    const http = new SessionHttpClient(ctx, session);
    const uuid = await this.#uuid(http, ctx);
    const items: PlatformTask[] = [];
    const failures: string[] = [];

    for (const course of req.courses) {
      try {
        const all = await this.#listHomeworks(http, ctx, uuid, course.platformCourseId);
        items.push(...parseZhihuishuHomeworks(all, course.platformCourseId, course.name));
      } catch (e) {
        failures.push(`${course.name}: ${(e as Error).message}`);
      }
    }

    if (items.length === 0 && failures.length > 0 && failures.length >= req.courses.length) {
      const authLike = failures.some((f) => /登录|会话|401|403|uuid/i.test(f));
      throw new HubError(authLike ? 'AUTH_REQUIRED' : 'UPSTREAM', `智慧树全部课程拉取失败：${failures.slice(0, 3).join('；')}`, {
        platformId: this.id,
        requiresUserAction: authLike,
      });
    }
    return { items, hasMore: false };
  }

  /** 作业列表页；点作业名先落到这门课的作业列表（具体作业的直达 URL 需要页面状态，先不猜）。 */
  buildTaskUrl(courseId: string, _task: PlatformTask): string | undefined {
    return `${this.#ep.homeworkPage}?courseId=${encodeURIComponent(courseId)}`;
  }

  /** 取登录用户 uuid。失败一律明确报 AUTH_REQUIRED，不能静默空列表。 */
  async #uuid(http: SessionHttpClient, ctx: AdapterContext): Promise<string> {
    const body = await this.#getJson(http, `${this.#ep.userInfo}?time=${ctx.clock.nowMs()}`);
    const uuid = (body.result as { uuid?: unknown } | undefined)?.uuid;
    if (Number(body.code) !== 200 || typeof uuid !== 'string' || !uuid) {
      throw new HubError('AUTH_REQUIRED', '智慧树会话已失效（未拿到登录用户 uuid），请重新登录', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    return uuid;
  }

  async #listHomeworks(
    http: SessionHttpClient,
    ctx: AdapterContext,
    uuid: string,
    courseId: string,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    // completeTab=0 是「全部」；页面还会用 2=未完成、1=已完成，这里一次拿全。
    for (let page = 1; page <= 20; page += 1) {
      const url =
        `${this.#ep.homeworkList}?courseId=${encodeURIComponent(courseId)}` +
        `&pageIndex=${page}&pageSize=100&key=&completeTab=0&uuid=${encodeURIComponent(uuid)}&dateFormate=${ctx.clock.nowMs()}`;
      const body = await this.#getJson(http, url);
      // 注意：智慧树的 status 有时是 200，有时是字符串 "200"
      if (Number(body.status) !== 200 || !body.rt || typeof body.rt !== 'object') {
        throw schemaDrift(this.id, `作业列表缺少 rt（响应键：${Object.keys(body).join(',')}）`);
      }
      const rt = body.rt as { list?: unknown[]; rowCount?: unknown };
      const list = Array.isArray(rt.list) ? rt.list : [];
      if (!Array.isArray(rt.list)) {
        throw schemaDrift(this.id, '作业列表缺少 rt.list');
      }
      out.push(...list);
      const total = Number(rt.rowCount);
      if (list.length === 0 || !Number.isFinite(total) || out.length >= total) break;
    }
    return out;
  }

  async #getJson(http: SessionHttpClient, url: string): Promise<Record<string, unknown>> {
    const res = await http.getJson<Record<string, unknown>>(url);
    if (res.status === 401 || res.status === 403) {
      throw new HubError('AUTH_REQUIRED', '智慧树未登录或登录已过期', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    if (!res.body || typeof res.body !== 'object') {
      throw new HubError('UPSTREAM', '智慧树返回的不是 JSON（可能需要重新登录）', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    return res.body;
  }
}

/** 解析智慧树课程列表（studyCourses / archiveCourses）。 */
export function parseZhihuishuCourses(list: unknown[]): PlatformCourse[] {
  const out: PlatformCourse[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = r.courseId;
    const name = r.courseName;
    if (id === undefined || id === null || typeof name !== 'string' || !name.trim()) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      platformCourseId: key,
      name: name.trim(),
      teacher: typeof r.courseCreator === 'string' ? r.courseCreator : typeof r.teacherName === 'string' ? r.teacherName : undefined,
      term: typeof r.yearTerm === 'string' ? r.yearTerm : undefined,
      ...(typeof r.homepage === 'string' ? { sourceUrl: r.homepage } : {}),
      raw: r,
    });
  }
  return out;
}

/** 解析智慧树作业列表（字段名来自 2026-11-07 HAR）。 */
export function parseZhihuishuHomeworks(list: unknown[], courseId: string, courseName: string): PlatformTask[] {
  const out: PlatformTask[] = [];
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const title = r.title;
    const id = r.homeworkId ?? r.homework_id ?? r.id;
    if (typeof title !== 'string' || !title.trim() || id === undefined || id === null) continue;

    const status = mapZhihuishuStatus(r);
    const deadline = zhihuishuDeadline(r);
    const score = numeric(r.answerScore ?? r.homeworkScore);
    const endMs = numeric(r.endTime);
    const startedAt = numeric(r.startTime);

    out.push({
      platformTaskId: String(id),
      courseId,
      courseName,
      kind: 'homework',
      title: title.trim(),
      status,
      ...(deadline ? { deadline } : {}),
      ...(startedAt !== undefined ? { publishedAt: new Date(normalizeEpochMs(startedAt) ?? startedAt).toISOString() } : {}),
      ...(score !== undefined ? { score } : {}),
      raw: r,
      ...(endMs !== undefined && endMs > 0
        ? { sourceUrl: `${ZhihuishuEndpoints.homeworkPage}?courseId=${encodeURIComponent(courseId)}` }
        : {}),
    });
  }
  return out;
}

/**
 * 智慧树提交状态：
 *   1=未提交（截止前 pending，截止后 expired）
 *   2=被打回（还能重做；截止后 expired）
 *   3=待批阅/批阅中 → submitted
 *   4=已批阅 / 5=已出分 → graded
 * `isEndSubmit=1` 也代表提交入口已关闭。
 */
export function mapZhihuishuStatus(r: Record<string, unknown>, now: Date = new Date()): TaskStatus {
  const status = Number(r.status);
  if (status === 4 || status === 5) return 'graded';
  if (status === 3) return 'submitted';
  const end = zhihuishuDeadline(r);
  const ended = (end !== undefined && new Date(end).getTime() < now.getTime()) || Number(r.isEndSubmit) === 1;
  if (status === 2) return ended ? 'expired' : 'pending'; // 被打回，仍可重做
  return ended ? 'expired' : 'pending'; // status 1 / 未知
}

function zhihuishuDeadline(r: Record<string, unknown>): string | undefined {
  const ms = numeric(r.endTime ?? r.end_time ?? r.endDate);
  if (ms !== undefined && ms > 0) return new Date(normalizeEpochMs(ms)).toISOString();
  const iso = r.homeworkEndDate ?? r.endTimeStr;
  if (typeof iso === 'string') {
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function normalizeEpochMs(v: number): number {
  // 同一平台里偶尔出现秒级时间戳；大于 1e12 视为毫秒。
  return v < 1e12 ? v * 1000 : v;
}

function numeric(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
