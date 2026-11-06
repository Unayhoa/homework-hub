/**
 * 超星学习通适配器（experimental）。
 *
 * ⚠️ 重要前提，请先读完再用：
 * 本文件里所有接口路径来自社区开源项目的公开信息
 * （SuperStarInfoFetch、chaoxing-toolkit 等），我**没有用真实账号逐条验证过**。
 * 平台的鉴权参数、字段名、风控策略都在持续变化，你很可能需要按实际情况修正。
 *
 * 因此本适配器的设计目标是「改起来便宜、坏起来响亮」：
 *   - 所有端点集中在 ChaoxingEndpoints，改路径不用碰逻辑；
 *   - 每个解析点都做结构校验，读不到预期字段就抛 schemaDrift，
 *     绝不静默返回空数组（静默返回空 = 用户以为作业做完了）；
 *   - 会话失效、验证码、风控分别映射到不同错误码，UI 能给出对的提示；
 *   - 只读。本适配器不做任何提交、签到、刷课类操作，只读取作业与考试信息。
 *
 * 已知的鉴权难点（也是它必须先修的原因）：
 *   1. `ut` 参数：作业/考试接口的 `ut=s` 只是一个占位符，真实鉴权靠
 *      cookie 里的 _uid/_d 与 JSESSIONID。若平台换成签名方案，就要接 NativeSigner。
 *   2. 密码登录可能被要求图形验证码，此时会返回 HTML 而不是 JSON。
 *
 * 开发建议：先用真机登录拿到 cookie，再用 HH_LOG=debug 观察每个请求的返回，
 * 逐步修正 ChaoxingEndpoints 与解析正则。
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
import type { PlatformCourse, TaskPointWindow, UnifiedCourse } from '#core/domain/course.ts';
import { normalizeDeadline } from '#core/domain/deadline.ts';
import type { PlatformTask, TaskKind, TaskStatus } from '#core/domain/task.ts';
import type { Credentials, Session } from '#core/ports/vault.ts';
import type { ReadOnlyPolicy } from '#core/ports/read-only.ts';
import { HubError, schemaDrift } from '#core/domain/errors.ts';
import { normalizeTitle } from '#core/domain/ids.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';
import { mapLimit } from '#core/engine/http-pipeline.ts';
import {
  firstGroup,
  looksLikeAuthWall,
  matchAll,
  queryParam,
  splitBlocks,
  stripTags,
} from '#core/infra/html.ts';

/**
 * 端点表。平台改版时只需要改这里。
 * 标注 TODO(verify) 的是我根据公开信息推断、最需要你用真实账号确认的路径。
 *
 * 用显式 interface 而不是 `as const`：`as const` 会把每个字段收窄成字面量类型，
 * 于是 `{ ...ChaoxingEndpoints, ...用户覆盖 }` 的推断类型就对不上了
 * （覆盖值只是 string，不是那个字面量）。显式 interface 既保留了 keyof 的键名信息，
 * 又允许覆盖。
 */
export interface ChaoxingEndpointMap {
  /** 账号密码登录。返回 JSON，而非重定向。 */
  login: string;
  /**
   * 课程任务点页（课程目录）。**返回 HTML**，课程级统计在页面头部：
   *   `<h2 class="xs_head_name">已完成任务点: <span>0</span>/2`
   *
   * 需要 `stuenc`（= 课程页地址里的 enc），与考试列表同源；不带它页面可能是空的。
   * 2026-11-02 HAR 实证。
   */
  courseCatalog: string;
  /**
   * 课程列表（JSON）。社区多方验证的主路径：返回 channelList[]，
   * 每个课程频道的 content.course.data[0] 带 name 与 courseSquareUrl
   * （内含 courseId/classId），频道上有 cpi。
   */
  courseData: string;
  /** 课程列表（HTML 备用）。courseData 失败时回退到旧版页面解析。 */
  courseList: string;
  /**
   * 作业列表（HTML）。注意：**返回的是 HTML 而非 JSON**，
   * 每门课一个页面，条目是 <li>：状态（未交/已交）、标题（<p>）、
   * 截止信息（span.fr，形如「剩余24小时30分钟」）。
   */
  workTaskList: string;
  /** 作业列表（旧版 JSON 备用）。部分环境返回 JSON，作为回退尝试。 */
  workList: string;
  /**
   * 考试列表页（服务端渲染的 HTML 列表）。
   *
   * 来源是用户提供的 HAR（2026-11-01），不是猜的：
   * `GET mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list?courseid=&clazzid=&cpi=&ut=s&t=&stuenc=`
   * → 200 / text/html / 32KB，里面每条是一个 `<li>`：
   *   `<p class="overHidden2 fl">期中考试</p>`  ← 标题
   *   `<p class="status fl">未开始</p>`          ← 状态
   *   `onclick="goTest('courseId',examId,0,'2026-11-02 11:40:00.0',…)"` ← **时间在这里**
   *
   * 走过两次弯路，记下来免得再踩：
   *   1. `mooc-ans/exam/test/getAllExam` —— 404 死路径（继承自早期社区代码，从没验证）
   *   2. `mooc-ans/exam/phone/task-list` —— 路径存在但返回的是**空壳页面**：
   *      只有隐藏 input（courseId/classId/cpi/pageNum/vx），列表由 JS 再拉，
   *      服务端 HTML 里 `<li>` 数为 0。
   *
   * 注意参数名是全小写 `courseid`/`clazzid`（作业接口用的是驼峰 `courseId`/`classId`）。
   */
  examTaskList: string;
  /** 会话探测：读取当前登录用户信息，最轻量的接口。 */
  userInfo: string;
}

/**
 * 每轮最多翻多少个考试详情页去取开考时间。
 *
 * 一场待考考试 +1 个请求；正常学期个位数。设上限是因为超星风控对请求量敏感，
 * 而"开考时间"是附加信息 —— 拿不到就退化成只显示结束时间，不影响考试本身。
 */
const EXAM_TIME_LIMIT = 8;

export const ChaoxingEndpoints: ChaoxingEndpointMap = {
  login: 'https://passport2.chaoxing.com/fanyalogin',
  // 课程目录页（任务点统计）。HAR 实证 2026-11-02：mooc2-ans 域，必须带 stuenc
  courseCatalog: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse',
  courseData: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
  courseList: 'https://mooc1-2.chaoxing.com/visit/interaction',
  workTaskList: 'https://mooc1-api.chaoxing.com/work/task-list',
  workList: 'https://mooc1.chaoxing.com/mooc-ans/work/getAllWork',
  examTaskList: 'https://mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list',
  userInfo: 'https://passport2.chaoxing.com/api/logged',
};

export interface ChaoxingAdapterOptions {
  endpoints?: Partial<ChaoxingEndpointMap>;
}

/** 课程卡片解析结果，用于后续拼装课程与作业请求参数。 */
interface CourseRef {
  platformCourseId: string;
  classId: string;
  /** 课程主页参数，作业列表接口（work/task-list）需要它 */
  cpi?: string;
  /**
   * 课程页 URL 上的 `enc`。
   *
   * 考试列表页（`exam-ans/mooc2/exam/exam-list`）把它当 `stuenc` 传 —— 2026-11-01
   * 从 HAR 实证：课程页地址里的 `enc=3c5087045e9388…` 与考试列表的 `stuenc` 是同一个值。
   * 拿不到时退化为不传（见 #fetchExamListHtml 的多变体尝试）。
   */
  enc?: string;
  /** 课程卡片上的完整链接（可能带 enc/t）。点击跳转时优先用它。 */
  squareUrl?: string;
  name: string;
  teacher?: string;
}

export class ChaoxingAdapter implements PlatformAdapter {
  readonly id = 'chaoxing';
  readonly displayName = '超星学习通';
  readonly homepage = 'https://i.chaoxing.com';
  readonly #ep: typeof ChaoxingEndpoints;
  /**
   * 最近一次「点击时解析链接」的失败定位轨迹。
   * 只进日志 / 界面的诊断提示，不参与业务判断；一次解析最多十几条。
   */
  #resolveTrace: string[] = [];

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: true,
    // 作业/考试接口没有可靠的「增量」语义，每次都是全量列表
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    // 学习通对非官方客户端有风控，登录频繁会出验证码
    aggressiveAntiBot: true,
  };


  readonly authMethods: AuthMethod[] = [
    {
      id: 'password',
      label: '账号密码（支持自动重登）',
      kind: 'password',
      fields: [
        { key: 'username', label: '手机号或账号' },
        { key: 'password', label: '密码', secret: true },
      ],
      hint:
        '记住密码后会话失效会自动重新登录（一键同步）。' +
        '频繁登录可能触发图形验证码，被挡住时改用「应用内登录」。',
    },
    {
      id: 'in-app',
      label: '应用内登录',
      kind: 'in-app',
      fields: [],
      loginUrl: 'https://i.chaoxing.com',
      hint: '会打开学习通官方登录页，你正常登录即可 —— cookie 由系统保管，本应用读不到也存不了。',
    },
  ];

  /**
   * 只读策略。
   *
   * 超星的作业/考试列表接口虽然是 POST，但它们是**纯查询**，不会改变任何状态，
   * 所以逐条放行并写明用途。除此之外适配器不发任何非 GET 请求 ——
   * 所有可能改变服务端状态的路径（work/submit、exam/submit、签到等）
   * 都会被默认黑名单拦下。
   */
  readonly readOnlyPolicy: ReadOnlyPolicy = {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [
      { pattern: /fanyalogin/, why: '账号密码登录' },
      { pattern: /mooc-ans\/work\/getAllWork/, why: '查询作业列表（只读）' },
      { pattern: /mooc-ans\/exam\/test\/getAllExam/, why: '查询考试列表（只读）' },
      { pattern: /visit\/courselistdata/, why: '查询课程列表（只读，POST 只为传参数）' },
    ],
  };

  constructor(opts: ChaoxingAdapterOptions = {}) {
    this.#ep = { ...ChaoxingEndpoints, ...opts.endpoints };
  }

  // ---------------------------------------------------------------- 登录

  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const now = ctx.clock.now().toISOString();

    // 路径 A：直接粘贴 cookie（推荐，绕过验证码）
    // 标记为 imported —— 引擎据此保证永不主动重新登录，
    // 避免把用户正在用的浏览器/App 会话顶下线。
    if (cred.cookie) {
      return {
        platformId: this.id,
        accountId: '',
        origin: 'imported',
        cookies: parseCookieHeader(cred.cookie),
        headers: { Referer: this.homepage },
        issuedAt: now,
      };
    }

    // 路径 B：账号密码
    const session: Session = {
      platformId: this.id,
      accountId: '',
      cookies: {},
      headers: {
        Referer: 'https://passport2.chaoxing.com/login',
        Origin: 'https://passport2.chaoxing.com',
      },
      issuedAt: now,
    };
    const http = new SessionHttpClient(ctx, session);

    const body = new URLSearchParams({
      uname: cred.username ?? '',
      password: cred.password ?? '',
      refer: 'https%3A%2F%2Fi.chaoxing.com',
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '0',
      independentId: '0',
    });

    const res = await http.request({
      url: this.#ep.login,
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const text = await res.text();

    let parsed: { status?: boolean | number; msg?: string; message?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // 返回 HTML 说明大概率被验证码/风控拦住了。这是超星最常见的失败形态，
      // 必须给出可操作的提示，而不是一句「登录失败」。
      if (looksLikeAuthWall(text)) {
        throw new HubError(
          'CAPTCHA_REQUIRED',
          '超星返回了登录/验证页面，可能是账号密码错误或触发了图形验证码。' +
            '建议改用「手动粘贴 Cookie」方式登录。',
          { platformId: this.id, requiresUserAction: true },
        );
      }
      throw schemaDrift(this.id, `登录接口返回非 JSON：${text.slice(0, 160)}`);
    }

    const ok = parsed.status === true || parsed.status === 1;
    if (!ok) {
      throw new HubError('AUTH_FAILED', `超星登录失败：${parsed.msg ?? parsed.message ?? '账号或密码错误'}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    // 注意：不要用「session.cookies 是否为空」判断风控 ——
    // Android 上 cookie 由原生 CookieManager 保管（凭据不过手），JS 侧 session.cookies
    // 本来就是空的（iSmart 那边踩过同一个坑，这里是漏改的第二处）。
    // 登录真伪交给下面的接口探测裁决：能拉到课程就是真的登录成功。
    return { ...session, origin: 'derived', displayName: cred.username };
  }

  // ---------------------------------------------------------------- 会话探测

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const http = new SessionHttpClient(ctx, session);
    try {
      const res = await http.getJson<{ status?: boolean | number }>(this.#ep.userInfo);
      return res.body?.status === true || res.body?.status === 1;
    } catch (e) {
      if (e instanceof HubError && e.code === 'AUTH_REQUIRED') return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- 课程

  async fetchCourses(ctx: AdapterContext, session: Session, _req?: FetchCoursesRequest): Promise<Page<PlatformCourse>> {
    const http = new SessionHttpClient(ctx, session);

    // 主路径：JSON 接口（社区多方验证）。HTML 页面结构常改版，JSON 稳定得多。
    let refs: CourseRef[];
    try {
      const res = await http.request({ url: this.#ep.courseData, method: 'GET' });
      const text = await res.text();
      if (looksLikeAuthWall(text)) {
        throw new HubError('AUTH_REQUIRED', '超星课程接口返回登录页，会话已失效', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      refs = parseBackclazzData(text);
    } catch (e) {
      // 登录类错误直接上抛；接口改版/网络问题回退到旧版 HTML 页面
      if (e instanceof HubError && (e.code === 'AUTH_REQUIRED' || e.code === 'CAPTCHA_REQUIRED')) throw e;
      const fallback = await this.#fetchCoursesHtml(http);
      if (fallback.length > 0) return this.#coursesPage(fallback);
      // 两条路都空 —— 把主路径的失败原因报出来，别让用户看到莫名其妙的空
      throw e;
    }

    if (refs.length === 0) {
      // JSON 通了但没解析出课程：要么真没课，要么字段结构变了。
      // 回退 HTML 再试一次，两条都空才认输。
      const fallback = await this.#fetchCoursesHtml(http);
      if (fallback.length > 0) return this.#coursesPage(fallback);
      throw schemaDrift(this.id, '课程接口返回了数据但未解析出任何课程（channelList 结构可能已变化）');
    }

    return this.#coursesPage(refs);
  }

  #coursesPage(refs: CourseRef[]): Page<PlatformCourse> {
    return {
      items: refs.map((r) => ({
        platformCourseId: r.platformCourseId,
        name: r.name,
        teacher: r.teacher,
        // classId / cpi 不放进 PlatformCourse（不是课程标识），
        // 但作业接口需要它们 —— 塞进 raw 里随课程一起缓存，避免请求翻倍。
        raw: { classId: r.classId, cpi: r.cpi, enc: r.enc, squareUrl: r.squareUrl },
      })),
      hasMore: false,
      declaredTotal: refs.length,
    };
  }

  /** 旧版 HTML 课程页，作为 JSON 接口失败时的回退。 */
  async #fetchCoursesHtml(http: SessionHttpClient): Promise<CourseRef[]> {
    try {
      const res = await http.request({ url: this.#ep.courseList, method: 'GET' });
      const html = await res.text();
      if (looksLikeAuthWall(html)) return [];
      return this.#parseCourseRefs(html);
    } catch {
      return [];
    }
  }

  /**
   * 从课程页 HTML 里抠出课程。
   *
   * 超星课程卡片的 href 形如：
   *   /visit/interaction?superstarClass=0
   *   /mycourse/studentstudy?courseId=2xxxxx&clazzid=1xxxxx&...
   * courseId 与 clazzid 都在 query 里，所以按 href 提取比按 DOM 结构提取更稳 ——
   * 页面样式改版时链接参数通常不变。
   */
  #parseCourseRefs(html: string): CourseRef[] {
    const blocks = splitBlocks(html, /<div[^>]*class=["'][^"']*(?:course|mycourse)[^"']*["'][^>]*>/i);
    const seen = new Set<string>();
    const out: CourseRef[] = [];

    for (const block of blocks.length > 0 ? blocks : [html]) {
      const links = matchAll(
        block,
        /<a[^>]+href=["']([^"']*(?:studentstudy|stucoursemiddle|visit\/interaction)[^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi,
      );
      for (const m of links) {
        const href = m[1] ?? '';
        const courseId = queryParam(href, 'courseId');
        const classId = queryParam(href, 'clazzid') ?? queryParam(href, 'classId');
        if (!courseId || seen.has(courseId)) continue;

        // 课程名优先取卡片里的标题元素，取不到再用链接文本
        const name =
          firstGroup(block, /<span[^>]*class=["'][^"']*(?:course-name|courseName)[^"']*["'][^>]*>([^<]{1,80})</i) ??
          firstGroup(block, /<h3[^>]*>([^<]{1,80})</i) ??
          stripTags(m[2] ?? '') ??
          '';
        if (!name) continue;

        seen.add(courseId);
        out.push({
          platformCourseId: courseId,
          classId: classId ?? '',
          ...(href ? { squareUrl: /^https?:\/\//i.test(href) ? href : new URL(href, 'https://mooc2-ans.chaoxing.com').toString() } : {}),
          name: stripTags(name),
          teacher: firstGroup(block, /(?:教师|老师)[：:]\s*([^<\s]{1,20})/),
        });
      }
    }

    // 课程页结构一旦改版，这里会返回 0 条。上游我们知道「至少有课程」，
    // 所以显示为空是明确的异常信号。
    if (out.length === 0) {
      throw schemaDrift(
        this.id,
        '课程页未解析出任何课程。页面结构可能已改版，请检查 #parseCourseRefs 的正则。',
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- 任务

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    // 先拿课程（含 classId/cpi），再逐课程拉作业与考试。
    // 课程列表通常已由 engine 缓存并传入，避免重复请求。
    const courses =
      req.courses?.map((c) => {
        const raw = (c.raw ?? {}) as { classId?: string; cpi?: string; enc?: string };
        return {
          courseId: c.platformCourseId,
          classId: String(raw.classId ?? ''),
          cpi: raw.cpi !== undefined ? String(raw.cpi) : undefined,
          enc: raw.enc !== undefined ? String(raw.enc) : undefined,
          name: c.name,
        };
      }) ?? [];

    if (courses.length === 0) {
      throw new HubError('UPSTREAM', '缺少课程列表，无法拉取作业（课程缓存可能为空）', {
        platformId: this.id,
      });
    }

    const http = new SessionHttpClient(ctx, session);
    const items: PlatformTask[] = [];
    const errors: string[] = [];
    /** 每门课的抓取结果，全空时用于生成可上报的诊断信息 */
    const diag: string[] = [];
    let workEmptyCourses = 0;
    /** 因静默而跳过考试探测的课程数（写进诊断，方便核对省了多少请求） */
    let skippedExamCourses = 0;
    /** 考试页请求失败 / 请求成功但一条都没解析出来的课程数（都要能被看见） */
    let examFailedCourses = 0;
    let examZeroCourses = 0;
    /** 考试失败的首条原因，写进 notes 供用户/我定位 */
    let examFirstError = '';
    /** 同一任务在页面里出现多次且信息冲突的次数（页面结构问题的信号） */
    let dupConflicts = 0;
    /** 拿不到 examId 的考试条数（定位不到这场考试） */
    let examNoLink = 0;
    /** 哪个 URL 变体才真正返回了列表（plain / stuenc / empty）—— 写进诊断 */
    let examVariant = '';
    /** 本轮一共解析出多少场考试（用于判断"一条都没有"是不是异常） */
    let examTotal = 0;
    /** 为取开考时间翻了多少个详情页 / 其中成功拿到的条数 */
    let examDetailFetches = 0;
    let examStartFilled = 0;
    /** 已结束、却始终没有开考时间的考试数（决定了已完成里显示"开考"还是"截止"） */
    let examStartMissing = 0;
    /** 第一份**解析出了考试**的页面 HTML（诊断用） */
    let firstExamHtml = '';
    /** 第一份**没解析出考试**的页面 HTML（只在全都没结果时才需要） */
    let emptyExamHtml = '';
    /** 只进日志的诊断（抓取路径、多日期、相对推算、考试页骨架…） */
    const adapterDetails: string[] = [];
    /** 作业这一轮走的是哪条路（html / json 回退），以及各走了几门课 */
    let htmlPathCourses = 0;
    let jsonFallbackCourses = 0;
    /** 诊断输出上限：「多日期」只列前几条，避免日志被几百条作业冲垮 */
    let dateDebugCount = 0;
    /** 只有「剩余X小时」、没有绝对日期的作业条数（只计数，见下方的取舍说明） */
    let relativeOnly = 0;
    const now = ctx.clock.now();
    /** 引擎判定为「静默」的课程（全部终态 + 长期无变化）—— 可跳过考试探测 */
    const quietCourseIds = new Set(req.quietCourseIds ?? []);

    // ── 会话失效时的提前中止（fail-fast）────────────────────────────
    // 真机：32 门课程全部返回登录页时，我们仍然打满 97 个请求 / 22.8 秒。
    // 连续 N 门课的作业两路都返回登录页 → 判定为「疑似会话失效」，停止继续请求。
    // 但「省请求」不能以丢诊断为代价：中止时打上 failFast 标记，
    // 引擎会记下游标，用户再点一次同步时带 fullDiagnostics 跑完全部课程。
    const FAIL_FAST_STREAK = 5;
    let loginPageStreak = 0;
    let abortedAt = 0;
    let checkedCourses = 0;

    for (const course of courses) {
      checkedCourses += 1;
      /** 本课程的失败信息（用于判定是否「返回登录页」） */
      const courseErrs: string[] = [];
      // 顺序请求而不是并发：超星风控对并发很敏感，
      // 而且限流器是按平台共享的，并发也快不了多少。

      // 作业：主路径 work/task-list（HTML），失败回退旧版 getAllWork（JSON）
      let workItems: PlatformTask[] = [];
      try {
        const html = await this.#fetchTaskListHtml(http, course);
        // 先留着**去重前**的原始解析结果：诊断要看"页面上一共给了几条、各有几个日期"，
        // 去重之后被合并掉的那条就看不见了。
        const rawParsed = parseTaskListHtml(html, now);
        const parsed = dedupeById(rawParsed);
        dupConflicts += parsed.conflicts;
        htmlPathCourses += 1;

        // ---- 诊断：为什么同一条作业会"反复显示更新" ----
        //
        // 两个原因的可能形态完全相反，必须先分清（2026-11-02 用户要求先定位再修）：
        //   · 行内**有多个日期** → 我们每次取的可能是不同那个（发布/开始 vs 截止）
        //   · 行内**没有日期**、只有"剩余X小时" → 每轮按当前时间推算，值必然不同
        // 前者要改取值规则，后者要改成"锚定首次推算值"。先看日志再动。
        //
        // 2026-11-02 起「相对推算」只计数不逐条列：那几行里唯一会变的就是时间戳本身，
        // 每轮必然不同 —— 它证明不了任何新东西，只是把别的信息挤出屏幕。
        // 「多日期」仍然逐条列（最多 5 条）：它还需要人看具体取的是哪一个。
        for (const w of rawParsed) {
          if (w.debugDates && w.debugDates.length > 1 && dateDebugCount < 5) {
            dateDebugCount += 1;
            adapterDetails.push(
              `多日期：${w.title} → 取 ${w.deadline ?? '无'}（候选 ${w.debugDates.join(' / ')}）`,
            );
          } else if (!w.debugDates || w.debugDates.length === 0) {
            if (w.deadline) relativeOnly += 1;
          }
        }

        workItems = parsed.items.map((w) => ({
          platformTaskId: w.platformTaskId,
          courseId: course.courseId,
          courseName: course.name,
          kind: 'homework' as const,
          title: w.title,
          status: w.status,
          ...(w.statusText ? { statusRaw: w.statusText } : {}),
          deadline: w.deadline,
          // 精确到这份作业。真实形态来自 2026-10-23 抓包：
          // /mooc-ans/mooc2/work/dowork?courseId=&classId=&cpi=&workId=
          // 但那条路径**每次都可能带一个服务端签发的 enc**，自己拼是打不开的。
          //
          // 2026-11-01：我一时想改成"从列表页 href 原样搬"，那是**已经被否掉的方案** ——
          // 更晚的结论写在 chaoxingCourseUrl 上方：href 里的 enc 是短命参数，
          // 同步时抓到、过一会儿再点就回「信息提示 · 无权限」。所以这里不能用 w.sourceUrl。
          //
          // v0.2.46：不再退到 `i.chaoxing.com`（那在手机上会落到账号/门户页，等于没跳）。
          // 改为**这门课的课程页**：比首页近一层，且用的是课程级 enc（任务点抓取一直在用，
          // 不是作业级那种短命 enc）。
          sourceUrl: chaoxingCourseUrl(course),
          raw: { source: 'task-list', title: w.title },
        }));
      } catch (e) {
        const msg = `${course.name}/作业(HTML): ${(e as Error).message}`;
        errors.push(msg);
        diag.push(msg);
        courseErrs.push(msg);
      }
      if (workItems.length === 0) {
        try {
          workItems = await this.#fetchPerCourse(http, this.#ep.workList, course, 'homework');
          jsonFallbackCourses += 1;
        } catch (e) {
          const msg = `${course.name}/作业(JSON): ${(e as Error).message}`;
          errors.push(msg);
          diag.push(msg);
          courseErrs.push(msg);
        }
      }
      items.push(...workItems);
      if (workItems.length === 0) workEmptyCourses += 1;
      else diag.push(`${course.name}/作业: ${workItems.length} 条`);

      // ── fail-fast 判定（放在考试之前：会话失效时考试也必然失败，没有请求的意义）──
      const courseAuthWall =
        workItems.length === 0 &&
        courseErrs.length > 0 &&
        courseErrs.every((m) => /登录页|登录\/验证|会话已失效/.test(m));
      loginPageStreak = courseAuthWall ? loginPageStreak + 1 : 0;
      if (!req.fullDiagnostics && loginPageStreak >= FAIL_FAST_STREAK) {
        abortedAt = checkedCourses;
        diag.push(`已连续 ${FAIL_FAST_STREAK} 门课返回登录页，提前中止以避免继续发送无效请求`);
        break;
      }

      // 考试：维持旧接口。失败记为单课程错误，不影响作业结果。
      //
      // 「静默课程」跳过这一步：这类课程全部任务终态且长期无变化，
      // 考试/测验的时间窗早已关闭，不可能再冒出新的。它是每门课固定一次的请求，
      // 占整轮请求量的约 40%（真机遥测：32 门课 / 80 请求 / 4rps ≈ 20 秒）。
      // 注意：作业请求照常发 —— 静默只影响「为发现新内容而做的探测」。
      if (!quietCourseIds.has(course.courseId)) {
        try {
          // 考试走自己的列表页（`exam-ans/mooc2/exam/exam-list`），
          // 结构与作业**不**同构：标题/状态在 `<p>` 里，**时间在 onclick 的 goTest(...) 参数里**。
          // 所以这里用专用解析器，不再复用作业那个。
          const { html: examHtml, variant } = await this.#fetchExamListHtml(http, course);
          if (variant !== 'plain') examVariant = variant; // 记下"哪个变体才通"，写进诊断
          const deduped = dedupeById(parseExamListHtml(examHtml, now));
          dupConflicts += deduped.conflicts;

          const examItems: PlatformTask[] = [];
          // 库里已经知道的开考时间（engine 传下来）。抓到过的不再抓：
          // 详情页一个考试一个请求，每轮重抓同一场考完的试是纯浪费。
          const knownStarts = req.knownStartsAt ?? {};
          // 先待考/进行中、后已结束：详情页预算用完时，宁可漏掉历史补全，
          // 也不能让"下周就要考"的那场拿不到开考时间。
          const examOrder = [...deduped.items].sort(
            (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'),
          );
          for (const w of examOrder) {
            // 开考时间只在详情页里。
            //  - 待考/进行中：要用来显示「几点开考」和倒计时
            //  - 已结束：要用来让已完成列表显示「10:00 开考」而不是「11:40 截止」
            //    （真机 2026-11-02：期中考试在已完成栏里被显示成"截止 11:40"）
            let startsAt: string | undefined = w.platformTaskId ? knownStarts[w.platformTaskId] : undefined;
            const wantsStart = w.status === 'pending' || w.status === 'expired';
            if (!startsAt && wantsStart && w.platformTaskId && examDetailFetches < EXAM_TIME_LIMIT) {
              examDetailFetches += 1;
              try {
                const times = await this.#examDetailTimes(http, course, w.platformTaskId);
                if (times.start) startsAt = times.start;
                if (times.end && !w.deadline) w.deadline = times.end;
                if (startsAt) examStartFilled += 1;
              } catch {
                // 拿不到就只显示结束时间（退化为改动前的样子），不影响这条考试
              }
            }
            // 已结束却始终拿不到开考时间 → 界面会把结束时间当截止时间显示。
            // 用户看不出这是"我们没取到"还是"平台就这么写的"，所以要能统计出来。
            if (!startsAt && w.status === 'expired') examStartMissing += 1;
            if (!w.platformTaskId) examNoLink += 1; // 没有 examId → 这条考试再也定位不到
            examItems.push({
              platformTaskId: w.platformTaskId,
              courseId: course.courseId,
              courseName: course.name,
              kind: 'exam' as const,
              title: w.title,
              status: w.status,
              ...(w.statusText ? { statusRaw: w.statusText } : {}),
              ...(w.deadline ? { deadline: w.deadline } : {}),
              ...(startsAt ? { startsAt } : {}),
              raw: { source: 'exam-list', title: w.title },
            });
          }
          items.push(...examItems);
          if (examItems.length > 0) {
            diag.push(`${course.name}/考试: ${examItems.length} 条`);
            examTotal += examItems.length;
            // 只记**解析出了考试**的那一份：拿一份"本来就没有考试"的页面去做诊断，
            // 结论必然是 `<li> 0 个`，那是误导（2026-11-01 真机就报了这种假警报）。
            if (!firstExamHtml) firstExamHtml = examHtml;
          } else {
            examZeroCourses += 1;
            if (!emptyExamHtml) emptyExamHtml = examHtml;
          }
        } catch (e) {
          const msg = `${course.name}/考试: ${(e as Error).message}`;
          errors.push(msg);
          // 也要进 diag：这一条以前只进 errors，而 errors 只有在「全部课程都为空」时
          // 才会被报出来 —— 于是真实的接口问题（比如上一次的 404）全程静默。
          diag.push(msg);
          examFailedCourses += 1;
          if (!examFirstError) examFirstError = (e as Error).message ?? String(e);
        }
      } else {
        skippedExamCourses += 1;
      }
    }
    if (skippedExamCourses > 0) {
      diag.push(`跳过 ${skippedExamCourses} 门静默课程的考试探测（这些课程已全部完成且长期无变化）`);
    }

    // ---- 全空的诊断兜底 ----
    // 有 N 门课却解析出 0 条任务，几乎不可能是「真的没有作业」；
    // 静默返回空 = 用户以为作业做完了。所以这里必须响亮地失败，
    // 并带上每门课的抓取结果 —— 用户把这段发回来，我就能离线校准解析器。
    const aborted = abortedAt > 0;
    if (items.length === 0 && (workEmptyCourses === courses.length || aborted)) {
      // 失败语义的关键分叉（真机踩过）：全部课程都返回登录页时，
      // 这不是「解析问题」而是「疑似会话失效」——
      //   报成 UPSTREAM → 用户看到"解析问题"，引擎不触发自动重登，系统永不自愈；
      //   报成 AUTH_REQUIRED → 引擎会用保存的密码自动重登并重试一轮。
      // 同样的现象，分类不同，自愈能力完全不同。
      //
      // 措辞刻意用「疑似」：我们只看到响应特征（连续多门课返回登录页），
      // 并不能排除「个别课程需要单独授权」这类情况 —— 不能把推断说成定论。
      const diagText = diag.concat(errors).join('；');
      const authLike = /登录页|登录\/验证|会话已失效|401|403/.test(diagText);
      const evidence = aborted
        ? `连续 ${FAIL_FAST_STREAK} 门课程都返回登录页，已检查 ${abortedAt}/${courses.length} 门后提前中止` +
          '（避免继续发送无效请求）。再点一次同步会自动跑完整诊断。'
        : `已完整检查全部 ${courses.length} 门课程，全部返回登录页`;
      throw new HubError(
        authLike ? 'AUTH_REQUIRED' : 'UPSTREAM',
        authLike
          ? `疑似学习通会话已失效：${evidence}` +
            '若该账号是用「账号密码」添加的，会自动重新登录并重试；' +
            '若是「应用内登录」添加的，请到「登录平台」重新登录一次。' +
            '（这是基于响应特征的判断，也可能是部分课程需要单独授权——完整诊断会给出每门课的结果）'
          : `学习通：${courses.length} 门课程全部解析出 0 条作业/考试。` +
            `这不是「没有作业」，更可能是接口参数或解析问题。各课程结果：${diag.concat(errors).slice(0, 4).join('；')}`,
        {
          platformId: this.id,
          requiresUserAction: authLike,
          // 打上标记 → 引擎记游标 → 下次同步自动跑完整诊断
          details: aborted ? { failFast: true, checked: abortedAt, total: courses.length } : undefined,
        },
      );
    }

    if (items.length === 0 && errors.length > 0 && errors.length >= courses.length) {
      // 全部课程都失败，说明是账号级问题（会话/风控），而不是数据为空
      const authLike = errors.some((e) => /登录|会话|验证|401|403/.test(e));
      throw new HubError(authLike ? 'AUTH_REQUIRED' : 'UPSTREAM', `超星全部课程拉取失败：${errors.slice(0, 3).join('；')}`, {
        platformId: this.id,
        requiresUserAction: authLike,
      });
    }

    // ---- 把「少采了一类数据」说出来 ----
    //
    // 这是本文件最容易出问题的地方：作业采到了，items 就非空，于是考试整类失败
    // 可以一路静默到用户面前（表现为「同步成功、考试永远没有」）。
    // 上一次 getAllExam 404 就是这样藏了不知多久。
    const notes: string[] = [];
    // 页面里同一任务出现多次且信息冲突 —— 这是"截止时间/状态来回跳"的根源。
    // 必须说出来：用户看到的是"我没动过它，它自己一直在变"。
    if (dupConflicts > 0) {
      notes.push(
        `页面上有 ${dupConflicts} 处同一个任务重复出现且信息不一致，已按最保守的一份入库（截止时间取较晚、状态取未完成）`,
      );
    }
    const examProbed = courses.length - skippedExamCourses;
    // 翻了详情页却没拿到时间 —— 说明详情页的结构和我假设的不一样。
    // 这类"看起来做了但没生效"的事必须能看见，否则考试会一直挂在「截止未知」。
    // examId 缺失不弹窗：考试本身仍然显示得出（靠标题指纹兜底），
    // 只是"定位不到"——这属于排查信息，不该占用户的注意力。
    // 作业走的是哪条路：HTML 与 JSON 回退的口径不同（状态词、时间格式都不一样），
    // 如果同一门课在两轮之间换过路，值就会跳 —— 这是"反复更新"的另一个可能来源。
    if (htmlPathCourses > 0 || jsonFallbackCourses > 0) {
      adapterDetails.push(`作业抓取路径：HTML ${htmlPathCourses} 门${jsonFallbackCourses > 0 ? ` / JSON 回退 ${jsonFallbackCourses} 门` : ''}`);
    }
    // 页面只给"剩余X小时"的作业：它们的截止时间是我们按当前时刻推算的。
    // 这说明**那一批**作业的日期本来就不是精确值 —— 判断"这条有没有被平台改期"时要扣掉这一层。
    if (relativeOnly > 0) {
      adapterDetails.push(
        `${relativeOnly} 条作业只给了"剩余X小时"、没有绝对日期（截止时间按当轮时刻推算，变短是时间流逝，不是改期）`,
      );
    }
    if (examNoLink > 0) {
      adapterDetails.push(`有 ${examNoLink} 场考试没有 examId（靠标题指纹入库，可正常显示）`);
    }
    // 翻了详情页却没拿到开考时间 —— 说明详情页结构变了（或需要额外参数）。
    // 退化行为是"只显示结束时间"，用户能看出差别（考试时间没变），所以只进日志。
    if (examDetailFetches > 0 && examStartFilled === 0) {
      adapterDetails.push(`翻了 ${examDetailFetches} 个考试详情页，都没取到开考时间（页面结构可能变了）`);
    }
    // 已结束的考试补不到开考时间 → 界面上会显示「截止 <结束时间>」。
    // 这种"看起来有值、其实是另一个含义"的退化必须留痕（本项目最忌讳的失败形态）。
    if (examStartMissing > 0) {
      adapterDetails.push(
        `${examStartMissing} 场已结束的考试没有开考时间（详情页没返回），已完成里显示的是结束时间`,
      );
    }
    // 拿不到时间时，把考试页的**标签骨架**放进日志（details）：
    // 文字已被替换成 …，能看出 <li> 里有没有 href / examId，又不带出任何内容。
    // 这是"我改了两版都没修对"之后唯一正确的动作 —— 不再猜结构，先要真凭据。
    // 诊断只在**真的没拿到考试**时写，而且要区分两种情形：
    //   · 探测过、但一条都没解析出来 → 可能页面改版，要报（进弹窗，用户能据此找我）
    //   · 有课正常解析出了考试 → 那些空页面只是"这门课没有考试"，不该报
    // 2026-11-01 真机的假警报就是第二种：拿了一门"本来没考试"的课去诊断，
    // 得出 `<li> 0 个`，而同一轮考试其实采到了、时间也对。
    const examProbedCourses = courses.length - skippedExamCourses;
    if (examProbedCourses > 0 && examTotal === 0) {
      notes.push('这个平台的考试一条都没解析出来（可能页面结构变了）');
      const sampleHtml = emptyExamHtml || firstExamHtml;
      if (sampleHtml) adapterDetails.push(`考试页诊断（变体 ${examVariant || 'plain'}）：${examPageDiagnosis(sampleHtml)}`);
    } else if (examVariant && examVariant !== 'plain') {
      // 靠 stuenc 变体才通 —— 只记一句结论。
      // 以前这里会附上整段考试页骨架（`<li> N 个 · 样例：<li>…`），那是排查
      // "考试一条都抓不到"时的取证；变体已经实现且稳定，留着就是每轮刷一遍长文本。
      // 真要再看骨架，删掉 examId 或换账号就能复现「一条都没解析出来」那条分支。
      adapterDetails.push('考试列表走 stuenc 变体才返回数据（不带它时页面是空的）');
    }
    if (examFailedCourses > 0) {
      notes.push(
        `考试信息没取到（${examFailedCourses}/${examProbed} 门课请求失败${examFirstError ? `：${examFirstError.slice(0, 60)}` : ''}）。作业不受影响。`,
      );
    } else if (examProbed > 0 && examZeroCourses === examProbed) {
      // 页面打得开、但一条 `<li>` 都没解析出来 —— 很可能是页面结构变了。
      // 只在**所有**探测过的课程都为空时说：一部分课没考试是正常事。
      notes.push('考试列表页能打开，但一条都没解析出来（可能是页面结构变了）。作业不受影响。');
    }

    return {
      items,
      hasMore: false,
      ...(notes.length > 0 ? { notes } : {}),
      ...(adapterDetails.length > 0 ? { details: adapterDetails } : {}),
      // 不给 declaredTotal：超星不返回总数。
      // 留空则 engine 不会误判 schema drift（我们已经在自己这层校验过了）。
    };
  }

  /**
   * 抓作业列表页（HTML）。
   * 2021 年起社区通用的入口：/work/task-list?courseId=&classId=&cpi=
   * 返回一个 HTML 列表页；没有 enc 参数要求，鉴权全靠 cookie。
   */
  async #fetchTaskListHtml(
    http: SessionHttpClient,
    course: { courseId: string; classId: string; cpi?: string; name: string },
    /** 作业与考试是**同构的两个页面**，只有地址不同 —— 解析器可以共用 */
    kind: 'homework' | 'exam' = 'homework',
  ): Promise<string> {
    const params = new URLSearchParams({
      courseId: course.courseId,
      classId: course.classId,
    });
    if (course.cpi) params.set('cpi', course.cpi);
    const base = kind === 'exam' ? this.#ep.examTaskList : this.#ep.workTaskList;
    const res = await http.request({
      url: `${base}?${params.toString()}`,
      method: 'GET',
      headers: { Referer: kind === 'exam' ? 'https://mooc1-api.chaoxing.com/' : 'https://mooc1-api.chaoxing.com/' },
    });
    const text = await res.text();
    if (looksLikeAuthWall(text)) {
      throw new HubError('AUTH_REQUIRED', `${kind === 'exam' ? '考试' : '作业'}列表返回登录页，会话已失效`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    return text;
  }

  /**
   * 拉考试列表（`exam-ans/mooc2/exam/exam-list`）。
   *
   * 两个变体按顺序试，**取第一个真正返回了 `<li>` 的**：
   *   1. `plain`  —— 不带 stuenc。超星多数页面接口只靠 cookie 鉴权。
   *   2. `stuenc` —— 带课程页的 enc（HAR 实证：课程页 `enc=` 与考试列表 `stuenc=` 同值）。
   *
   * 为什么要有变体：我拿不到登录态去验"stuenc 到底是不是必需"。
   * 与其赌一个，不如两个都试、并**把哪个通了的结论写进诊断** ——
   * 这样一次安装就能定论，不用用户再替我试一版。
   *
   * 判定标准是"出现 `<li>`"，不是 HTTP 200：空壳页面会返回 200，
   * 但里面只有隐藏 input，一个列表项都没有（这正是上一版的失败形态）。
   */
  async #fetchExamListHtml(
    http: SessionHttpClient,
    course: { courseId: string; classId: string; cpi?: string; enc?: string },
  ): Promise<{ html: string; variant: 'plain' | 'stuenc' | 'empty' }> {
    const build = (withEnc: boolean) => {
      const p = new URLSearchParams({
        // 注意：考试接口用全小写 courseid/clazzid，作业接口用的是驼峰
        courseid: course.courseId,
        clazzid: course.classId,
        ut: 's',
        // 防缓存时间戳。页面自己也带，缺了可能拿到过期页面
        t: String(Date.now()),
      });
      if (course.cpi) p.set('cpi', course.cpi);
      if (withEnc && course.enc) p.set('stuenc', course.enc);
      return `${this.#ep.examTaskList}?${p.toString()}`;
    };

    const order: Array<{ name: 'plain' | 'stuenc'; withEnc: boolean }> = [{ name: 'plain', withEnc: false }];
    if (course.enc) order.push({ name: 'stuenc', withEnc: true });

    let last = '';
    for (const v of order) {
      const res = await http.request({
        url: build(v.withEnc),
        method: 'GET',
        headers: { Referer: 'https://mooc1.chaoxing.com/' },
      });
      const text = await res.text();
      if (looksLikeAuthWall(text)) {
        throw new HubError('AUTH_REQUIRED', '考试列表返回登录页，会话已失效', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      last = text;
      if (/<li\b/i.test(text)) return { html: text, variant: v.name };
    }
    return { html: last, variant: 'empty' };
  }

  /**
   * 取一场考试的**开考时间**（详情页才有）。
   *
   * 为什么必须进详情页：考试列表页的 `goTest(...)` 只带结束时间，
   * 页面上也只显示"未开始"，**没有任何地方写着几点开考**。
   * 而用户真正需要的是开考时刻（10:00 到考场），不是结束时刻（11:40）。
   *
   * 详情页（2026-11-01 HAR 实证）：
   *   `<p>开始时间：<span class="din font15">2026-11-02 10:00</span></p>`
   *   `<p>结束时间：<span class="din font15">2026-11-02 11:40</span></p>`
   *
   * 失败一律返回空对象，**绝不抛错**：时间是附加信息，拿不到也不该丢整场考试。
   */
  async #examDetailTimes(
    http: SessionHttpClient,
    course: { courseId: string; classId: string; cpi?: string },
    examId: string,
  ): Promise<{ start?: string; end?: string }> {
    const p = new URLSearchParams({
      courseId: course.courseId,
      classId: course.classId,
      examId,
    });
    if (course.cpi) p.set('cpi', course.cpi);
    const res = await http.request({
      url: `https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examnotes?${p.toString()}`,
      method: 'GET',
      headers: { Referer: 'https://mooc1.chaoxing.com/' },
    });
    const html = await res.text();
    if (looksLikeAuthWall(html)) return {};
    const pick = (label: string) => {
      const m = new RegExp(`${label}[：:]\\s*(?:<[^>]+>\\s*)*(\\d{4}-\\d{1,2}-\\d{1,2}\\s+\\d{1,2}:\\d{2})`).exec(html);
      return m?.[1];
    };
    const start = pick('开始时间');
    const end = pick('结束时间');
    return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  }

  async #fetchPerCourse(
    http: SessionHttpClient,
    url: string,
    course: { courseId: string; classId: string; name: string },
    kind: TaskKind,
  ): Promise<PlatformTask[]> {
    const res = await http.postForm<{
      data?: unknown[];
      list?: unknown[];
      workList?: unknown[];
      examList?: unknown[];
      msg?: string;
    }>(url, {
      classId: course.classId,
      courseId: course.courseId,
      isdisplaytable: kind === 'homework' ? 2 : undefined,
      mooc: 1,
      // 占位符。超星这个参数实际不校验，鉴权全靠 cookie。
      ut: 's',
    });

    const body = res.body ?? {};
    // 平台可能用不同字段名承载列表，逐个尝试而不是死认一个
    const list = body.data ?? body.list ?? body.workList ?? body.examList;
    if (!Array.isArray(list)) {
      const raw = JSON.stringify(body).slice(0, 160);
      // 空对象（{}）通常意味着「这门课没有作业」，属于正常情况；
      // 有字段但结构不对才是改版。
      if (Object.keys(body).length === 0) return [];
      throw schemaDrift(this.id, `${kind} 列表字段不存在（响应：${raw}）`);
    }

    return list
      .map((row) => this.#toPlatformTask(row, course, kind))
      .filter((t): t is PlatformTask => t !== undefined);
  }

  #toPlatformTask(row: unknown, course: { courseId: string; name: string }, kind: TaskKind): PlatformTask | undefined {
    if (typeof row !== 'object' || row === null) return undefined;
    const r = row as Record<string, unknown>;

    const id = r.workId ?? r.examId ?? r.id ?? r.workid;
    const title = r.workName ?? r.examName ?? r.title ?? r.name;
    if (title === undefined || title === null || String(title).trim() === '') return undefined;

    return {
      platformTaskId: id === undefined || id === null ? undefined : String(id),
      courseId: course.courseId,
      courseName: course.name,
      kind,
      title: String(title).trim(),
      status: mapChaoxingStatus(r.status ?? r.workStatus ?? r.examStatus),
      // 截止时间的字段名在不同接口里不一致，全部交给 normalizeDeadline 兜底
      deadline: r.endTime ?? r.deadline ?? r.endDate ?? r.examEndTime ?? r.deadLineTime,
      publishedAt: r.releaseTime ?? r.startTime ?? r.createTime,
      score: numeric(r.score ?? r.getScore),
      totalScore: numeric(r.totalScore ?? r.scoreTotal),
      raw: r,
    } satisfies PlatformTask;
  }

  // ---------------------------------------------------------------- 任务点

  /**
   * 抓「课程级任务点完成度」。
   *
   * ⚠️ 这是**可选能力**（`PlatformAdapter.fetchCourseProgress`），不在 syncAccount 里跑。
   * 一门课一个请求、且任务是慢变量 —— 挂进每轮同步等于给 32 门课 +63% 请求量。
   *
   * 数据来源（2026-11-02 HAR 实证，不是猜的）：
   *   `GET mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=&clazzid=&cpi=&ut=s&t=&stuenc=`
   *   → 200 / text/html / 32KB，课程级统计在页面头部：
   *     `<h2 class="xs_head_name"><i class="catalog_points_yi fl"></i>
   *      已完成任务点: <span style="color:#00B368">0</span>/2`
   *
   * 同一页面里每章还有 `input.knowledgeJobCount`（该章任务点数）与
   * `span.catalog_points_yi`（该章待完成数）—— 以后要做章节级展示不必再发请求。
   *
   * 两条必须记住的边界：
   *   1. **要带 `stuenc`**（= 课程页地址里的 `enc`，已存在 `course.raw.enc`）。
   *      和考试列表同源，2026-11-01 已经踩过「不带就返回空页」。
   *   2. 这个页面**没有截止时间**（`截止` 全文 0 次），所以只能做统计，
   *      做不了「临近截止提醒」—— 那需要另找数据源，别在这里硬凑。
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
    const failures: string[] = [];
    /** 页面正常、但确实没有任务点的课程数 */
    let noTaskPoint = 0;
    /** 连课程目录骨架都没有 —— 拿到的不是这个页面（不回退、记为异常） */
    let noSkeleton = 0;
    let noEnc = 0;
    /** 解析出章节开放窗口的课程数（解释"为什么进度不动") */
    let withWindow = 0;
    /** 第一份解析失败页面的文字摘要，只在真的失败时才输出 */
    let sampleText = '';

    // 并发 2：超星对突发请求敏感，而这是一次 30KB 整页 HTML × 32 门课。
    // 这个能力本来就是低频的（用户打开任务点页才触发），不值得为速度冒风控的险。
    await mapLimit(list, 2, async (c) => {
      const raw = (c.raw ?? {}) as { classId?: string; cpi?: string; enc?: string };
      if (!raw.classId) {
        failures.push(`${c.name}：缺 classId（课程缓存可能过期，重新同步一次）`);
        return;
      }
      const p = new URLSearchParams({
        courseid: c.platformCourseId,
        clazzid: raw.classId,
        ut: 's',
        t: String(ctx.clock.now().getTime()),
      });
      if (raw.cpi) p.set('cpi', raw.cpi);
      if (raw.enc) p.set('stuenc', raw.enc);
      else noEnc += 1;

      try {
        const res = await http.request({
          url: `${this.#ep.courseCatalog}?${p.toString()}`,
          method: 'GET',
          // Referer 照 HAR 抄：浏览器是在课程主页的 iframe 里加载这个页面的。
          // 这类"必须从 A 页跳过来"的校验用 cookie 测不出来，只能照真机拿到的值给。
          headers: {
            Referer: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${c.platformCourseId}&clazzid=${raw.classId}`,
          },
        });
        // 非 2xx 一律算失败：SessionHttpClient 只对 401/403 抛错，其余状态码会原样返回，
        // 而 404/500 的响应体往往是一段空 HTML —— 那会被下面误判成"这门课没有任务点"。
        if (res.status >= 400) {
          failures.push(`${c.name}：HTTP ${res.status}`);
          return;
        }
        const html = await res.text();
        if (looksLikeAuthWall(html)) {
          failures.push(`${c.name}：返回登录页`);
          return;
        }
        const parsed = parseTaskPointProgress(html, ctx.clock.now());
        if (parsed) {
          // 只挑"还没结束、最快关闭"的那个窗口。全部过期就不给 ——
          // 那门课已经没有可做的事，留个日期只会让人以为还要赶。
          const win = nearestUpcomingWindow(parsed.windows, ctx.clock.now());
          // 再记一个"最近关闭"，让界面能说出"还差 N 个，但窗口已经关了"。
          const closed = latestClosedWindow(parsed.windows, ctx.clock.now());
          const nowMs = ctx.clock.now().getTime();
          // 「现在能做」有两条来源：窗口正开着，**或者**有带待完成标记的章节。
          // 只看前者会漏掉那些没设时间限制的章节（真机程设基础就是这么错的）。
          const windowOpen = parsed.windows.some((w) => {
            const o = new Date(w.opensAt).getTime();
            const c2 = new Date(w.closesAt).getTime();
            return Number.isFinite(o) && Number.isFinite(c2) && o <= nowMs && nowMs < c2;
          });
          const hasOpenNow = windowOpen || parsed.hasPendingChapter;
          items.push({
            platformCourseId: c.platformCourseId,
            total: parsed.total,
            done: parsed.done,
            hasOpenNow,
            ...(parsed.availableNow !== undefined ? { availableNow: parsed.availableNow } : {}),
            ...(win ? { nextWindow: win } : {}),
            ...(closed ? { lastClosedAt: closed.closesAt } : {}),
          });
          // 有开放窗口的课单独计数：它是"进度为什么不动"的解释
          if (parsed.windows.length > 0) withWindow += 1;
          return;
        }
        // 没有「已完成任务点」这句：要么这门课真没有任务点，要么页面改版了。
        // 判据是**页面骨架**——有目录骨架说明页面拿对了，那就是"没有任务点"。
        // 这条区分不能省：把解析失败当成 0/0，界面会显示"已全部完成"，
        // 那是在撒谎，而且用户没有任何线索去怀疑。
        if (/fanyaChapterWhite|chapter_head/.test(html)) {
          noTaskPoint += 1;
          items.push({ platformCourseId: c.platformCourseId, total: 0, done: 0 });
        } else {
          noSkeleton += 1;
          if (!sampleText) sampleText = stripTags(html).replace(/\s+/g, ' ').trim().slice(0, 160);
        }
      } catch (e) {
        failures.push(`${c.name}：${(e as Error).message.slice(0, 40)}`);
      }
    });

    const details: string[] = [];
    const withTaskPoint = items.filter((i) => i.total > 0).length;
    if (list.length > 0) {
      details.push(
        `检查了 ${list.length} 门课：${withTaskPoint} 门有任务点 · ${noTaskPoint} 门没有 · ${failures.length} 门抓取失败`,
      );
    }
    if (withWindow > 0) {
      const next = items.find((i) => i.nextWindow)?.nextWindow;
      details.push(
        `${withWindow} 门课设了章节开放时间` +
          (next ? `，最快关闭：${next.chapter || '（无章节名）'} → ${shortLocal(next.closesAt)}` : '，但都已关闭'),
      );
    }
    if (noEnc > 0) {
      details.push(`${noEnc} 门课没有 enc（没带 stuenc，页面可能是空的 —— 多半是课程缓存在旧版本写入的）`);
    }
    if (noSkeleton > 0) {
      details.push(
        `${noSkeleton} 门课拿到的页面里既没有"已完成任务点"也没有目录骨架（可能改版，或需要重新登录）` +
          (sampleText ? `；样例：${sampleText}` : ''),
      );
    }
    if (failures.length > 0) {
      details.push(`失败 ${failures.length} 门：${failures.slice(0, 3).join(' / ')}`);
    }

    return {
      items,
      hasMore: false,
      declaredTotal: items.length,
      ...(details.length > 0 ? { details } : {}),
    };
  }

  /**
   * 作业 / 考试的答题页。
   *
   * ⚠️ 原来 work 用的是 /mooc-ans/work/doWork —— **实测 404，是死路径**
   * （2026-10-23 用未登录请求验证：doWork 返回 404，doHomeWorkNew 返回 302 到登录页，
   *  302 才说明路径真实存在）。参数名也不同：作业是 workId，考试是 examId。
   */
  buildTaskUrl(courseId: string, task: PlatformTask): string | undefined {
    const cid = encodeURIComponent(courseId);
    // workId 是从作业列表的 **HTML** 里正则抓的（workId=xxx / data-id=xxx），
    // 抓不到时宁可不给链接 —— 但更好的做法是退到「该课程的作业列表页」：
    // 用户点进去还能自己找到那条作业，而硬拼一个 404 链接比没有链接更糟。
    if (!task.platformTaskId) {
      return `https://mooc1.chaoxing.com/mooc-ans/work/task-list?courseId=${cid}`;
    }
    const id = encodeURIComponent(task.platformTaskId);
    if (task.kind === 'exam') {
      return `https://mooc1.chaoxing.com/mooc-ans/exam/test/reVersionTestStartNew?courseId=${cid}&examId=${id}&ut=s`;
    }
    return `https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=${cid}&workId=${id}&ut=s`;
  }

  /**
   * 课程页地址：任务点卡片点击、以及作业深链不可用时的兜底都走这里。
   * `raw` 里 classId/cpi/enc 是同步课程时存下来的（任务点抓取用的同一份）。
   */
  /** 最近一次解析的失败定位轨迹（给 /api/task/url 的 debug 字段用）。 */
  resolveDebug(): string[] {
    return this.#resolveTrace.slice(0, 16);
  }

  buildCourseUrl(course: UnifiedCourse): string | undefined {
    const raw = (course.raw ?? {}) as { classId?: string; cpi?: string; enc?: string; squareUrl?: string };
    if (!course.platformCourseId || !raw.classId) return undefined;
    // 有课程级 enc 时**优先自己拼、并把 t 补成当前时刻**：
    // 0.2.47 真机「无效的参数」的关键差异就是少了 t（HAR 里浏览器地址必带 t）。
    if (raw.enc) {
      return chaoxingCourseUrl({
        courseId: course.platformCourseId,
        classId: raw.classId,
        cpi: raw.cpi,
        enc: raw.enc,
        t: Date.now(),
      });
    }
    // 没有 enc 时退回课程卡片的原始链接（可能自带 enc/t）
    const direct = course.sourceUrl ?? raw.squareUrl;
    if (direct && /^https?:\/\//i.test(direct) && /(mycourse\/stu|studentstudy|stucoursemiddle)/i.test(direct)) return direct;
    return chaoxingCourseUrl({
      courseId: course.platformCourseId,
      classId: raw.classId,
      cpi: raw.cpi,
      t: Date.now(),
    });
  }

  /**
   * 点击时解析课程页地址。
   *
   * 按可靠性从高到低尝试 `#locateCoursePage`；都失败才退回「我的课程」页。
   */
  async resolveCourseUrl(
    ctx: AdapterContext,
    session: Session,
    course: UnifiedCourse,
  ): Promise<string | undefined> {
    const http = new SessionHttpClient(ctx, session);
    this.#resolveTrace = ['course:start'];
    const page = await this.#locateCoursePage(http, course);
    if (page) return withPageHeader(page.url, '1'); // 章节 tab：任务点就在章节里
    this.#resolveTrace.push('course:fallback-interaction');
    return 'https://mooc2-ans.chaoxing.com/visit/interaction';
  }

  /**
   * 点击时解析作业的最终地址。
   *
   * 浏览器里的真实链路（2026-11-05 两份 HAR 实证）：
   *   课程页（HTML 隐藏域 enc / workEnc / t）
   *   → 作业列表 `mooc1.chaoxing.com/mooc2/work/list?...&stuenc=<enc>&enc=<workEnc>`
   *   → 每行 `<li data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?...&workId=<id>&answerId=0&enc=<per-work enc>">`
   *   → `work/task` 再 302 到 `work/dowork?...&standardEnc=<新签发>&enc=<同一个 per-work enc>`
   */
  async resolveTaskUrl(
    ctx: AdapterContext,
    session: Session,
    req: { course: UnifiedCourse; platformTaskId: string; kind: PlatformTask['kind'] },
  ): Promise<string | undefined> {
    const http = new SessionHttpClient(ctx, session);
    const interaction = 'https://mooc2-ans.chaoxing.com/visit/interaction';
    this.#resolveTrace = ['task:start'];
    if (req.kind !== 'homework' || !req.platformTaskId) {
      return (await this.resolveCourseUrl(ctx, session, req.course)) ?? interaction;
    }

    const page = await this.#locateCoursePage(http, req.course);
    if (!page) {
      this.#resolveTrace.push('task:no-course-page');
      return interaction;
    }
    const courseUrl = withPageHeader(page.url, '8'); // 作业 tab
    try {
      const courseHtml = page.html;
      // 课程页把作业列表需要的两个 enc 和 t 都放在隐藏域里
      const workEnc =
        firstGroup(courseHtml, /id=["']workEnc["'][^>]*value=["']([^"']+)["']/i) ??
        firstGroup(courseHtml, /name=["']workEnc["'][^>]*value=["']([^"']+)["']/i);
      const enc = firstGroup(courseHtml, /id=["']enc["'][^>]*value=["']([^"']+)["']/i);
      const t =
        firstGroup(courseHtml, /id=["']t["'][^>]*value=["']([^"']+)["']/i) ??
        String(ctx.clock.now().getTime());
      const raw = (req.course.raw ?? {}) as { classId?: string; cpi?: string };
      if (!workEnc || !enc || !raw.classId) {
        this.#resolveTrace.push(
          `task:course-page-missing workEnc=${Boolean(workEnc)} enc=${Boolean(enc)} classId=${Boolean(raw.classId)}`,
        );
        return courseUrl;
      }
      this.#resolveTrace.push('task:course-page-ok');

      const params = new URLSearchParams({
        courseId: req.course.platformCourseId,
        classId: raw.classId,
        ut: 's',
        t,
        stuenc: enc,
        enc: workEnc,
      });
      if (raw.cpi) params.set('cpi', raw.cpi);
      const listUrl = `https://mooc1.chaoxing.com/mooc2/work/list?${params.toString()}`;
      const lRes = await http.request({ url: listUrl, method: 'GET', headers: { Referer: courseUrl } });
      this.#resolveTrace.push(`task:list-status=${lRes.status}`);
      if (lRes.status >= 400) return courseUrl;
      const listHtml = await lRes.text();
      const hit = new RegExp(
        `data=["']([^"']*[?&]workId=${req.platformTaskId}(?:[&"'])[^"']*)["']`,
        'i',
      ).exec(listHtml) ?? new RegExp(`data=["']([^"']*workId=${req.platformTaskId}[^"']*)["']`, 'i').exec(listHtml);
      this.#resolveTrace.push(hit ? 'task:list-hit' : 'task:list-no-workid');
      if (!hit) return courseUrl;
      return hit[1]!.replace(/&amp;/g, '&');
    } catch (e) {
      this.#resolveTrace.push(`task:error ${(e as Error).message.slice(0, 40)}`);
      return courseUrl;
    }
  }

  /**
   * 找到课程页，按可靠性从高到低尝试：
   *   ① `studentcourse`（任务点用的那个页）里的**隐藏 enc** → 拼课程页 → 验证
   *   ② 同步时存下的 raw.enc → 拼课程页（补当前 t）→ 验证
   *   ③ 课程卡片原始链接
   *   ④ 「我的课程」页里现找
   * 每一步都验证「workEnc/enc 隐藏域存在」—— 200 + 「无效的参数」不算成功。
   */
  async #locateCoursePage(
    http: SessionHttpClient,
    course: UnifiedCourse,
  ): Promise<{ url: string; html: string } | undefined> {
    const raw = (course.raw ?? {}) as { classId?: string; cpi?: string; enc?: string; squareUrl?: string };
    const seeds: Array<{ tag: string; url: string }> = [];
    // ① studentcourse 里的隐藏 enc
    const scEnc = await this.#studentCourseEnc(http, course);
    if (scEnc && raw.classId) {
      seeds.push({
        tag: 'student-enc',
        url: chaoxingCourseUrl({
          courseId: course.platformCourseId,
          classId: raw.classId,
          cpi: raw.cpi,
          enc: scEnc,
          t: Date.now(),
        }),
      });
    }
    // ② 课程卡片原始链接（有些学校里它才是带正确 enc/t 的那一份）
    const square = course.sourceUrl ?? raw.squareUrl;
    if (square && /^https?:\/\//i.test(square) && /(mycourse\/stu|studentstudy|stucoursemiddle)/i.test(square)) {
      seeds.push({ tag: 'square', url: square });
    }
    // ②.2 现打「课程列表」接口：HAR 实证它返回每门课的 `stucoursemiddle?courseid=&clazzid=&cpi=` 链接，
    //     这个链接重定向后就是带新鲜 enc/t 的课程页 —— 这是浏览器真正点课程用的入口。
    const listLink = await this.#courseListLinkFromApi(http, course.platformCourseId);
    if (listLink) seeds.push({ tag: 'courselist-api', url: listLink });
    this.#resolveTrace.push(`course:apiSquare=${Boolean(listLink)}`);
    // ③ raw.enc 现拼
    if (raw.classId) {
      seeds.push({
        tag: 'raw-enc',
        url: chaoxingCourseUrl({
          courseId: course.platformCourseId,
          classId: raw.classId,
          cpi: raw.cpi,
          enc: raw.enc,
          t: Date.now(),
        }),
      });
    }
    // ④ 完全不带 enc 现拼
    if (raw.classId) {
      seeds.push({
        tag: 'no-enc',
        url: chaoxingCourseUrl({
          courseId: course.platformCourseId,
          classId: raw.classId,
          cpi: raw.cpi,
          t: Date.now(),
        }),
      });
    }
    this.#resolveTrace.push(
      `course:seeds=${seeds.map((s) => s.tag).join(',') || 'none'} square=${Boolean(square)} rawEnc=${Boolean(raw.enc)}`,
    );
    for (const seed of seeds) {
      const page = await this.#fetchCoursePage(http, seed.url);
      if (page) {
        this.#resolveTrace.push(`course:ok-${seed.tag}`);
        return page;
      }
    }
    // ⑤ 我的课程页里现找
    const fresh = await this.#freshCoursePageUrl(http, course.platformCourseId);
    if (fresh) {
      const page = await this.#fetchCoursePage(http, fresh);
      if (page) {
        this.#resolveTrace.push('course:ok-interaction');
        return page;
      }
    }
    return undefined;
  }

  /**
   * 打「课程列表」接口（HAR 实证）：POST `mooc2-ans/visit/courselistdata`
   * → 返回课程卡片 HTML，卡片链接是 `mooc1.chaoxing.com/visit/stucoursemiddle?courseid=&clazzid=&cpi=`
   *   → 这个链接重定向后才是带新鲜 `enc/t` 的课程页。
   */
  async #courseListLinkFromApi(http: SessionHttpClient, courseId: string): Promise<string | undefined> {
    try {
      const res = await http.request({
        url: 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata',
        method: 'POST',
        form: {
          courseType: '1',
          courseFolderId: '0',
          query: '',
          pageHeader: '-1',
          single: '0',
          superstarClass: '0',
          isFirefly: '0',
          courseLevelLabelId: '0',
          fid: '',
          from: '',
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://mooc2-ans.chaoxing.com/visit/interaction',
        },
      });
      this.#resolveTrace.push(`list:status=${res.status}`);
      if (res.status >= 400) return undefined;
      const html = await res.text();
      if (looksLikeAuthWall(html)) {
        this.#resolveTrace.push('list:authwall');
        return undefined;
      }
      const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
      const idRe = new RegExp(`[?&](?:courseId|courseid)=${courseId}(?:[&]|$)`, 'i');
      const hit =
        links.find((h) => idRe.test(h) && /stucoursemiddle|mycourse\/stu/i.test(h)) ?? links.find((h) => idRe.test(h));
      this.#resolveTrace.push(`list:len=${html.length} links=${links.length} hit=${Boolean(hit)}`);
      return hit;
    } catch (e) {
      this.#resolveTrace.push(`list:error ${(e as Error).message.slice(0, 30)}`);
      return undefined;
    }
  }

  /** 现抓课程列表 JSON，取这门课的 courseSquareUrl（有的学校这里带正确 enc/t）。 */
  async #freshSquareUrl(http: SessionHttpClient, courseId: string): Promise<string | undefined> {
    try {
      const res = await http.request({ url: this.#ep.courseData, method: 'GET' });
      if (res.status >= 400) return undefined;
      const text = await res.text();
      if (looksLikeAuthWall(text)) return undefined;
      const refs = parseBackclazzData(text);
      return refs.find((r) => r.platformCourseId === courseId)?.squareUrl;
    } catch (e) {
      this.#resolveTrace.push(`apiSquare:error ${(e as Error).message.slice(0, 30)}`);
      return undefined;
    }
  }

  /** 抓 studentcourse，取页面里隐藏的课程级 `enc`（不是 URL 上的 stuenc）。 */
  async #studentCourseEnc(http: SessionHttpClient, course: UnifiedCourse): Promise<string | undefined> {
    const raw = (course.raw ?? {}) as { classId?: string; cpi?: string; enc?: string };
    if (!raw.classId) return undefined;
    const p = new URLSearchParams({
      courseid: course.platformCourseId,
      clazzid: raw.classId,
      ut: 's',
      t: String(Date.now()),
    });
    if (raw.cpi) p.set('cpi', raw.cpi);
    if (raw.enc) p.set('stuenc', raw.enc);
    try {
      const res = await http.request({
        url: `${this.#ep.courseCatalog}?${p.toString()}`,
        method: 'GET',
        headers: {
          Referer: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${course.platformCourseId}&clazzid=${raw.classId}`,
        },
      });
      this.#resolveTrace.push(`student:status=${res.status}`);
      if (res.status >= 400) return undefined;
      const html = await res.text();
      if (looksLikeAuthWall(html)) {
        this.#resolveTrace.push('student:authwall');
        return undefined;
      }
      const enc = firstGroup(html, /id=["']enc["'][^>]*value=["']([^"']+)["']/i);
      const isTaskPage = /已完成任务点|fanyaChapterWhite|chapter_head/.test(html);
      this.#resolveTrace.push(`student:enc=${Boolean(enc)} taskPage=${isTaskPage} len=${html.length}`);
      // 登录/错误页里也可能有 id="enc"（验证码等），不能只凭 enc 就信
      if (!isTaskPage) return undefined;
      return enc;
    } catch (e) {
      this.#resolveTrace.push(`student:error ${(e as Error).message.slice(0, 30)}`);
      return undefined;
    }
  }

  /**
   * 拉一个候选课程页，并**验证它真的是课程页**（含 workEnc/enc 隐藏域）。
   * 验证这一步不能省：拿着过期 enc 拼的地址常常返回 200 + 一句「无效的参数」，
   * 不验证就会把错误页当成课程页交给用户。
   */
  async #fetchCoursePage(
    http: SessionHttpClient,
    url: string | undefined,
  ): Promise<{ url: string; html: string } | undefined> {
    if (!url) return undefined;
    try {
      const res = await http.request({
        url,
        method: 'GET',
        headers: { Referer: 'https://mooc2-ans.chaoxing.com/visit/interaction' },
      });
      if (res.status >= 400) {
        this.#resolveTrace.push(`page:status=${res.status}`);
        return undefined;
      }
      const html = await res.text();
      if (looksLikeAuthWall(html)) {
        this.#resolveTrace.push('page:authwall');
        return undefined;
      }
      const hasEnc = /id=["']workEnc["']|name=["']workEnc["']|id=["']enc["']/.test(html);
      const finalUrl = res.url && /^https?:\/\//i.test(res.url) ? res.url : url;
      let finalPath = '';
      try {
        finalPath = new URL(finalUrl).pathname;
      } catch {
        finalPath = '?';
      }
      this.#resolveTrace.push(`page:len=${html.length} hasEnc=${hasEnc} final=${finalPath}`);
      if (!hasEnc) return undefined;
      // 跟随重定向后的最终地址更准确（stucoursemiddle → mycourse/stu?...enc=…&t=…）
      return { url: finalUrl, html };
    } catch (e) {
      this.#resolveTrace.push(`page:error ${(e as Error).message.slice(0, 30)}`);
      return undefined;
    }
  }

  /** 从「我的课程」页里取出这门课当前可用的课程页 href（带新鲜 enc/t）。 */
  async #freshCoursePageUrl(http: SessionHttpClient, courseId: string): Promise<string | undefined> {
    const candidates = [
      'https://i.chaoxing.com',
      'https://mooc2-ans.chaoxing.com/visit/interaction',
      'https://mooc1-2.chaoxing.com/visit/interaction',
    ];
    for (const url of candidates) {
      try {
        const res = await http.request({ url, method: 'GET' });
        if (res.status >= 400) {
          this.#resolveTrace.push(`fresh:${new URL(url).host}=${res.status}`);
          continue;
        }
        const html = await res.text();
        if (looksLikeAuthWall(html)) {
          this.#resolveTrace.push(`fresh:${new URL(url).host}=authwall`);
          continue;
        }
        const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
        const idRe = new RegExp(`[?&](?:courseId|courseid)=${courseId}(?:[&]|$)`, 'i');
        const hit =
          links.find((h) => idRe.test(h) && /(mycourse\/stu|stucoursemiddle)/i.test(h)) ?? links.find((h) => idRe.test(h));
        this.#resolveTrace.push(`fresh:${new URL(url).host}=len ${html.length} links=${links.length} hit=${Boolean(hit)}`);
        if (!hit) continue;
        if (/^https?:\/\//i.test(hit)) return hit;
        return new URL(hit, 'https://mooc2-ans.chaoxing.com').toString();
      } catch {
        // 试下一个候选
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- 纯解析（可单测）

/**
 * 解析 backclazzdata 课程 JSON。
 *
 * 结构（社区多方验证）：
 *   { channelList: [ { cpi?, content: { course: { data: [ { name, courseSquareUrl, ... } ] } } } ] }
 * courseId / classId 在 courseSquareUrl 的 query 里；cpi 只在部分频道上
 * （无 cpi 的频道是往期学期，但为了不漏课，我们照收，只是作业接口会少带这个参数）。
 */
export function parseBackclazzData(text: string): CourseRef[] {
  let body: { channelList?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw schemaDrift('chaoxing', `课程接口返回非 JSON：${text.slice(0, 160)}`);
  }
  if (!Array.isArray(body.channelList)) {
    throw schemaDrift('chaoxing', `课程接口缺少 channelList 字段：${text.slice(0, 160)}`);
  }

  const seen = new Set<string>();
  const out: CourseRef[] = [];
  for (const channel of body.channelList) {
    if (typeof channel !== 'object' || channel === null) continue;
    const ch = channel as Record<string, any>;
    const data = ch.content?.course?.data;
    if (!Array.isArray(data) || data.length === 0) continue;
    const info = data[0] as Record<string, unknown>;
    const name = typeof info.name === 'string' ? info.name.trim() : '';
    const squareUrl = typeof info.courseSquareUrl === 'string' ? info.courseSquareUrl : '';
    const courseId = firstGroup(squareUrl, /courseId=(\d+)/i);
    const classId = firstGroup(squareUrl, /classId=(\d+)/i) ?? firstGroup(squareUrl, /clazzid=(\d+)/i);
    if (!name || !courseId) continue;
    const key = `${courseId}/${classId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      platformCourseId: courseId,
      classId: classId ?? '',
      cpi: typeof ch.cpi === 'string' || typeof ch.cpi === 'number' ? String(ch.cpi) : undefined,
      // 课程卡片链接里带 enc 时顺走 —— 考试列表要它（stuenc）
      ...(firstGroup(squareUrl, /[?&]enc=([0-9a-zA-Z]+)/i)
        ? { enc: firstGroup(squareUrl, /[?&]enc=([0-9a-zA-Z]+)/i)! }
        : {}),
      // 整条链接也留着：点击跳转时它可能比"用存下的 enc 重新拼"更完整（含 t）
      ...(squareUrl ? { squareUrl: squareUrl.replace(/&amp;/g, '&') } : {}),
      name,
      teacher: typeof info.teacherName === 'string' ? info.teacherName : undefined,
    });
  }
  return out;
}

/** 从作业列表 HTML 里解析出的一条作业（平台侧字段尚未映射成 UnifiedTask）。 */
export interface ParsedWorkItem {
  platformTaskId?: string;
  title: string;
  status: TaskStatus;
  /** 平台原话（命中的状态词），只用于展示 */
  statusText?: string;
  /** 诊断用：这一行里出现的所有绝对日期（不含则视为"没有日期"） */
  debugDates?: string[];
  /** ISO 时间或原始字符串，交给 deadline 归一化处理 */
  deadline?: string;
  /**
   * 直达这份作业的地址。
   *
   * 必须从列表页的 **href 原样搬过来**，不能自己拼 ——
   * 真实入口是 /mooc2/work/task?...&workId=&answerId=&enc=，
   * 其中 enc 是**每份作业一个的加密串**（服务端签发），拿不到就 404。
   * 之前只抓了 workId 自己拼 URL，所以每条链接都打不开。
   */
  sourceUrl?: string;
}

/**
 * 解析 work/task-list 作业页（HTML）。
 *
 * 页面结构（来自社区抓包）：
 *   <li>
 *     <div><span>未交</span><p>作业标题</p></div>
 *     <span class="fr">剩余24小时30分钟</span>   ← 截止前才显示
 *   </li>
 *
 * 两个坑：
 *   1. 「剩余X小时Y分钟」是相对时间，截止时间只能按同步时刻推算 ——
 *      有 ±1 分钟的误差，但比「没有 deadline」好得多。
 *   2. 已截止的条目给的是绝对时间或什么都不给，两者都要处理。
 */
/**
 * 构造超星作业深链。
 *
 * 三个参数缺一不可（2026-10-23 抓包实证）：
 *   courseId + classId + cpi 定位课程/班级，workId 定位作业。
 * 缺 workId 时退到**作业列表页**（同一路径的 list，HAR 里是真实页面），
 * 而不是拼一个没有 workId 的 dowork —— 那个会打开空白答题页。
 */
/**
 * 超星没有可靠的直达作业链接 —— 只能回我的课程。
 *
 * 为什么放弃直达（2026-10-23 连试四版，逐层排除）：
 *   1. /mooc-ans/work/doWork       → 404（死路径）
 *   2. /mooc-ans/mooc2/work/dowork → 404（缺 enc）
 *   3. 从列表页 href 原样搬参数（含 answerId + enc）→ 真机回「信息提示 · 无权限！」
 *   4. 补 Referer 模拟从列表点进来 → 仍无权限
 *
 * 结论： 是**服务端按会话/时间签发**的短命参数，同步时抓到的那一份，
 * 用户过一会儿再点就已经失效。任何预先拼好再存起来的链接都会过期，
 * 这条路在原理上走不通。
 *
 * 所以退到首页：让平台自己生成 enc，用户多点两下。
 * 这比给一个必然报错的链接好 —— 后者会让人以为应用坏了。
 */
/**
 * 超星「这门课」的页面地址（课程目录 / 作业入口都从这里进）。
 *
 * 为什么不给作业直达：`enc` 是**服务端按会话/时间签发**的短命参数（见下）。
 * 为什么不给 `https://i.chaoxing.com`：那在手机上会落到账号/门户页，用户点完
 * 还得自己找课，等于没跳（真机 2026-11-05 反馈「只能跳转至账号页」）。
 *
 * 这里用课程级参数（courseid/clazzid/cpi/enc）。其中 `enc` 就是课程页地址里的
 * 那个，任务点抓取（studentcourse）一直复用它且长期有效 —— 和作业级 enc 不是一回事。
 */
function chaoxingCourseUrl(course: {
  courseId: string;
  classId: string;
  cpi?: string;
  enc?: string;
  t?: string | number;
}): string {
  const p = new URLSearchParams({
    courseid: course.courseId,
    clazzid: course.classId,
    ut: 's',
    pageHeader: '8',
    v: '2',
    hideHead: '0',
  });
  if (course.cpi) p.set('cpi', course.cpi);
  if (course.enc) p.set('enc', course.enc);
  if (course.t !== undefined) p.set('t', String(course.t));
  return `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?${p.toString()}`;
}

/**
 * 把课程页 URL 的 `pageHeader` 换成指定标签页。
 *
 * 浏览器里的课程页用 `pageHeader` 选默认标签（2026-11-05 课程页 HTML 实证）：
 *   0=任务、1=章节、2=讨论、8=作业、9=考试、…
 * 同步来的课程页默认是 0（任务），点作业/任务点都落到"任务"就是没改这个参数。
 */
function withPageHeader(url: string, header: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('pageHeader', header);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 状态词的判定优先级。
 *
 * **不按文本出现顺序取第一个**（2026-11-01 真机）：同一行里可能同时出现
 * 「已交」「未交」（例如「已交 1 份，未交 2 份」），或者「已参加」「未参加」，
 * 取"文本中最先出现的那个"会随页面渲染顺序抖动 —— 表现就是变更历史里
 * 「已提交 ↔ 待完成」来回跳，而用户什么都没做。
 *
 * 顺序也不能反：**先判「还没交」再判「交了」**。「未参加」「未完成」都含有
 * 完成类词根，先判已交会让没考的试标成考完、直接从待办里消失。
 */
const STATUS_WORDS: Array<[TaskStatus, string[]]> = [
  // 「未开放作答」是超星的说法：作业已布置但还没到能交的时间。
  // 语义上仍是 pending（将来要做，不能从待办里消失），但界面要显示原话，
  // 否则用户以为"现在就该做"（2026-11-01 真机反馈）。
  ['pending', ['未开放', '未开始', '未参加', '未交', '进行中', '待考试', '未完成', '待做']],
  ['submitted', ['已参加', '已交卷', '已交', '已提交', '待批阅', '待批改']],
  ['graded', ['已批阅', '已完成']],
  ['expired', ['已过期', '已结束']],
];

/**
 * 从一行 HTML 里判状态：按上面的优先级表，与词的出现位置无关。
 *
 * 同时把**命中的那个词**返回去 —— 它是平台的原话，界面要用它
 * （「未开放」不能显示成「待完成」）。
 */
function statusOfBlock(block: string): { status: TaskStatus; text?: string } {
  for (const [status, words] of STATUS_WORDS) {
    for (const w of words) if (block.includes(w)) return { status, text: w };
  }
  return { status: 'unknown' };
}

/**
 * 行内所有绝对日期，取**最晚**的一个。
 *
 * 为什么不是第一个（2026-11-01 真机）：一行里常有多个日期 —— 发布时间、开始时间、
 * 截止时间、补交截止。取第一个会拿到"发布/开始"，于是：
 *   · 截止时间落到过去 → 任务被判逾期（藏在折叠组里）；
 *   · 或者页面条件渲染时有时有、有时没有 → 截止时间在两次同步间来回跳，
 *     变更历史被刷成「10/22 → 11/5 → 10/22」。
 * 截止/结束语义在行内一定是最晚的那个，所以取最晚既稳定又正确。
 *
 * 格式要放宽：超星的考试页用 `2026.11.08`、`2026年11月8日` 都很常见，
 * 只认 `-` 和 `/` 会让考试全部落进「截止未知」。
 */
/**
 * 行内**所有**绝对日期（按出现顺序，去重）。
 *
 * 只用于诊断：`latestDateIn` 只能告诉我们"取了哪个"，看不到"还有哪些"。
 * 而"上机实验反复显示更新"的关键问题正是——**这一行里到底有几个日期**。
 * 如果每轮解析出的候选集合不同，说明页面渲染不稳定；如果候选相同而结果不同，
 * 才是我们自己的取值逻辑有问题。两者的修法完全相反，所以必须先分清。
 */
function allDatesIn(block: string): string[] {
  const re = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]*(\d{1,2}):(\d{2}))?/g;
  const out: string[] = [];
  for (const m of block.matchAll(re)) {
    const [, y, mo, d, hh, mm] = m;
    const date = `${y}-${(mo ?? '1').padStart(2, '0')}-${(d ?? '1').padStart(2, '0')}`;
    const text = hh ? `${date} ${hh.padStart(2, '0')}:${mm ?? '00'}` : date;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function latestDateIn(block: string): string | undefined {
  const re = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T]*(\d{1,2}):(\d{2}))?/g;
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const m of block.matchAll(re)) {
    const [, y, mo, d, hh, mm] = m;
    const date = `${y}-${(mo ?? '1').padStart(2, '0')}-${(d ?? '1').padStart(2, '0')}`;
    const time = hh ? `${hh.padStart(2, '0')}:${mm ?? '00'}` : '';
    const ms = new Date(`${date}T${time || '00:00'}:00`).getTime();
    if (Number.isFinite(ms) && ms >= bestMs) {
      bestMs = ms;
      best = time ? `${date} ${time}` : date;
    }
  }
  return best;
}

/**
 * 把一段 HTML 压成「只有标签、没有文字」的骨架。
 *
 * 用途只有一个：当解析拿不到东西时，让用户能把**结构**带给我看，
 * 而不用教他抓包或导源码。文字全部换成 `…`，所以不会带出姓名、标题、学号。
 *
 * 为什么需要（2026-11-01）：考试时间连改两版都没拿到，我手上没有任何真实结构，
 * 只能继续猜 `<li>` 长什么样。有了骨架，"有没有 href / 有没有 examId" 一眼就能看出来。
 */
export function tagSkeleton(html: string, max = 600): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script/>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style/>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>[^<]{1,80}</g, '>…<')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 考试页诊断：一行说清「结构长什么样」，而不是倒一段 HTML 出来。
 *
 * 为什么不能直接丢 tagSkeleton（2026-11-01 真机两次才改对）：
 * 第一次直接把整页骨架塞进日志，600 字全被 `<head>` 里的 meta/link 占满 ——
 * 用户截图给我，我只看到一堆 `<meta name="viewport">`，对排查毫无帮助。
 *
 * 所以这里先**丢掉 head**（它没有列表结构），再只报三个关键事实：
 * 有几个 <li>、其中几个带 href、整页出现过几次 examId。
 * 这三个数就能判断「这条路到底通不通」：
 *   · `<li>` 有、href 有 → 跟进详情页就能拿到时间
 *   · `<li>` 有、href 无、examId 也无 → 列表页压根没有跳转信息，得换数据源
 *   · `<li>` 为 0 → 根本不是列表页（可能是壳页面/登录页）
 */
export function examPageDiagnosis(html: string): string {
  const src = String(html ?? '');
  const body = src.replace(/<head[\s\S]*?<\/head>/i, '');
  const liBlocks = body.match(/<li\b[\s\S]*?<\/li>/gi) ?? [];
  const withHref = liBlocks.filter((b) => /href\s*=/i.test(b)).length;
  const examIdHits = (src.match(/examid/gi) ?? []).length;
  const sample = liBlocks[0] ?? body;
  return [
    `<li> ${liBlocks.length} 个`,
    `其中带 href 的 ${withHref} 个`,
    `整页出现 examId ${examIdHits} 次`,
    `样例：${tagSkeleton(sample, 380)}`,
  ].join(' · ');
}

/** 同一个 id 出现多次时，按「保守」合并两条。 */
function mergePreferred(a: ParsedWorkItem, b: ParsedWorkItem): ParsedWorkItem {
  // 状态：**只要有一条说"还没交"，就按没交算**。
  // 反过来（取"已交"）的代价是作业从待办里消失，而用户看不到它就没机会去交。
  // 多留一条最多是烦人，少留一条是真的会漏。
  const status: TaskStatus =
    a.status === 'pending' || b.status === 'pending'
      ? 'pending'
      : a.status === 'unknown'
        ? b.status
        : b.status === 'unknown'
          ? a.status
          : a.status;

  // 时间：取**较晚**的那个。取早的会把任务判成逾期（藏进折叠组），
  // 而逾期组默认折叠 —— 用户看到的是"这条作业没了"。
  const pickLater = (x?: string, y?: string): string | undefined => {
    if (!x) return y;
    if (!y) return x;
    const tx = new Date(x.replace(' ', 'T')).getTime();
    const ty = new Date(y.replace(' ', 'T')).getTime();
    if (!Number.isFinite(tx)) return y;
    if (!Number.isFinite(ty)) return x;
    return ty > tx ? y : x;
  };

  return {
    platformTaskId: a.platformTaskId ?? b.platformTaskId,
    // 标题取更长的那个：带「（第3次）」这类后缀的往往才是完整标题
    title: a.title.length >= b.title.length ? a.title : b.title,
    status,
    ...(pickLater(a.deadline, b.deadline) ? { deadline: pickLater(a.deadline, b.deadline)! } : {}),
    ...(a.sourceUrl ?? b.sourceUrl ? { sourceUrl: a.sourceUrl ?? b.sourceUrl } : {}),
  };
}

/**
 * 同一条任务在页面上出现多次时合并成一条。
 *
 * 为什么需要（2026-11-01 真机）：用户看到同一份作业的截止时间和状态在两次同步之间
 * 来回跳（`10/22 ↔ 11/5`、`已交 ↔ 待完成`），而他什么都没做。
 * 页面里同一份作业可能被渲染多次（不同分区、异步补渲染的一份），
 * 两次同步时"哪一份排在后面"不同 → 后写覆盖前写 → 值就抖起来了。
 *
 * 合并规则刻意选**保守侧**（见 mergePreferred）：宁可多留一条待办、宁可显示较晚的
 * 截止时间，也不要让用户漏掉一份作业。`conflicts` 会被上报到同步消息里 ——
 * 页面结构问题不该只有我猜得到。
 */
export function dedupeById(items: ParsedWorkItem[]): { items: ParsedWorkItem[]; conflicts: number } {
  const byKey = new Map<string, ParsedWorkItem>();
  let conflicts = 0;
  for (const it of items) {
    // **没有 id 的条目也必须合并**（2026-11-01 真机）。
    //
    // 引擎对无 id 的任务用 `fp_<指纹>` 兜底，而指纹只含「平台+课程+类型+标题」——
    // 于是同一份作业在页面上出现两次（没有 id）时，两条会落到**同一个 id**，
    // 在同一轮里互相覆盖：谁在后面取决于渲染顺序，所以每次同步"更新"的那一条
    // 都不一样（用户连同步三次，三次分别是不同的实验）。
    //
    // 键用归一化标题：同一次调用必然是同一门课，标题足以定位。
    const key = it.platformTaskId
      ? `id:${it.platformTaskId}`
      : `title:${normalizeTitle(it.title)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, it);
      continue;
    }
    conflicts += 1;
    byKey.set(key, mergePreferred(prev, it));
  }
  return { items: [...byKey.values()], conflicts };
}

export function parseTaskListHtml(html: string, now: Date, kind: 'homework' | 'exam' = 'homework'): ParsedWorkItem[] {
  const out: ParsedWorkItem[] = [];
  for (const m of matchAll(html, /<li\b[\s\S]*?<\/li>/gi)) {
    const block = m[0];

    const title =
      firstGroup(block, /<p[^>]*>([^<]{1,150})</) ??
      firstGroup(block, /class=["'][^"']*overHidden2[^"']*["'][^>]*>([^<]{1,150})</i) ??
      firstGroup(block, /title=["']([^"']{1,150})["']/);
    if (!title) continue;
    const cleanTitle = stripTags(title).trim();
    if (!cleanTitle) continue;

    const { status, text: statusText } = statusOfBlock(block);

    // 绝对时间优先（已布置截止时间的条目），否则用相对倒计时推算
    const dates = allDatesIn(block);
    let deadline: string | undefined = latestDateIn(block);
    if (!deadline) {
      const rest = /剩余\s*(?:(\d+)\s*天)?\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟)?/.exec(block);
      if (rest && (rest[1] || rest[2] || rest[3])) {
        const ms =
          Number(rest[1] ?? 0) * 86_400_000 + Number(rest[2] ?? 0) * 3_600_000 + Number(rest[3] ?? 0) * 60_000;
        deadline = new Date(now.getTime() + ms).toISOString();
      }
    }

    // 考试用 examId，作业用 workId；两者也都可能藏在 data-id 里。
    //
    // **不跨类型兜底**（作业不认 examId、考试不认 workId）：两类 id 混用会让
    // 作业和考试在同一个 id 空间里撞车 —— 一旦数值相同就被合并成一条，
    // 而那种错误在界面上看不出来。id 缺失的代价只是退回 fingerprint（仍然稳定）。
    //
    // 写法要放宽（2026-11-01）：同一个 id 可能出现在
    //   `?examId=123` / `data-examid="123"` / `{"examId":123}` 三种形态里，
    // 只认第一种会让「拿考试时间」这一步在真机上静默不做任何事。
    const idPattern =
      kind === 'exam'
        ? /(?:examid|exam_id)["']?\s*[:=]\s*["']?(\d{3,})/i
        : /(?:(?:workid|jobid|work_id))["']?\s*[:=]\s*["']?(\d{3,})/i;
    const id = firstGroup(block, idPattern) ?? firstGroup(block, /data-id=["'](\d{3,})["']/);

    // 直达链接：**只接受绝对地址**，原样搬过来。
    // 相对路径不猜 host —— 猜错会得到一个打不开的页面，比退回首页更糟。
    const hrefRaw = firstGroup(block, /href=["']([^"']+)["']/i);
    const sourceUrl =
      hrefRaw && /^https?:\/\//i.test(hrefRaw) ? hrefRaw.replace(/&amp;/g, '&') : undefined;

    out.push({
      platformTaskId: id ?? undefined,
      title: cleanTitle,
      status,
      ...(statusText ? { statusText } : {}),
      ...(dates.length > 0 ? { debugDates: dates } : {}),
      deadline,
      ...(sourceUrl ? { sourceUrl } : {}),
    });
  }
  return out;
}

/**
 * 解析考试列表页（`exam-ans/mooc2/exam/exam-list`）。
 *
 * 真实结构（2026-11-01 用户 HAR 实证，不是猜的）：
 * ```html
 * <li>
 *   <div onclick="goTest('204587864',11006129,0,'2026-11-02 11:40:00.0',196703545,false,'8cb49e73…','0');">
 *     <div class="tag icon-exam icon-exam"></div>
 *     <div class="right-content">
 *       <p class="overHidden2 fl">期中考试</p>
 *       <p class="status fl">未开始</p>
 *     </div>
 *   </div>
 * </li>
 * ```
 *
 * 三个关键点，少一个就会退化成"有标题没时间"：
 *   1. **时间在 `goTest(...)` 的第四个参数里**（`'2026-11-02 11:40:00.0'`）。
 *      页面上不显示这个时间（只显示"未开始"），所以按文本找日期永远是空的 ——
 *      这就是之前一直落在「截止未知」的原因。
 *   2. examId 在第二个参数。没有它就没有身份，只能靠标题指纹。
 *   3. 状态要取 `<p class="status">` 那一段，不能用整块扫：
 *      `icon-exam` 之类的类名里也含有 exam 字样，扫整块容易被它带偏。
 */
export function parseExamListHtml(html: string, now: Date): ParsedWorkItem[] {
  const out: ParsedWorkItem[] = [];
  for (const m of matchAll(html, /<li\b[\s\S]*?<\/li>/gi)) {
    const block = m[0];

    const title =
      firstGroup(block, /<p[^>]*class=["'][^"']*overHidden2[^"']*["'][^>]*>([^<]{1,150})</i) ??
      firstGroup(block, /<p[^>]*class=["'][^"']*[^"']*["'][^>]*>([^<]{1,150})</i);
    if (!title) continue;
    const cleanTitle = stripTags(title).trim();
    if (!cleanTitle) continue;

    const statusWord = firstGroup(block, /<p[^>]*class=["'][^"']*\bstatus\b[^"']*["'][^>]*>([^<]{1,40})</i);
    const { status, text: statusText } = statusOfBlock(statusWord ?? block);

    // onclick="goTest('courseId',examId,?, '截止时间', ...)"
    let examId: string | undefined;
    let deadline: string | undefined;
    const call = firstGroup(block, /goTest\(([^)]*)\)/i);
    if (call) {
      const args = call.split(',').map((a) => a.trim().replace(/^['"]/, '').replace(/['"]$/, ''));
      if (/^\d{3,}$/.test(args[1] ?? '')) examId = args[1];
      if (args[3]) deadline = latestDateIn(args[3]) ?? undefined;
    }

    out.push({
      platformTaskId: examId,
      title: cleanTitle,
      status,
      ...(statusText ? { statusText } : {}),
      ...(deadline ? { deadline } : {}),
    });
  }
  return out;
}

/**
 * 从课程目录页里取「已完成任务点: X/Y」+ 章节开放窗口。
 *
 * 真实 HTML（2026-11-02 HAR，`mooc2-ans/mycourse/studentcourse`）：
 *   `<h2 class="xs_head_name fl" tabindex="0"><i class="catalog_points_yi fl"></i>
 *    已完成任务点: <span style="color:#00B368">0</span>/2`
 *
 * 数字两侧的标签形态不固定（也可能没有 span），所以两处都用 `(?:<[^>]*>\s*)*`
 * 兼容 —— 这个正则不是照着"好看的样例"写的，是按真机字节写的。
 *
 * 返回 null 表示**页面上没有这句话**（不是"0/0"）。这两件事必须分开：
 * 前者可能是改版，后者是真的没有任务点；混成一样会让界面显示"已全部完成"。
 */
export function parseTaskPointProgress(
  html: string,
  now: Date = new Date(),
): {
  total: number;
  done: number;
  windows: TaskPointWindow[];
  hasPendingChapter: boolean;
  /**
   * 此刻还能做的任务点条数（只算已开放、且还有未完成点的章节）。
   * 无法把「N个待完成任务点」可靠归属到章节时**不返回**这个键 ——
   * 那时界面退回"还有可做的"，好过显示一个把未开放章节也算进去的错数字。
   */
  availableNow?: number;
} | null {
  const m = /已完成任务点\s*[:：]\s*(?:<[^>]*>\s*)*(\d+)\s*(?:<[^>]*>\s*)*\/\s*(\d+)/.exec(html);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total < 0 || done < 0) return null;

  // 章节名与开放窗口在页面里是**两段并列的兄弟节点**，不是父子关系，
  // 所以按"往前找最近的序号"配对，而不是按 DOM 嵌套切块 ——
  // 真机页面上 chapter_item 有 19 个而章节只有 15 个（空节点 + 嵌套），
  // 切块必然错位，而错误配对会安静地把时间挂到别的章节上。
  const names = [...html.matchAll(CATALOG_NAME_RE)].map((x) => ({
    at: x.index ?? 0,
    label: `${x[1] ?? ''} ${x[2] ?? ''}`.replace(/\s+/g, ' ').trim(),
  }));

  /** 位置 at 之前最近的章节序号；没有则 -1。数组按出现顺序排列，遇到更晚的就停。 */
  const indexBefore = (at: number): number => {
    let idx = -1;
    for (let i = 0; i < names.length; i++) {
      if ((names[i]!.at ?? 0) < at) idx = i;
      else break;
    }
    return idx;
  };

  const windows: TaskPointWindow[] = [];
  /** 章节序号 → 该章的窗口。用来判断"这一章现在能不能做"。 */
  const windowOfChapter = new Map<number, TaskPointWindow>();
  const collect = (at: number, opensAt: string, closesAt: string) => {
    const idx = indexBefore(at);
    const win: TaskPointWindow = { chapter: idx >= 0 ? (names[idx]!.label ?? '') : '', opensAt, closesAt };
    windows.push(win);
    if (idx >= 0) {
      // 同一章偶尔会同时出现多种窗口写法；保留"最晚关闭"的那条，
      // 它才是这一章最后还能做的时间。
      const prev = windowOfChapter.get(idx);
      if (!prev || new Date(win.closesAt).getTime() > new Date(prev.closesAt).getTime()) {
        windowOfChapter.set(idx, win);
      }
    }
  };

  // 形态 ①：`开放时间：2026-11-08 23:00 至 ...`（年份齐全）
  for (const w of html.matchAll(OPEN_WINDOW_RE)) {
    const opens = normalizeDeadline(w[1], now);
    const closes = normalizeDeadline(w[2], now);
    // 两个时间都必须是绝对时刻；解析不出来就丢掉这一条，
    // 绝不用"当前时间 + 猜测"顶上去（那会造出一个假截止）。
    if (opens.kind !== 'absolute' || closes.kind !== 'absolute') continue;
    collect(w.index ?? 0, opens.at, closes.at);
  }

  // 形态 ②：`定时开放：09-14 00:00 至 12-12 23:30`（**只有月日**）
  // 按当前年份补；"结束早于开始"说明跨年，把结束推到下一年。
  const year = now.getFullYear();
  for (const w of html.matchAll(TIMED_WINDOW_RE)) {
    const opens = normalizeDeadline(`${year}-${w[1]}`, now);
    if (opens.kind !== 'absolute') continue;
    let closes = normalizeDeadline(`${year}-${w[2]}`, now);
    if (closes.kind !== 'absolute') continue;
    if (new Date(closes.at).getTime() < new Date(opens.at).getTime()) {
      const next = normalizeDeadline(`${year + 1}-${w[2]}`, now);
      if (next.kind !== 'absolute') continue;
      closes = next;
    }
    collect(w.index ?? 0, opens.at, closes.at);
  }

  // 「有未完成任务点的章节」—— 判断"现在能不能做"的关键补充。
  //
  // 真机 2026-11-03：程设基础 24/50，9 个章节测验**已经开放**却没出现在
  // 开放窗口列表里（老师没给它们设时间限制）。只看窗口就会判成"一章都没开"，
  // 界面于是写着"剩下的等 11/23 开放"，而用户点进去明明能做。
  //
  // 判定依据是超星自己给的「N个待完成任务点」标记：它只出现在还有任务点没完成的
  // 章节上，且不会给已关闭的章节挂这个标记（关闭的章节显示的是「已关闭」）。
  const pendingMarks = [...html.matchAll(PENDING_RE)]
    .map((x) => ({ at: x.index ?? 0, count: Number(x[1]) }))
    .filter((x) => Number.isFinite(x.count) && x.count > 0);
  const pending = pendingMarks.length > 0;

  // ---- 「现在可做 n 个」----
  // 把每个「N个待完成任务点」归属到它前面最近的章节，再按该章此刻是否开放
  // 决定算不算。要点是**不能直接把 done/total 相减**：那个差里含着还没开放的
  // 章节（分阶段开放），把它当成"可做"会让用户白跑。
  let availableNow: number | undefined;
  if (pendingMarks.length > 0) {
    const pendingOfChapter = new Map<number, number>();
    let unattributed = 0;
    for (const pm of pendingMarks) {
      const idx = indexBefore(pm.at);
      if (idx < 0) {
        // 出现在第一个章节名之前：可能是一条汇总/别的布局，归属不了 →
        // 宁可整门课不给数字，也不猜（错数字比没有数字更糟）。
        unattributed += 1;
        continue;
      }
      pendingOfChapter.set(idx, (pendingOfChapter.get(idx) ?? 0) + pm.count);
    }
    if (unattributed === 0 && pendingOfChapter.size > 0) {
      const nowMs = now.getTime();
      let sum = 0;
      for (const [idx, count] of pendingOfChapter) {
        const win = windowOfChapter.get(idx);
        let openNow = true; // 没设窗口的章节 = 不限时，随时可做
        if (win) {
          const o = new Date(win.opensAt).getTime();
          const cl = new Date(win.closesAt).getTime();
          openNow = Number.isFinite(o) && Number.isFinite(cl) && o <= nowMs && nowMs < cl;
        }
        if (openNow) sum += count;
      }
      availableNow = sum;
    }
  }

  // 完成数大于总数只可能是页面把两个数搞反了（或我们取错位）。
  // 宁可按"全做完"截断，也不要显示 110% —— 那会让整个数字失去可信度。
  return {
    total,
    done: Math.min(done, total),
    windows,
    hasPendingChapter: pending,
    ...(availableNow !== undefined ? { availableNow } : {}),
  };
}

/** 章节序号 + 名称：`<span class="catalog_sbar">2.1</span> 什么是真理？` */
const CATALOG_NAME_RE = /<span class="catalog_sbar">\s*([^<]*?)\s*<\/span>\s*([^<]*)/g;

/**
 * 开放窗口：`本章节暂未开放，不能查看。开放时间： 2026-11-08 23:00 至 2026-11-29 23:00`
 *
 * 两个时间都是**本地墙上时间**（不带时区），交给 normalizeDeadline 按本地时区解析。
 * 不要自己 `new Date(str)` —— WebView 对 "YYYY-MM-DD HH:mm" 的解析行为不一致。
 */
/** 「1个待完成任务点」/「3个待完成任务点」——有它说明这一章现在还能做 */
const PENDING_RE = /(\d+)\s*个待完成任务点/g;

const OPEN_WINDOW_RE =
  /开放时间\s*[：:]\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*至\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/g;

/**
 * 形态 ②：`定时开放：09-14 00:00 至 12-12 23:30` —— 已开放但限时的章节用这种写法。
 *
 * 2026-11-03 真机：程设基础的章节**全是**这种，而上面的正则只认"开放时间"，
 * 于是整门课的窗口一个都没抓到，页面把它判成"一章都没开"，
 * 写着"剩下的等 11/23 开放"，而用户点进去明明有 9 个测验能做。
 *
 * 注意这里**没有年份**，要按当前年份补（见 parseTaskPointProgress）。
 */
const TIMED_WINDOW_RE =
  /定时开放\s*[：:]\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*至\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/g;

/**
 * 在所有开放窗口里挑「还没结束、且最快关闭」的那个。
 *
 * 全过期 → 返回 undefined。这不是"没数据"，而是**这门课已经没有可做的事**：
 * 留着日期只会让人以为还有截止要赶。
 */
export function nearestUpcomingWindow(windows: TaskPointWindow[], now: Date): TaskPointWindow | undefined {
  const t = now.getTime();
  let best: TaskPointWindow | undefined;
  let bestClose = Number.POSITIVE_INFINITY;
  for (const w of windows) {
    const close = new Date(w.closesAt).getTime();
    if (!Number.isFinite(close) || close <= t) continue;
    if (close < bestClose) {
      best = w;
      bestClose = close;
    }
  }
  return best;
}

/** ISO → 「11/29 23:00」。日志是给人读的，ISO 串在这句话里只是噪音。 */
function shortLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 最近一个**已经关闭**的窗口。
 *
 * 它存在的唯一理由：让界面区分「还差 2 个，还能补」和「还差 2 个，窗口已经关了」。
 * 没有它，这两种完全相反的情况长得一模一样 —— 真机上「形势与政策」就是这种：
 * 4/6 未完成，两个章节的窗口 10/18 就关了，而界面上什么提示都没有。
 */
export function latestClosedWindow(windows: TaskPointWindow[], now: Date): TaskPointWindow | undefined {
  const t = now.getTime();
  let best: TaskPointWindow | undefined;
  let bestClose = Number.NEGATIVE_INFINITY;
  for (const w of windows) {
    const close = new Date(w.closesAt).getTime();
    if (!Number.isFinite(close) || close > t) continue;
    if (close > bestClose) {
      best = w;
      bestClose = close;
    }
  }
  return best;
}

function numeric(v: unknown): number | undefined {  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 超星的状态字段在不同接口里是数字或字符串，这里做兼容映射。
 *
 * 考试的状态词和作业**不是一套**：作业说「未交/已交」，考试说「未开始/进行中/已参加」。
 * 只认作业那套时，考试条目一律落到 unknown —— 不是终态，所以仍会显示，
 * 但「已参加」的考试会一直挂在待办里提醒你去考。这是 2026-11-01 补的。
 */
function mapChaoxingStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? '').trim();
  const lower = s.toLowerCase();

  // 纯数字走精确匹配：用 includes 的话 "2024" 会命中 '0'
  if (/^\d+$/.test(s)) {
    if (s === '0') return 'pending';
    if (s === '1') return 'submitted';
    if (s === '2') return 'graded';
    if (s === '3') return 'expired';
    return 'unknown';
  }

  // **先判「还没交」再判「交了」**，顺序不能反：「未参加」「未开始」含有完成类词根，
  // 先判已交会把没考的试标成考完，直接从待办里消失。
  if (/(未交|未开始|未参加|进行中|待考试|待做|todo|pending)/i.test(lower) || s === '未交') {
    return 'pending';
  }
  if (/(已交卷|已参加|已交|待批阅|待批改|submitted)/i.test(lower)) return 'submitted';
  if (/(已批阅|已完成|graded)/i.test(lower)) return 'graded';
  if (/(已过期|已结束|expired)/i.test(lower)) return 'expired';
  return 'unknown';
}

/** 解析 `a=1; b=2` 形式的 cookie 字符串。 */
export function parseCookieHeader(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
