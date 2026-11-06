/**
 * PTA（拼题A，pintia.cn）适配器。
 *
 * 凭证与接口全部来自 2026-10-22 的真机抓包（HAR + 前端 chunk），不是社区传闻。
 * 关键事实都写在下面，改动前请先读 —— 每一条都是踩过或验证过的。
 *
 * ── 登录 ───────────────────────────────────────────────────────────
 * 只提供「应用内登录」。原因不是偷懒：
 *   `POST /api/users/sessions` 的请求体里带 `randStr` + `ticket`，
 *   这两个字段由**腾讯防水墙（TCaptcha.js 滑块）**生成（前端 bundle 里能直接看到
 *   `new window.TencentCaptcha(...)`），另外还有一条短信 MFA 链路
 *   （`/api/users/mfa/init` → `/{uuid}/sms` → `/sms-check/login`）。
 *   这类验证码的设计目标就是拦自动化，无法也不应绕过。
 *   ⇒ 用户自己在 WebView 里过滑块，cookie 落进原生 CookieManager。
 *
 * ── 请求头 ─────────────────────────────────────────────────────────
 * 1. **必须带 `Accept: application/json;charset=UTF-8`**。
 *    不带它（浏览器地址栏的默认 Accept）服务端回的是 **protobuf 二进制**，
 *    不是 JSON —— 这会表现成"接口坏了"，其实是拿错了格式。
 * 2. 前端还会带 `x-lollipop` / `x-marshmallow` 两个头。实测：
 *    `x-marshmallow` 是**空值**且照样能拿到数据；`x-lollipop` 是 32 位十六进制、
 *    整份 HAR 里所有请求都**完全相同**（不是逐请求签名）。
 *    ⇒ 按"不需要"处理。真机若出现 401/403，再来补这个固定值。
 *
 * ── 数据模型 ───────────────────────────────────────────────────────
 * 学生视角只有「题目集（problem set）」这一层，而且 **`GET /api/problem-sets/{id}`
 * 对学生返回 PERMISSION_DENIED** —— 必须走 `/exams` 子资源。这一点猜不出来。
 *
 * 完成状态是**按题**的（`exam-problem-status`），不是按题目集：
 *   `problemSet.status` 实测恒为 PENDING（已结束、进行中、未开始三种都出现过），
 *   与"你做没做"无关，**绝不能拿它判完成**。
 *   真正的状态只能从每题聚合出来 —— 这也是 `progress` / `subtasks` 两个字段存在的原因。
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
import type { PlatformTask, TaskProgress, TaskStatus, TaskSubtask } from '#core/domain/task.ts';
import type { Credentials, Session } from '#core/ports/vault.ts';
import type { ReadOnlyPolicy } from '#core/ports/read-only.ts';
import { HubError } from '#core/domain/errors.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';
import { mapLimit } from '#core/engine/http-pipeline.ts';

const BASE = 'https://pintia.cn';

/** PTA 的「未作答」状态码。除它以外的作答状态都代表**已经交过**。 */
const NO_ANSWER = 'PROBLEM_NO_ANSWER';
const ACCEPTED = 'PROBLEM_ACCEPTED';

/** 列表接口的原始响应（只声明用得到的字段，其余忽略）。 */
interface ProblemSetListResponse {
  total?: number;
  problemSets?: Array<{
    id: string;
    name: string;
    type?: string;
    timeType?: string;
    startAt?: string;
    endAt?: string;
    organizationName?: string;
    /**
     * ⚠️ 不要用它判断完成：实测三条分别处于「已结束 / 进行中 / 未开始」，
     * 值全是 PENDING。它大概是题目集自身的发布阶段，与学生的作答无关。
     */
    status?: string;
  }>;
  /** 题目集 ID → 考试 ID。**只有已经开考过的**才会有值。 */
  examIdByProblemSetId?: Record<string, string | undefined>;
  /** 题目集 ID → 来源用户组（班级）。学生看到的"课程"就是它。 */
  userGroupsByProblemSetId?: Record<string, { items?: Array<{ id: string; name: string; type?: string }> }>;
}

interface ProblemStatusResponse {
  problemStatus?: Array<{
    id: string;
    label?: string;
    score?: number;
    problemSubmissionStatus?: string;
    problemType?: string;
  }>;
}

export interface PintiaAdapterOptions {
  id?: string;
  baseUrl?: string;
}

export class PintiaAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;
  readonly #base: string;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: true,
    incremental: false,
    // cookie 由原生 CookieManager 保管并自动随请求发出 —— 适配器不碰它
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
      // 用首页而不是猜 /auth/login：SPA 下任何路径都返回同一个壳，
      // 猜错只会打开一个没有登录入口的页面，而用户只会看到"点了没反应"。
      loginUrl: 'https://pintia.cn/',
      hint:
        '会打开 PTA 官网，用你自己的方式登录（可能需要滑块验证或短信验证）。' +
        '登录完成后返回本应用即可，不需要复制任何东西。',
    },
  ];

  readonly readOnlyPolicy: ReadOnlyPolicy = { allowMethods: ['GET', 'HEAD'] };

  readonly sessionExpiryCauses = [
    'PTA 的登录态靠 cookie 维持，长时间不用会过期',
    '你在别处退出登录，或换了账号',
    '平台侧要求重新验证（滑块 / 短信验证码）',
  ];

  constructor(opts: PintiaAdapterOptions = {}) {
    this.#base = (opts.baseUrl ?? BASE).replace(/\/$/, '');
    this.id = opts.id ?? 'pintia';
    this.displayName = 'PTA 拼题A';
    this.homepage = this.#base;
  }

  /** 每个请求都要带的两样：JSON 格式协商（否则回 protobuf）与来源页。 */
  #headers(): Record<string, string> {
    return {
      Accept: 'application/json;charset=UTF-8',
      Referer: `${this.#base}/problem-sets/active`,
      Origin: this.#base,
    };
  }

  // ---------------------------------------------------------------- 登录

  /**
   * 只在「粘贴 cookie」路线下被调用。
   *
   * 应用内登录不会走这里 —— 那条路由 engine.registerOfflineAccount 处理，
   * cookie 留在原生 CookieManager 里（见 HttpBridge：发请求时按域自动带上）。
   */
  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const session: Session = {
      platformId: this.id,
      accountId: '',
      origin: 'imported',
      cookies: {},
      headers: this.#headers(),
      issuedAt: ctx.clock.now().toISOString(),
    };
    const raw = cred.cookie?.trim();
    if (raw) {
      // 只接受 a=1; b=2 形态。把一长串裸 token 当 cookie 塞进去没有意义，
      // 而静默接受会让用户以为"导入成功了"，实际每个请求都 401。
      if (!raw.includes('=')) {
        throw new HubError('AUTH_FAILED', 'PTA 需要粘贴完整 cookie（形如 JSESSIONID=xxx），不是单个 token', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) session.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
    }
    return session;
  }

  /**
   * 探活：用列表接口而不是 `/api/u/current`。
   *
   * 后者在 **passport.pintia.cn** 子域上，而登录 cookie 是 pintia.cn 的 host-only
   * cookie —— 跨子域未必带得过去，用它探活会出现"明明登录着却判定失效"。
   * 列表接口同域、需要登录、返回体又小（limit=1），是最合适的一个。
   */
  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const http = new SessionHttpClient(ctx, session);
    try {
      // 头必须**每次显式传**：应用内登录时 session.headers 是空的（cookie 在原生 CookieManager 里），
      // 少了 Accept 服务端会回 protobuf，表现成"接口坏了"。
      const res = await http.getJson<unknown>(`${this.#base}/api/problem-sets?page=0&limit=1`, {
        headers: this.#headers(),
      });
      return res.status === 200;
    } catch (e) {
      if (e instanceof HubError && (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_FAILED')) return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- 课程

  async fetchCourses(
    ctx: AdapterContext,
    session: Session,
    _req?: FetchCoursesRequest,
  ): Promise<Page<PlatformCourse>> {
    const data = await this.#listProblemSets(ctx, session);
    const seen = new Map<string, PlatformCourse>();
    for (const group of Object.values(data.userGroupsByProblemSetId ?? {})) {
      for (const item of group?.items ?? []) {
        // 只取学生组；教师组 / 助教组不是「我选的课」
        if (item.type && item.type !== 'STUDENT_USER') continue;
        if (!seen.has(item.id)) seen.set(item.id, { platformCourseId: item.id, name: item.name });
      }
    }
    return { items: [...seen.values()], hasMore: false };
  }

  // ---------------------------------------------------------------- 任务

  async fetchTasks(ctx: AdapterContext, session: Session, _req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    const data = await this.#listProblemSets(ctx, session);
    const sets = (data.problemSets ?? []).filter((ps) => ps.id && ps.name);
    const http = new SessionHttpClient(ctx, session);
    const failures: string[] = [];
    /** 逐条取证：题目集 ID / examId / 进度来源。排查"点进去是另一个作业"必须靠它 */
    const perSet = new Map<string, string>();
    let withExam = 0;
    let withoutExam = 0;

    // 每条题目集最多两次请求：
    //   有 examId → problem-status（每题状态）
    //   没有 / 拿不到 → problem-summaries（只要总题数）
    //
    // 为什么要为「还没开考」的也多发一个请求（2026-10-23 修正）：
    // 它们原来没有 progress，界面上就没有进度条 —— 而同一门课的作业
    // "有的有进度条、有的没有"，看起来像坏了。总题数是用户最想先知道的那一半
    // （"这周要做 4 题"），它不需要 examId 就能拿到。
    const items = await mapLimit(sets, 3, async (ps) => {
      const examId = data.examIdByProblemSetId?.[ps.id];
      if (examId) withExam += 1;
      else withoutExam += 1;
      let statuses: ProblemStatusResponse['problemStatus'];
      if (examId) {
        statuses = await this.#fetchProblemStatus(http, examId, ps.id, failures);
      }
      // 线程安全的说法：没有每题状态（没开考 / 取不到）时补一次总题数
      const total = statuses?.length ? 0 : await this.#fetchProblemTotal(http, ps.id, failures);
      const item = this.#toTask(ps, data, statuses, total);
      // 这一行是给"进度/跳转串了"那类故障留的证据：标题、主键、examId 必须一一对应。
      // 真机（2026-11-02）出现过「第3次」的卡片点进去是第2次，而没有这份对照
      // 就只能靠猜 —— 猜一次就是一次返工。
      const prog = item.progress ? `${item.progress.submitted}/${item.progress.total}` : '无进度';
      perSet.set(
        ps.id,
        `${ps.name}｜id=${ps.id}｜examId=${examId ?? '无'}｜进度=${prog}（${statuses?.length ? '逐题' : '总题数'}）`,
      );
      return item;
    });

    const details: string[] = [];
    if (sets.length > 0) {
      details.push(
        `题目集 ${sets.length} 个 · 有 examId ${withExam} 个（能取逐题状态）· 无 examId ${withoutExam} 个（只取得到总题数）`,
      );
      // 只列前 6 条：再多就不是诊断而是倾倒，而"串记录"这类故障通常一眼就能看出来。
      for (const ps of sets.slice(0, 6)) {
        const line = perSet.get(ps.id);
        if (line) details.push(line);
      }
      if (sets.length > 6) details.push(`…另有 ${sets.length - 6} 个题目集未列出`);
    }

    return {
      items,
      hasMore: false,
      declaredTotal: typeof data.total === 'number' ? data.total : sets.length,
      notes: this.#buildNotes(sets, data, failures),
      ...(details.length > 0 ? { details } : {}),
    };
  }

  buildTaskUrl(courseId: string, task: PlatformTask): string | undefined {
    const id = task.platformTaskId;
    return id ? `${this.#base}/problem-sets/${id}/exam/overview` : undefined;
  }

  // ---------------------------------------------------------------- 内部

  async #listProblemSets(ctx: AdapterContext, session: Session): Promise<ProblemSetListResponse> {
    const http = new SessionHttpClient(ctx, session);
    // filter 传空对象即可；显式编码成 %7B%7D，免得多一层猜测。
    const res = await http.getJson<ProblemSetListResponse>(
      `${this.#base}/api/problem-sets?filter=%7B%7D&page=0&limit=100&orderBy=START_AT&asc=false`,
      { headers: this.#headers() },
    );
    if (res.status === 401 || res.status === 403) {
      throw new HubError('AUTH_REQUIRED', 'PTA 未登录或登录已过期', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    if (!Array.isArray(res.body?.problemSets)) {
      // 拿到 protobuf 或 HTML 时这里会命中 —— 前者说明 Accept 头丢了，
      // 后者说明被风控拦到了登录页。两种都不是"没有作业"，必须响亮报错。
      throw new HubError('UPSTREAM', 'PTA 返回的不是预期的 JSON（可能是格式协商失败或需要重新登录）', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    return res.body;
  }

  async #fetchProblemStatus(
    http: SessionHttpClient,
    examId: string,
    problemSetId: string,
    failures: string[],
  ): Promise<ProblemStatusResponse['problemStatus']> {
    // 单个题目集取不到状态不该让整轮同步失败：其余作业仍然有价值。
    // 但**必须留痕迹** —— 静默吞掉会表现成"进度条不见了"，
    // 而用户和我们都无法区分"没开考"和"接口坏了"。这是本项目最忌讳的失败形态。
    try {
      const res = await http.getJson<ProblemStatusResponse>(
        `${this.#base}/api/exams/${examId}/problem-sets/${problemSetId}/problem-status`,
        { headers: this.#headers() },
      );
      return res.body?.problemStatus;
    } catch (e) {
      failures.push(`做题状态：${(e as Error).message.slice(0, 40)}`);
      return undefined;
    }
  }

  /**
   * 只取总题数（不需要 examId）。
   * 响应形如 `{"summaries":{"PROGRAMMING":{"total":4,"totalScore":100}}}`，
   * 可能有多种题型，所以要把每个类型的 total 加起来。
   */
  async #fetchProblemTotal(http: SessionHttpClient, problemSetId: string, failures: string[]): Promise<number> {
    try {
      const res = await http.getJson<{
        summaries?: Record<string, { total?: number; totalScore?: number } | undefined>;
      }>(`${this.#base}/api/problem-sets/${problemSetId}/problem-summaries`, {
        headers: this.#headers(),
      });
      let total = 0;
      for (const s of Object.values(res.body?.summaries ?? {})) total += s?.total ?? 0;
      return total;
    } catch (e) {
      failures.push(`题目数量：${(e as Error).message.slice(0, 40)}`);
      return 0;
    }
  }

  /** 把一条题目集翻译成本项目的任务。 */
  #toTask(
    ps: NonNullable<ProblemSetListResponse['problemSets']>[number],
    data: ProblemSetListResponse,
    statuses: ProblemStatusResponse['problemStatus'],
    totalFromSummary: number,
  ): PlatformTask {
    const group = (data.userGroupsByProblemSetId?.[ps.id]?.items ?? [])[0];
    const endAt = ps.endAt;
    const expired = endAt ? new Date(endAt).getTime() < Date.now() : false;

    let progress: TaskProgress | undefined;
    let subtasks: TaskSubtask[] | undefined;
    let status: TaskStatus;

    if (!statuses || statuses.length === 0) {
      // 还没开考（或这次没取到每题状态）。
      // 这里**总是**给一个 progress —— 哪怕 total 是 0：
      //   progress=null   → 这个平台没有进度概念（超星/iSmart/雨课堂）
      //   progress.total=0→ 有进度概念，但还没开考 / 拿不到题目（界面显示「未开始」）
      // 两者必须可区分，否则"没开考"在界面上就是一片空白，和"坏了"长得一模一样。
      progress = { submitted: 0, accepted: 0, total: totalFromSummary > 0 ? totalFromSummary : 0 };
      // 这时不能断言「已完成」，只能按时间判过期。
      status = expired ? 'expired' : 'pending';
    } else {
      subtasks = statuses.map((p, i) => ({
        label: p.label ?? String.fromCharCode(65 + i),
        score: typeof p.score === 'number' ? p.score : 0,
        status: p.problemSubmissionStatus ?? NO_ANSWER,
      }));
      const submitted = subtasks.filter((s) => s.status !== NO_ANSWER).length;
      const accepted = subtasks.filter((s) => s.status === ACCEPTED).length;
      progress = { submitted, accepted, total: subtasks.length };
      // 状态按**交**算，不按 AC 算：
      //   「全交了但没全 AC」由 hasPendingAc 单独处理（留在待办、不提醒、不进已完成）。
      //   若这里按 AC 算，交完的人会一直被当成没交，提醒也不会停。
      if (submitted >= subtasks.length) status = 'submitted';
      else status = expired ? 'expired' : 'pending';
    }

    return {
      platformTaskId: ps.id,
      courseId: group?.id ?? 'pintia-ungrouped',
      courseName: group?.name ?? ps.organizationName ?? 'PTA',
      kind: 'homework',
      title: ps.name,
      status,
      // 台账原文是 EXERCISE/FIXED_TIME；status 字段刻意不用（见文件头注释）。
      deadline: endAt,
      publishedAt: ps.startAt,
      ...(progress ? { progress } : {}),
      ...(subtasks ? { subtasks } : {}),
      sourceUrl: `${this.#base}/problem-sets/${ps.id}/exam/overview`,
      raw: ps,
    };
  }

  /**
   * 同步消息里的附注：只在**真的需要用户知道**的时候说一句。
   * 沉默的已知边界等于一个还没被发现的 bug，但这页也不该变成公告栏。
   */
  #buildNotes(
    sets: NonNullable<ProblemSetListResponse['problemSets']>,
    data: ProblemSetListResponse,
    failures: string[],
  ): string[] | undefined {
    const notes: string[] = [];
    const noExam = sets.filter((ps) => !data.examIdByProblemSetId?.[ps.id]).length;
    if (noExam > 0) {
      notes.push(`${noExam} 个题目集还没开考：进度条从 0 开始（题数是平台给的，不是猜的）`);
    }
    // 取不到的部分必须说出来。不说的话，界面上就是"进度条没了"，
    // 而"没开考"和"接口坏了"长得一模一样。
    if (failures.length > 0) {
      notes.push(`${failures.length} 次题目信息没取到（${failures[0]}${failures.length > 1 ? ' 等' : ''}）`);
    }
    return notes.length > 0 ? notes : undefined;
  }
}
