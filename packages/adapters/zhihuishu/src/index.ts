/**
 * 智慧树（在线学堂 / zhihuishu.com）适配器。
 *
 * 数据来源：2026-11-07 / 11-09 真机 HAR（onlineweb / onlineweb2 / stuonline /
 * onlineexamh5new）。覆盖普通学习课、翻转课的作业，以及「共享课」（如大学生
 * 心理健康）的章节测验、见面课测验、期末考试、平时成绩与视频任务点。
 *
 * 请求链路（全部 HAR 实证）：
 *   - 普通课：getLoginUserInfo → getStudentCourseList → homeworkUser/List
 *   - 共享课列表：queryShareCourseInfo（固定查询密文）
 *   - 共享课任务点/成绩：stuonline/stuLearnReportNew/*（免加密 POST）
 *   - 共享课作业/考试：appcomm-user/c/has 换密钥 → studentexam/taurusexam
 *     的 secretStr（RSA + AES-CBC，见 exam-crypto.ts，已离线逐字节验证）
 *
 * 注意：
 *   - 普通课程接口要求 `uuid` + `dateFormate`；uuid 每次同步现取，不缓存。
 *   - 作业 `status`：1=未提交、2=被打回、3=待批阅、4=已批阅、5=已出分。
 *   - 这是一个 **cookie-only** 平台：应用内登录后由原生 CookieManager 保管会话。
 */
import type {
  AdapterCapabilities,
  AdapterContext,
  AuthMethod,
  CourseProgressItem,
  FetchCourseProgressRequest,
  FetchCoursesRequest,
  FetchTasksRequest,
  Page,
  PlatformAdapter,
} from '#core/ports/adapter.ts';
import type { PlatformCourse, UnifiedCourse, CourseGradeSummary } from '#core/domain/course.ts';
import type { PlatformTask, TaskStatus } from '#core/domain/task.ts';
import type { Credentials, Session } from '#core/ports/vault.ts';
import type { ReadOnlyPolicy } from '#core/ports/read-only.ts';
import { HubError, schemaDrift } from '#core/domain/errors.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';
import { buildSecretStr, recoverSl, rsaEncryptUid } from './exam-crypto.ts';

export interface ZhihuishuEndpointMap {
  /** 当前登录用户（含 uuid）。GET。 */
  userInfo: string;
  /** 学生学习中的课程列表。GET。 */
  courseList: string;
  /** 一门课的作业列表。GET。 */
  homeworkList: string;
  /** 作业列表页面（buildTaskUrl 兜底，不是具体作业）。 */
  homeworkPage: string;
  /** 共享课列表。POST（secretStr 是页面加密结果）。 */
  shareCourses: string;
  /** 共享课学习页。 */
  sharedCoursePage: string;
  /** 共享课学习进度/成绩摘要。 */
  stuLearn: string;
  /** 共享课章节测验成绩。 */
  stuExamScore: string;
  /** 共享课成绩摘要（平时分/期末/总评）。 */
  stuReport: string;
  /** 共享课学习习惯分。 */
  stuHabit: string;
  /** 共享课互动分。 */
  stuForum: string;
  /** 共享课成绩证明接口（内含 studentScoreDto，是平时分的第二数据源）。 */
  stuCertify: string;
  /** 共享课见面课教学任务（免加密兜底数据源）。 */
  stuTeachingTask: string;
  /** 作业/考试密钥交换接口（GET，uid 用 RSA 公钥加密）。 */
  examHas: string;
  /** 作业列表（章节测验 + 见面课测验）。POST，secretStr 为 AES 加密参数。 */
  examHomework: string;
  /** 期末考试列表。POST，secretStr 为 AES 加密参数。 */
  examFinal: string;
  /** 作业考试页面（点任务跳转）。 */
  examPage: string;
}

export const ZhihuishuEndpoints: ZhihuishuEndpointMap = {
  userInfo: 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo',
  courseList: 'https://hike-teaching.zhihuishu.com/educational/platform/getStudentCourseList',
  homeworkList: 'https://hiexam-server.zhihuishu.com/zhsathome/homeworkUser/List',
  homeworkPage: 'https://wenda.zhihuishu.com/stu/courseInfo/homeworkExam/',
  /** 「共享课」列表：请求体 secretStr 是页面加密后的固定查询（status/page）。 */
  shareCourses: 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo',
  /** 共享课学习页（截图实证：recruitAndCourseId 就是列表返回的 secret）。 */
  sharedCoursePage: 'https://studyvideoh5.zhihuishu.com/stuStudy',
  /** 共享课成绩分析页的学习进度接口（免加密，form 传 courseId/recruitId）。 */
  stuLearn: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadStuLearingTab/',
  stuExamScore: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadExamAndScore/',
  stuReport: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadStuLearnReport/',
  stuHabit: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadStuHabit/',
  stuForum: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadCourseForum/',
  stuCertify: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadStudyCertify',
  stuTeachingTask: 'https://stuonline.zhihuishu.com/stuonline/json/stuLearnReportNew/loadTeachingTask/',
  examHas: 'https://appcomm-user.zhihuishu.com/app-commserv-user/c/has',
  examHomework: 'https://studentexam-api.zhihuishu.com/studentExam/gateway/t/v1/student/getStudentHomework',
  examFinal: 'https://taurusexam-api.zhihuishu.com/taurusExam/gateway/t/v1/student/getStudentFinalExam',
  examPage: 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html',
};

/**
 * HAR 里抓到的两个固定查询密文（2026-11-07）。
 *
 * `queryShareCourseInfo` 的请求参数被页面 `window.yxyz()` 用 RSA/AES 加密，
 * 但同一组查询参数（status=1 / status=2，pageNo=1，pageSize=5）的密文在两次 HAR
 * 里完全一致 —— 它是**确定性加密**，不是一次性 token。这里把两份密文固定下来，
 * 分别覆盖「未完成 / 已完成」两个共享课标签；平台改版/轮换密钥时需从新 HAR 更新。
 */
const SHARED_COURSE_SECRETS = [
  'NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K',
  'WfBsR9nN4rmJr8WYuVEa7gS3yO+TJHUNeLBjW3EEIZiRPdqZbDjacXj0jGbYkFAq',
];

export interface ZhihuishuAdapterOptions {
  endpoints?: Partial<ZhihuishuEndpointMap>;
}

export class ZhihuishuAdapter implements PlatformAdapter {
  readonly id = 'zhihuishu';
  readonly displayName = '智慧树';
  readonly homepage = 'https://onlineweb.zhihuishu.com/';
  readonly #ep: typeof ZhihuishuEndpoints;
  /** 作业/考试接口的 AES 密钥，一次同步内复用（密钥由 has 接口每次下发，可缓存一轮）。 */
  #examCKey: string | undefined;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: true,
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
    allowPost: [
      { pattern: /student\/course\/share\/queryShareCourseInfo/, why: '查询共享课列表（只读，POST 只为传加密参数）' },
      {
        pattern: /stuonline\.zhihuishu\.com\/stuonline\/json\//,
        why: '查询共享课学习进度/成绩/教学任务（只读 JSON 接口，POST 只为传 courseId/recruitId）',
      },
      {
        pattern: /(studentexam-api|taurusexam-api)\.zhihuishu\.com\/.*\/student\/getStudent(Homework|FinalExam)/,
        why: '查询共享课作业/章节测验/见面课测验/期末考试列表（只读，POST 只为传加密参数）',
      },
    ],
  };

  /**
   * 智慧树的保活探测：用最便宜的「登录用户信息」接口。
   *
   * 两个都必须对（2026-11-09 排查）：
   *   1. **必须带 `?time=<ms>`**。空参请求平台也会回 `{"code":403,"message":"未登录"}`，
   *      看起来像"会话失效"，其实只是少了个时间戳参数 —— 会把好会话误判成掉线。
   *      这里把 time 先写死成一个固定占位（探活只关心能否拿到 uuid，不关心时间精度），
   *      原生探活直接用这个完整 URL。
   *   2. `alivePattern` 必须同时排除 `"code":403`。仅匹配 `"uuid"` 不够：登录页 HTML
   *      或错误 JSON 里也可能出现 uuid 字样。
   */
  readonly keepAliveProbe = {
    /**
     * 【`{now}` 是占位符，由原生侧在**每次探测时**替换成当前毫秒】（2026-11-10 真机修正）
     *
     * 原来这里写死成 `?time=1`，只为了让探针地址能当静态字符串传给原生。
     * 但平台**是校验这个参数的**：HAR 里每次请求的 time 都是当前毫秒
     * （1794038263328 这种）。写死成 1 属于异常请求，平台可能直接回
     * `{"code":403,"message":"未登录"}` —— 于是**好会话被误判成掉线**，
     * 用户看到的就是"智慧树又失效了"，而实际只是探针参数不对。
     *
     * 为什么不用 JS 侧的 urlFor 回调：原生是**定时唤醒**的（每 20 分钟），
     * 那时 JS 可能根本没在跑，回调取不到。占位符替换是唯一可靠的做法。
     */
    url: 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo?time={now}',
    method: 'GET' as const,
    alivePattern: '"uuid":"[^"]+"',
    intervalMs: 20 * 60 * 1000,
  };

  /**
   * 会话失效时的可能原因，按可能性从高到低（仿 iSmart 的归因原则：顺序直接决定
   * 用户下一步做什么，把罕见原因放前面会让人以为账号被盗）。
   *
   * 智慧树是 **cookie-only 多域会话**（onlineservice-api / hike-teaching / hiexam-server /
   * stuonline … 各自独立 cookie），没有可续期 ticket。实际排查中最常见的是：
   *   1. 手机深睡没联网 → 某次请求失败后会话闲置作废（与 iSmart 同类主因）；
   *   2. 平台侧会话到期（cookie 有效期耗尽）；
   *   3. 在别处登录把本机顶下线。
   * 具体是哪一种，由 recoverSession 的逐域探活证据判定，不靠猜。
   */
  readonly sessionExpiryCauses = [
    '手机在深睡时没给本应用联网，那段空档里会话闲置作废（参见「账号」页后台保活的「未测成」）',
    '智慧树的 cookie 有效期到了（平台侧会话到期，需在官方页面重新登录）',
    '你在别处登录或主动退出了',
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

  /**
   * 【定位根因】逐域探活：智慧树的会话由多个域各自独立的 cookie 组成，掉登录时
   * 必须区分「全域失效」还是「只有某个子域掉了」。仿 iSmart 的做法：在失效那一刻
   * 把每一层域的实测证据（HTTP 状态 / 业务 code / 响应首段）收集起来，交给上层归因。
   *
   * 只打最便宜的只读接口，绝不拉业务数据：
   *   · onlineservice-api  → getLoginUserInfo（主会话，决定 uuid）
   *   · hike-teaching      → getStudentCourseList（课程）
   *   · hiexam-server      → homeworkUser/List（作业，不带课程 → 只看是否被登出）
   */
  async diagnoseDomains(
    ctx: AdapterContext,
    session: Session,
  ): Promise<Array<{ domain: string; ok: boolean; detail: string }>> {
    const http = new SessionHttpClient(ctx, session);
    const now = ctx.clock.nowMs();
    const probes: Array<{ domain: string; url: string; judge: (status: number, text: string) => boolean }> = [
      {
        domain: 'onlineservice-api（主会话/uuid）',
        url: `${this.#ep.userInfo}?time=${now}`,
        judge: (_s, t) => Number((JSON.parse(t || '{}') as { code?: unknown }).code) === 200,
      },
      {
        domain: 'hike-teaching（课程列表）',
        url: `${this.#ep.courseList}?year=&term=&uuid=probe&dateFormate=${now}`,
        judge: (_s, t) => /"rt"\s*:\s*\{/.test(t) || /"status"\s*:\s*"?200/.test(t),
      },
      {
        domain: 'hiexam-server（作业列表）',
        url: `${this.#ep.homeworkList}?courseId=0&pageIndex=1&pageSize=1&key=&completeTab=0&uuid=probe&dateFormate=${now}`,
        judge: (_s, t) => /"rt"\s*:/.test(t),
      },
    ];
    const out: Array<{ domain: string; ok: boolean; detail: string }> = [];
    for (const p of probes) {
      try {
        const res = await http.request({ url: p.url, method: 'GET' });
        const text = await res.text().catch(() => '');
        const head = text.replace(/\s+/g, ' ').slice(0, 100);
        const loggedOut = res.status === 401 || res.status === 403 || /"code"\s*:\s*(401|403)|未登录|请登录|login/i.test(text.slice(0, 2000));
        let ok: boolean;
        try {
          ok = p.judge(res.status, text);
        } catch {
          ok = false;
        }
        out.push({
          domain: p.domain,
          ok,
          detail: `HTTP ${res.status} ${loggedOut ? '判定=未登录 ' : ''}首段=${head}`,
        });
      } catch (e) {
        // 网络/通道问题：明确区别于「会话失效」
        out.push({ domain: p.domain, ok: false, detail: `通道错误（网络/DNS）：${String((e as Error).message ?? e).slice(0, 80)}` });
      }
    }
    return out;
  }

  /**
   * 会话失效时的自动恢复尝试。
   *
   * 智慧树是 cookie-only，没有 iSmart 那样的可续期 ticket —— 我们**无法**在这里
   * 替用户重登（那需要账号密码或官方页面）。所以这个方法不做恢复，只做**归因**：
   * 调 diagnoseDomains 逐域取证，告诉上层「是全灭、还是某个子域掉了、还是没网」，
   * 让同步日志能直接写清根因，而不是笼统一句「登录已失效」。
   */
  async recoverSession(
    ctx: AdapterContext,
    session: Session,
  ): Promise<{
    recovered: boolean;
    note?: string;
    diagnosis?: 'recovered' | 'ticket-expired' | 'mechanism' | 'channel';
  }> {
    const rows = await this.diagnoseDomains(ctx, session);
    const anyOk = rows.some((r) => r.ok);
    const allNetwork = rows.every((r) => /通道错误/.test(r.detail));
    const detail = rows.map((r) => `${r.domain}:${r.ok ? '正常' : '失效'}（${r.detail}）`).join('；');

    if (allNetwork) {
      return {
        recovered: false,
        diagnosis: 'channel',
        note:
          `逐域探活全部是通道错误（网络/DNS 没测成），**不是会话失效**。${detail}`,
      };
    }
    if (anyOk) {
      // 还有域能用 → 不是全域登出，是部分子域 cookie 掉了 / 平台风控只拦了某域
      return {
        recovered: false,
        diagnosis: 'mechanism',
        note:
          `部分域仍可用，但主链路需要的域已失效 —— 属于「部分 cookie 掉线」，不是账号被登出。${detail}`,
      };
    }
    return {
      recovered: false,
      diagnosis: 'ticket-expired',
      note:
        `所有域都判定未登录：会话确实已整体失效（cookie-only，App 无法自动续期，需在官方页面重新登录）。${detail}`,
    };
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
    const items = parseZhihuishuCourses(courses);

    // 「共享课」（如“大学生心理健康”）不在 getStudentCourseList 里，走
    // queryShareCourseInfo。密文是页面加密后的固定查询，见 SHARED_COURSE_SECRETS 注释。
    for (const secret of SHARED_COURSE_SECRETS) {
      try {
        const res = await http.request({
          url: this.#ep.shareCourses,
          method: 'POST',
          form: { secretStr: secret, date: String(ctx.clock.nowMs()) },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        });
        if (res.status >= 400) continue;
        const text = await res.text();
        if (!text.trim().startsWith('{')) continue;
        const parsed = JSON.parse(text) as { result?: { courseOpenDtos?: unknown[] } };
        const list = parsed.result?.courseOpenDtos;
        if (Array.isArray(list)) {
          const known = new Set(items.map((c) => c.platformCourseId));
          for (const c of parseZhihuishuSharedCourses(list)) {
            if (!known.has(c.platformCourseId)) items.push(c);
          }
        }
      } catch {
        // 共享课是附加能力；失败不影响普通课程列表
      }
    }

    return { items, hasMore: false };
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
    const sharedErrors: string[] = [];

    for (const course of req.courses) {
      // 共享课的作业/考试在大类上走 studentexam-api（secretStr 带课程/招生维度），
      // 不能用普通课的 homeworkUser/List —— 那个接口对共享课只返回
      // {currentTime,msg,status}，没有 rt。先跳过，避免把整轮同步判成失败；
      // 共享课的视频任务点和成绩摘要已由 fetchCourseProgress 单独抓取。
      if ((course.raw as { recruitId?: unknown } | undefined)?.recruitId !== undefined) {
        let got = 0;
        try {
          const examTasks = await this.#fetchExamTasks(http, course, ctx);
          got = examTasks.length;
          items.push(...examTasks);
        } catch (e) {
          sharedErrors.push(`${course.name}/作业考试加密接口: ${String((e as Error).message ?? e).slice(0, 240)}`);
        }
        // 加密链路失败/返回空时，退回免加密的章节测验 + 见面课教学任务，
        // 保证这门课至少不是「0 条」。
        if (got === 0) {
          try {
            items.push(...(await this.#listSharedTasks(http, course)));
          } catch (e) {
            sharedErrors.push(`${course.name}/免加密兜底: ${String((e as Error).message ?? e).slice(0, 200)}`);
          }
        }
        continue;
      }
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
    return { items, hasMore: false, ...(sharedErrors.length ? { details: sharedErrors } : {}) };
  }

  /**
   * 共享课的任务点：走成绩分析页的「学习进度」接口（免加密，form 传 courseId/recruitId）。
   * 这里统计**视频任务点**（有子视频按子视频算，单视频按 lesson.videoId 算）；
   * 章节测验、期末考试、平时分属于另外的 Tab，后续单独接。
   */
  async fetchCourseProgress(
    ctx: AdapterContext,
    session: Session,
    courses: UnifiedCourse[],
    req?: FetchCourseProgressRequest,
  ): Promise<Page<CourseProgressItem>> {
    const want = new Set(req?.courseIds ?? []);
    const list = want.size > 0 ? courses.filter((c) => want.has(c.platformCourseId)) : courses;
    const http = new SessionHttpClient(ctx, session);
    const items: CourseProgressItem[] = [];
    const errors: string[] = [];
    for (const c of list) {
      const raw = (c.raw ?? {}) as { recruitId?: string | number };
      if (raw.recruitId === undefined || raw.recruitId === null || raw.recruitId === '') continue;
      try {
        const res = await http.postForm<Record<string, unknown>>(this.#ep.stuLearn, {
          courseId: c.platformCourseId,
          recruitId: String(raw.recruitId),
          type: 'l',
          courseTypeEs: '1',
        });
        const chapter = (res.body.chapterOrLesson ?? null) as { clList?: unknown[] } | null;
        const counts = countVideos(chapter);
        if (counts.total <= 0) continue;
        // 有些账号的章节树只回进度百分比、不回逐视频 watchStatus；此时不要显示 0/78。
        // avgStudiedProcess 是平台自己给的整体观看进度，作为只在 done=0 时的兜底。
        if (counts.done === 0) {
          const studied = parsePercent(
            (res.body as { avgStudiedProcess?: unknown; learnProgress?: unknown }).avgStudiedProcess ??
              (res.body as { learnProgress?: unknown }).learnProgress,
          );
          if (studied !== undefined && studied > 0) counts.done = Math.round((counts.total * studied) / 100);
          // 最后一道兜底：章节树全部显示 addScoreStatus=1 时，视为整门课已完成。
          // 这是平台自己的章节完成标记；只在逐视频/百分比都缺失时使用。
          const chapters = Array.isArray(chapter?.clList) ? chapter!.clList : [];
          const allScored =
            chapters.length > 0 &&
            chapters.every((ch) => typeof ch === 'object' && ch !== null && Number((ch as { addScoreStatus?: unknown }).addScoreStatus) === 1);
          if (counts.done === 0 && allScored) counts.done = counts.total;
        }
        const remain = Math.max(0, counts.total - counts.done);
        const { grade, notes } = await this.#fetchGrade(http, c, res.body);
        errors.push(...notes);
        items.push({
          platformCourseId: c.platformCourseId,
          total: counts.total,
          done: counts.done,
          hasOpenNow: remain > 0,
          ...(remain > 0 ? { availableNow: remain } : {}),
          ...(grade ? { grade } : {}),
        });
      } catch (e) {
        // 共享课进度是附加能力；单门失败不拖垮整批，但留下可排查原因
        errors.push(`${c.name}: ${String((e as Error).message ?? e).slice(0, 300)}`);
      }
    }
    return { items, hasMore: false, declaredTotal: items.length, ...(errors.length ? { details: errors } : {}) };
  }

  /**
   * 平时分/总评/学习习惯/互动分。
   *
   * 成绩有两个**独立的免加密数据源**：loadStuLearnReport 的 ssd，以及
   * loadStudyCertify 的 studentScoreDto（HAR 里后者同样带 totalScore 99 /
   * usualScore 30 / examScore 10 / meetScore 20 / finalScore 39）。
   * 之前只走前者且错误被 safe() 静默吞掉，于是平时分长期不显示；现在两个都试，
   * 并且把每个接口的结果写进 details，失败在「排查信息」里可见。
   */
  async #fetchGrade(
    http: SessionHttpClient,
    c: UnifiedCourse,
    learnBody: Record<string, unknown>,
  ): Promise<{ grade?: CourseGradeSummary; notes: string[] }> {
    const raw = (c.raw ?? {}) as { recruitId?: string | number };
    if (raw.recruitId === undefined || raw.recruitId === null) return { notes: [] };
    const base = { courseId: c.platformCourseId, recruitId: String(raw.recruitId), type: 'l', courseTypeEs: '1' };
    const headers = {
      Origin: 'https://stuonline.zhihuishu.com',
      Referer: `https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index?recruitId=${encodeURIComponent(
        String(raw.recruitId),
      )}&courseId=${encodeURIComponent(c.platformCourseId)}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const notes: string[] = [];
    // 带 AJAX 头与不带都试一遍：不同版本的服务端对自定义头的容忍度不一样。
    const safe = async (label: string, url: string, form: Record<string, string>): Promise<Record<string, unknown>> => {
      for (const opts of [{ headers }, {}]) {
        try {
          const r = await http.postForm<Record<string, unknown>>(url, form, opts);
          if (r.body && typeof r.body === 'object') return r.body;
        } catch (e) {
          notes.push(`${label}: ${String((e as Error).message ?? e).slice(0, 160)}`);
        }
      }
      notes.push(`${label}: 未拿到 JSON 响应`);
      return {};
    };
    const [report, certify, habit, forum] = await Promise.all([
      safe('成绩总表', this.#ep.stuReport, { courseId: base.courseId, recruitId: base.recruitId, stuRankType: 'classRank' }),
      safe('成绩证明', this.#ep.stuCertify, { courseId: base.courseId, recruitId: base.recruitId }),
      safe('学习习惯', this.#ep.stuHabit, base),
      safe('互动分', this.#ep.stuForum, base),
    ]);
    const ssd = (report.ssd ?? (report.data as { ssd?: unknown } | undefined)?.ssd ?? {}) as Record<string, unknown>;
    const cert = (certify.studentScoreDto ?? (certify.data as { studentScoreDto?: unknown } | undefined)?.studentScoreDto ?? {}) as Record<string, unknown>;
    const habitBody = (habit.data ?? habit) as Record<string, unknown>;
    const forumBody = (forum.data ?? forum) as Record<string, unknown>;
    const rules = (learnBody.scoreAssessRuleDto ?? {}) as Record<string, unknown>;
    const pick = (a: Record<string, unknown>, b: Record<string, unknown>, ...keys: string[]) => {
      for (const k of keys) {
        const v = numeric(a[k] ?? b[k]);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const habitScore = numeric(habitBody.learnedHabitScore);
    const habitTotal = numeric(habitBody.learnedHabitTotalScore ?? rules.learnedHabitScoreShare);
    const interactionScore = numeric(forumBody.learnedInteractiveScore);
    const interactionTotal = numeric(forumBody.learnedInteractiveTotalScore ?? rules.learnedInteractiveScoreShare);
    const grade: CourseGradeSummary = {
      ...(pick(ssd, cert, 'totalScore', 'checkScore') !== undefined
        ? { totalScore: pick(ssd, cert, 'totalScore', 'checkScore') }
        : {}),
      ...(pick(ssd, cert, 'usualScore') !== undefined ? { usualScore: pick(ssd, cert, 'usualScore') } : {}),
      ...(pick(ssd, cert, 'finalScore') !== undefined ? { finalScore: pick(ssd, cert, 'finalScore') } : {}),
      ...(pick(ssd, cert, 'examScore') !== undefined ? { examScore: pick(ssd, cert, 'examScore') } : {}),
      ...(pick(ssd, cert, 'meetScore') !== undefined ? { meetScore: pick(ssd, cert, 'meetScore') } : {}),
      ...(pick(ssd, cert, 'courseScore', 'progressScore') !== undefined
        ? { studyScore: pick(ssd, cert, 'courseScore', 'progressScore') }
        : {}),
      ...(habitScore !== undefined ? { habitScore, ...(habitTotal !== undefined ? { habitTotal } : {}) } : {}),
      ...(interactionScore !== undefined
        ? { interactionScore, ...(interactionTotal !== undefined ? { interactionTotal } : {}) }
        : {}),
    };
    const found = Object.keys(grade).length > 0;
    if (!found) notes.push('成绩接口均未返回可解析的分数');
    return { ...(found ? { grade } : {}), notes: notes.slice(0, 6) };
  }

  /** 作业列表页；点作业名先落到这门课的作业列表（具体作业的直达 URL 需要页面状态，先不猜）。 */
  buildTaskUrl(courseId: string, _task: PlatformTask): string | undefined {
    return `${this.#ep.homeworkPage}?courseId=${encodeURIComponent(courseId)}`;
  }

  /**
   * 课程页：共享课（有 `raw.secret`/`recruitId`）走 `studyvideoh5` 学习页；
   * 普通课用 `raw.homepage`；都没有就落到作业列表页。
   */
  buildCourseUrl(course: UnifiedCourse): string | undefined {
    const raw = (course.raw ?? {}) as { secret?: string; recruitId?: string | number; homepage?: string };
    if (raw.secret && raw.recruitId !== undefined) {
      return `${this.#ep.sharedCoursePage}?recruitAndCourseId=${encodeURIComponent(String(raw.secret))}&studyStatus=1`;
    }
    if (raw.homepage && /^https?:\/\//i.test(raw.homepage)) return raw.homepage;
    return undefined;
  }

  /** 取登录用户 uuid。失败一律明确报 AUTH_REQUIRED，不能静默空列表。 */
  async #uuid(http: SessionHttpClient, ctx: AdapterContext): Promise<string> {
    const body = await this.#getJson(http, `${this.#ep.userInfo}?time=${ctx.clock.nowMs()}`);
    const uuid = (body.result as { uuid?: unknown } | undefined)?.uuid;
    if (Number(body.code) === 200 && typeof uuid === 'string' && uuid) return uuid;
    // 只有平台**明确**说「未登录/会话失效」才是 auth-required。
    // 其它一切（JSON 结构变了、平台临时 5xx、返回空 result）都当 upstream，
    // 否则会被 UI 显示成「登录已失效」，把用户赶去重登 —— 而其实他根本不需要。
    const code = Number(body.code);
    const msg = String((body.message ?? body.msg ?? '') as string);
    const looksLoggedOut = code === 403 || code === 401 || /未登录|会话|失效|重新登录/.test(msg);
    if (looksLoggedOut) {
      throw new HubError('AUTH_REQUIRED', `智慧树会话已失效（${msg || `code=${code}`}），请重新登录`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    throw new HubError(
      'UPSTREAM',
      `智慧树用户信息接口异常（code=${code || '空'}，未拿到 uuid）：${JSON.stringify(body).slice(0, 200)}`,
      { platformId: this.id },
    );
  }

  /**
   * 取作业/考试接口的 AES 密钥。
   *
   * uid 用平台公钥本地生成（PKCS#1 v1.5），has 接口免登录；返回的 sl 是平台
   * 私钥签发的块，用同一把公钥做 c^e mod n 还原出 cKey。详见 exam-crypto.ts。
   */
  async #examCKeyFor(http: SessionHttpClient): Promise<string> {
    if (this.#examCKey) return this.#examCKey;
    const uid = rsaEncryptUid('{"module":3}');
    const res = await http.getJson<{ rt?: { sl?: unknown } }>(
      `${this.#ep.examHas}?uid=${encodeURIComponent(uid)}`,
    );
    const sl = res.body?.rt?.sl;
    if (typeof sl !== 'string' || !sl) {
      throw new HubError('UPSTREAM', '智慧树密钥交换接口未返回 sl');
    }
    const cKey = recoverSl(sl)?.cKey;
    if (!cKey) throw new HubError('UPSTREAM', '智慧树密钥交换返回无法解析');
    this.#examCKey = cKey;
    return cKey;
  }

  /** 共享课的作业/考试：复现页面加密，拿章节测验 + 见面课测验 + 期末考试。 */
  async #fetchExamTasks(
    http: SessionHttpClient,
    course: UnifiedCourse,
    ctx: AdapterContext,
  ): Promise<PlatformTask[]> {
    const raw = (course.raw ?? {}) as { recruitId?: string | number };
    if (raw.recruitId === undefined || raw.recruitId === null) return [];
    const recruitId = String(raw.recruitId);
    const courseIdNum = Number(course.platformCourseId);
    if (!Number.isFinite(courseIdNum)) return [];
    const cKey = await this.#examCKeyFor(http);
    const examPage = `${this.#ep.examPage}#/webExamList/?recruitId=${encodeURIComponent(recruitId)}`;

    const homeworkRows = async (flag: 1 | 2): Promise<unknown[]> => {
      const secretStr = buildSecretStr(
        { recruitId, courseId: courseIdNum, flag, pageSize: 100, pageNum: 0 },
        cKey,
      );
      const res = await http.postForm<{ rt?: { studentHomeworkList?: unknown[] } }>(
        this.#ep.examHomework,
        { secretStr },
      );
      const list = res.body?.rt?.studentHomeworkList;
      return Array.isArray(list) ? list : [];
    };
    let homework = await homeworkRows(2);
    if (homework.length === 0) homework = await homeworkRows(1);

    const finalSecret = buildSecretStr({ courseId: courseIdNum, recruitId, flag: 2 }, cKey);
    const finalRes = await http.postForm<{ rt?: unknown[] }>(this.#ep.examFinal, {
      secretStr: finalSecret,
    });
    const finals = Array.isArray(finalRes.body?.rt) ? (finalRes.body!.rt as unknown[]) : [];

    const tasks = parseZhihuishuExamTasks(homework, finals, course, examPage, ctx.clock.now());
    if (tasks.length === 0) {
      throw new HubError('UPSTREAM', `作业考试接口返回空（has 密钥已获取，flag2=${homework.length} 条）`);
    }
    return tasks;
  }

  /**
   * 免加密兜底：见面课教学任务。loadTeachingTask 的 taskName 与作业考试页
   * 的「见面课测验」一一对应，但只有上课时间、没有真正的截止/考试 ID。
   */
  async #listTeachingTasks(http: SessionHttpClient, course: UnifiedCourse): Promise<PlatformTask[]> {
    const raw = (course.raw ?? {}) as { recruitId?: string | number };
    if (raw.recruitId === undefined || raw.recruitId === null) return [];
    const res = await http.postForm<{ teachingTask?: unknown[] }>(this.#ep.stuTeachingTask, {
      courseId: course.platformCourseId,
      recruitId: String(raw.recruitId),
      type: 'l',
      courseTypeEs: '1',
    });
    const rows = Array.isArray(res.body?.teachingTask) ? (res.body!.teachingTask as unknown[]) : [];
    return parseZhihuishuTeachingTasks(rows, course);
  }

  /** 共享课的章节测验（加密链路失败时的兜底）。 */
  async #listSharedTasks(http: SessionHttpClient, course: UnifiedCourse): Promise<PlatformTask[]> {
    const raw = (course.raw ?? {}) as { recruitId?: string | number };
    if (raw.recruitId === undefined || raw.recruitId === null) return [];
    const base = { courseId: course.platformCourseId, recruitId: String(raw.recruitId), type: 'l', courseTypeEs: '1' };
    const learn = await http.postForm<Record<string, unknown>>(this.#ep.stuLearn, base);
    const chapter = (learn.body.chapterOrLesson ?? null) as { clList?: unknown[] } | null;
    const chapters = Array.isArray(chapter?.clList) ? chapter!.clList : [];
    const nameById = new Map<string, string>();
    const ids: string[] = [];
    for (const ch of chapters) {
      if (typeof ch !== 'object' || ch === null) continue;
      const c = ch as { chapterId?: unknown; chapterName?: unknown };
      if (c.chapterId === undefined || c.chapterId === null) continue;
      const id = String(c.chapterId);
      ids.push(id);
      nameById.set(id, typeof c.chapterName === 'string' ? c.chapterName : `章节 ${ids.length}`);
    }
    if (ids.length === 0) return this.#listTeachingTasks(http, course);
    const scoreRes = await http.postForm<Record<string, unknown>>(this.#ep.stuExamScore, {
      recruitId: String(raw.recruitId),
      chapterIds: ids.join(','),
      lessonIds: '',
      lessonType: '',
    });
    const sldList = Array.isArray(scoreRes.body.sldList) ? (scoreRes.body.sldList as unknown[]) : [];
    const out: PlatformTask[] = [];
    // 某些版本的 loadExamAndScore 对该课程返回空 sldList；此时仍把章节测验条目
    // 从 loadStuLearingTab 的章节树里落出来，不能把“有章节测验但没分数”吞成 0 条。
    if (sldList.length === 0) {
      for (const ch of chapters) {
        if (typeof ch !== 'object' || ch === null) continue;
        const c = ch as { chapterId?: unknown; chapterName?: unknown; examName?: unknown; addScoreStatus?: unknown };
        if (c.chapterId === undefined || c.chapterId === null) continue;
        const name = typeof c.chapterName === 'string' ? c.chapterName : String(c.chapterId);
        out.push({
          platformTaskId: `chapter-quiz-${String(c.chapterId)}`,
          courseId: course.platformCourseId,
          courseName: course.name,
          kind: 'quiz',
          title: `章节测验 · ${typeof c.examName === 'string' && c.examName ? c.examName : name}`,
          status: Number(c.addScoreStatus) === 1 ? 'graded' : 'pending',
          raw: c,
        });
      }
      out.push(...(await this.#listTeachingTasks(http, course)));
      return out;
    }
    for (const row of sldList) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const chapterId = r.chapterId === undefined || r.chapterId === null ? '' : String(r.chapterId);
      if (!chapterId) continue;
      const state = Number(r.state);
      const score = numeric(r.stuScore);
      out.push({
        platformTaskId: `chapter-quiz-${chapterId}`,
        courseId: course.platformCourseId,
        courseName: course.name,
        kind: 'quiz',
        title: `章节测验 · ${nameById.get(chapterId) ?? chapterId}`,
        status: state === 4 ? 'graded' : 'pending',
        ...(score !== undefined ? { score } : {}),
        ...(numeric(r.examScore) !== undefined ? { totalScore: numeric(r.examScore) } : {}),
        raw: r,
      });
    }
    out.push(...(await this.#listTeachingTasks(http, course)));
    return out;
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
    // 智慧树很多接口是 **HTTP 200 + 业务 code=401/403**（真机实证）。
    // 只判 HTTP 状态会把它当 UPSTREAM，从而**不触发逐域定位**，也就查不出根因。
    // 这里把业务层的未登录也归成 AUTH_REQUIRED，和 HTTP 401/403 走同一条排查路径。
    const bcode = Number((res.body as { code?: unknown; status?: unknown }).code ?? (res.body as { status?: unknown }).status);
    const bmsg = String((res.body as { message?: unknown; msg?: unknown }).message ?? (res.body as { msg?: unknown }).msg ?? '');
    if ((bcode === 401 || bcode === 403) || (/未登录|请登录|重新登录|会话.*失效/.test(bmsg) && !('rt' in res.body))) {
      throw new HubError('AUTH_REQUIRED', `智慧树会话已失效（业务层未登录 code=${bcode || '空'} ${bmsg.slice(0, 40)}）`, {
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

/** 解析共享课列表（courseOpenDtos；字段来自 2026-11-07 HAR）。 */
export function parseZhihuishuSharedCourses(list: unknown[]): PlatformCourse[] {
  const out: PlatformCourse[] = [];
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = r.courseId;
    const name = r.courseName;
    if (id === undefined || id === null || typeof name !== 'string' || !name.trim()) continue;
    out.push({
      platformCourseId: String(id),
      name: name.trim(),
      teacher: typeof r.teacherName === 'string' ? r.teacherName : undefined,
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

function parsePercent(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const m = /([\d.]+)\s*%/.exec(v);
    if (m) return Number(m[1]);
  }
  return numeric(v);
}

/** 平台时间是北京墙上时间（"2025-12-18 23:59:59"），转成 ISO。 */
function wallTimeToIso(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined;
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 23),
    Number(m[5] ?? 59),
    Number(m[6] ?? 0),
  );
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 作业/考试接口原始行 → 任务（字段名来自 2026-11-09 HAR）。
 *
 * getStudentHomework 一次返回 8 条：meetCourseType=1 是见面课测验（4 条），
 * 0 是章节测验（4 条）；getStudentFinalExam 返回期末考试。
 * state=4 表示已出分。章节测验的 ID 与免加密兜底保持一致，避免切换数据源时重复。
 */
export function parseZhihuishuExamTasks(
  homeworkRows: unknown[],
  finalRows: unknown[],
  course: { platformCourseId: string; name: string },
  examPageUrl?: string,
  now: Date = new Date(),
): PlatformTask[] {
  const out: PlatformTask[] = [];
  const seen = new Set<string>();
  for (const row of homeworkRows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.examName === 'string' ? r.examName.trim() : '';
    const id = r.id ?? r.examId;
    if (!name || id === undefined || id === null) continue;
    const meet = Number(r.meetCourseType) === 1;
    const chapterId = r.chapterId;
    const key =
      !meet && chapterId !== undefined && chapterId !== null
        ? `chapter-quiz-${String(chapterId)}`
        : `${meet ? 'meet-quiz' : 'quiz'}-${String(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = Number(r.state);
    const end = typeof r.endDate === 'string' ? r.endDate : undefined;
    const endIso = wallTimeToIso(end);
    const expired = endIso !== undefined && new Date(endIso).getTime() < now.getTime();
    out.push({
      platformTaskId: key,
      courseId: course.platformCourseId,
      courseName: course.name,
      kind: 'quiz',
      title: `${meet ? '见面课测验' : '章节测验'} · ${name}`,
      status: state >= 3 ? 'graded' : expired ? 'expired' : 'pending',
      ...(end ? { deadline: end } : {}),
      ...(typeof r.startTime === 'string' ? { publishedAt: wallTimeToIso(r.startTime) } : {}),
      ...(numeric(r.score) !== undefined ? { score: numeric(r.score) } : {}),
      ...(numeric(r.totalScore) !== undefined ? { totalScore: numeric(r.totalScore) } : {}),
      ...(examPageUrl ? { sourceUrl: examPageUrl } : {}),
      raw: r,
    });
  }
  for (const row of finalRows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.examName === 'string' ? r.examName.trim() : '';
    const id = r.id ?? r.examId;
    if (!name || id === undefined || id === null) continue;
    const key = `final-exam-${String(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = Number(r.state);
    const end = typeof r.endDate === 'string' ? r.endDate : undefined;
    const endIso = wallTimeToIso(end);
    const expired = endIso !== undefined && new Date(endIso).getTime() < now.getTime();
    out.push({
      platformTaskId: key,
      courseId: course.platformCourseId,
      courseName: course.name,
      kind: 'exam',
      title: `期末考试 · ${name}`,
      status: state >= 3 ? 'graded' : expired ? 'expired' : 'pending',
      ...(typeof r.startTime === 'string' ? { startsAt: wallTimeToIso(r.startTime) } : {}),
      ...(end ? { deadline: end } : {}),
      ...(numeric(r.score) !== undefined ? { score: numeric(r.score) } : {}),
      ...(numeric(r.totalScore) !== undefined ? { totalScore: numeric(r.totalScore) } : {}),
      ...(examPageUrl ? { sourceUrl: examPageUrl } : {}),
      raw: r,
    });
  }
  return out;
}

/** 免加密兜底：loadTeachingTask 的见面课教学任务 → 见面课测验条目。 */
export function parseZhihuishuTeachingTasks(
  rows: unknown[],
  course: { platformCourseId: string; name: string },
): PlatformTask[] {
  const out: PlatformTask[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.taskName === 'string' ? r.taskName.trim() : '';
    const id = r.id ?? r.linkId;
    if (!name || id === undefined || id === null) continue;
    const learnTime = typeof r.learnTime === 'string' ? r.learnTime : undefined;
    const score = numeric(r.testingScore ?? r.examScore ?? r.checkScore);
    out.push({
      platformTaskId: `meet-course-${String(id)}`,
      courseId: course.platformCourseId,
      courseName: course.name,
      kind: 'quiz',
      title: `见面课测验 · ${name}`,
      status: Number(r.isAddScore) === 1 ? 'graded' : 'pending',
      ...(learnTime ? { publishedAt: wallTimeToIso(learnTime) } : {}),
      ...(score !== undefined ? { score } : {}),
      raw: r,
    });
  }
  return out;
}

/** 统计共享课「学习进度」里的视频任务点（只看 watchStatus==1 记为已完成）。 */
function countVideos(chapter: { clList?: unknown[] } | null): { total: number; done: number } {
  let total = 0;
  let done = 0;
  const chapters = Array.isArray(chapter?.clList) ? chapter!.clList : [];
  for (const ch of chapters) {
    if (typeof ch !== 'object' || ch === null) continue;
    const lessons = (ch as { lessonTempDtos?: unknown[] }).lessonTempDtos;
    if (!Array.isArray(lessons)) continue;
    for (const lesson of lessons) {
      if (typeof lesson !== 'object' || lesson === null) continue;
      const l = lesson as {
        videoId?: unknown;
        watchStatus?: unknown;
        lessonVideoTempDtos?: unknown[];
      };
      const videos = Array.isArray(l.lessonVideoTempDtos) ? l.lessonVideoTempDtos : [];
      if (videos.length > 0) {
        for (const v of videos) {
          if (typeof v !== 'object' || v === null) continue;
          total += 1;
          if (Number((v as { watchStatus?: unknown }).watchStatus) >= 1) done += 1;
        }
      } else if (Number(l.videoId) > 0) {
        total += 1;
        if (Number(l.watchStatus) >= 1) done += 1;
      }
    }
  }
  return { total, done };
}
