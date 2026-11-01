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
  FetchCoursesRequest,
  FetchTasksRequest,
  Page,
  PlatformAdapter,
} from '#core/ports/adapter.ts';
import type { PlatformCourse } from '#core/domain/course.ts';
import type { PlatformTask, TaskKind, TaskStatus } from '#core/domain/task.ts';
import type { Credentials, Session } from '#core/ports/vault.ts';
import type { ReadOnlyPolicy } from '#core/ports/read-only.ts';
import { HubError, schemaDrift } from '#core/domain/errors.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';
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
   * 课程列表（JSON）。社区多方验证的主路径：
   * 返回 channelList[]，每个课程频道的 content.course.data[0] 带
   * name 与 courseSquareUrl（内含 courseId/classId），频道上有 cpi。
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
   * 考试列表：和作业**同构的 HTML 页面**（不是 JSON 接口）。
   *
   * 原来是 `mooc1.chaoxing.com/mooc-ans/exam/test/getAllExam`，注释挂着 TODO(verify)，
   * 结果 2026-11-01 实测是 **404 死路径** —— 考试从来没被采到过，而且失败被当成
   * 「单课程错误」吞掉了（见 fetchTasks 里的考试分支）。
   *
   * 现在这个地址与 `work/task-list` 完全对称（同一个 host、同样的查询参数、同样返回
   * `<li>` 列表页），所以可以用**同一个解析器**。实测未登录返回 302 到登录页
   * （= 路径真实存在），死路径会是 404。
   */
  examTaskList: string;
  /** 会话探测：读取当前登录用户信息，最轻量的接口。 */
  userInfo: string;
}

/**
 * 每轮最多为多少场考试去翻详情页拿时间。
 *
 * 为什么要有上限：考试列表页不给时间，只能逐场翻详情页。正常情况下一个学期的
 * 待考考试不超过个位数；一旦某人的课程里堆了几十场历史考试，不设限就会把
 * 一轮同步变成几十个额外请求（超星风控对请求量敏感）。
 */
const EXAM_DETAIL_LIMIT = 8;

export const ChaoxingEndpoints: ChaoxingEndpointMap = {
  login: 'https://passport2.chaoxing.com/fanyalogin',
  courseData: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
  courseList: 'https://mooc1-2.chaoxing.com/visit/interaction',
  workTaskList: 'https://mooc1-api.chaoxing.com/work/task-list',
  workList: 'https://mooc1.chaoxing.com/mooc-ans/work/getAllWork',
  examTaskList: 'https://mooc1-api.chaoxing.com/mooc-ans/exam/phone/task-list',
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
  name: string;
  teacher?: string;
}

export class ChaoxingAdapter implements PlatformAdapter {
  readonly id = 'chaoxing';
  readonly displayName = '超星学习通';
  readonly homepage = 'https://i.chaoxing.com';
  readonly #ep: typeof ChaoxingEndpoints;

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
        raw: { classId: r.classId, cpi: r.cpi },
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
        /<a[^>]+href=["']([^"']*(?:studentstudy|visit\/interaction)[^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi,
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
        const raw = (c.raw ?? {}) as { classId?: string; cpi?: string };
        return {
          courseId: c.platformCourseId,
          classId: String(raw.classId ?? ''),
          cpi: raw.cpi !== undefined ? String(raw.cpi) : undefined,
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
    /** 为了拿考试时间而跟进的详情页请求数 / 其中成功拿到时间的条数 */
    let examDetailFetches = 0;
    let examDetailFilled = 0;
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
        const parsed = dedupeById(parseTaskListHtml(html, now));
        dupConflicts += parsed.conflicts;
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
          // 更晚的结论写在 chaoxingWorkUrl 上方：href 里的 enc 是短命参数，
          // 同步时抓到、过一会儿再点就回「信息提示 · 无权限」。所以这里不能用 w.sourceUrl。
          sourceUrl: chaoxingWorkUrl(course, w.platformTaskId),
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
          // 考试走**和作业同构的 HTML 列表页**（不是 JSON 接口）。
          //
          // 原来这里打的是 mooc1/exam/test/getAllExam —— 2026-11-01 实测 404，
          // 也就是说考试从来没被采到过一条。而失败只 push 进 errors、items 又不为空，
          // 于是既不报错也不提示：用户看到「同步成功」，考试却永远不出现。
          const examHtml = await this.#fetchTaskListHtml(http, course, 'exam');
          const deduped = dedupeById(parseTaskListHtml(examHtml, now, 'exam'));
          dupConflicts += deduped.conflicts;

          // 考试列表页**只有「未开始」这样的状态，没有任何时间**（2026-11-01 真机截图）。
          // 开始/截止时间在详情页里。不跟这一步，考试就永远落在「截止未知」——
          // 而「截止未知」对考试几乎等于没用：不知道什么时候考，提醒也不会响。
          //
          // 请求节制：只跟「还没开始/进行中」且列表里确实没有时间的，
          // 每轮上限 EXAM_DETAIL_LIMIT 次。已结束的考试不跟（时间窗早已关闭）。
          const examItems: PlatformTask[] = [];
          for (const w of deduped.items) {
            let deadline = w.deadline;
            if (!deadline && w.status === 'pending' && w.detailUrl && examDetailFetches < EXAM_DETAIL_LIMIT) {
              examDetailFetches += 1;
              try {
                const led = await this.#examDetailDeadline(http, w.detailUrl);
                if (led) {
                  deadline = led;
                  examDetailFilled += 1;
                }
              } catch {
                // 详情页失败**不能**影响这条考试本身：宁可没有时间，
                // 也不要因为一个附加信息丢掉整场考试。
              }
            }
            examItems.push({
              platformTaskId: w.platformTaskId,
              courseId: course.courseId,
              courseName: course.name,
              kind: 'exam' as const,
              title: w.title,
              status: w.status,
              ...(w.statusText ? { statusRaw: w.statusText } : {}),
              ...(deadline ? { deadline } : {}),
              raw: { source: 'exam-task-list', title: w.title },
            });
          }
          items.push(...examItems);
          if (examItems.length > 0) diag.push(`${course.name}/考试: ${examItems.length} 条`);
          else examZeroCourses += 1;
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
    if (examDetailFetches > 0 && examDetailFilled === 0) {
      notes.push(`有 ${examDetailFetches} 场考试翻进了详情页，但没能读出时间（页面结构可能变了）`);
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
   * 打开一场考试的详情页，取它的截止时间。
   *
   * 为什么必须走这一步：考试列表页只给「未开始」这类状态，**一个时间都没有**
   * （2026-11-01 真机截图）。而详情页里写着「开始时间 / 截止时间」。
   * 不跟进去，考试就只能挂在「截止未知」——那对考试几乎等于没用。
   *
   * 页面里同时有开始和截止两个时间，取**最晚**的那个就是截止（和作业页同一条规则）。
   *
   * 失败一律返回 undefined，**绝不抛错**：时间是附加信息，不该因为拿不到它
   * 就让整场考试消失（那比没有时间糟得多）。
   */
  async #examDetailDeadline(http: SessionHttpClient, detailUrl: string): Promise<string | undefined> {
    const res = await http.request({
      url: detailUrl,
      method: 'GET',
      headers: { Referer: 'https://mooc1-api.chaoxing.com/' },
    });
    const html = await res.text();
    if (looksLikeAuthWall(html)) return undefined;
    // 详情页可能很长，但 latestDateIn 只认「完整年月日」，页脚版权年份之类的不会误命中
    return latestDateIn(html);
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
  /**
   * 列表页里那一条的 href，**只在同步这一轮立即跟随时使用**。
   *
   * 为什么不能存下来给用户点：里面的 `enc` 是短命参数（见 chaoxingWorkUrl 上方的结论）。
   * 但**同步时立即请求**是另一回事 —— 那时 enc 还是新鲜的，所以可以用它去拿详情页里的时间。
   *
   * 具体用途：超星的考试列表只显示「未开始」，**没有任何时间**（2026-11-01 真机），
   * 开始/截止时间只在详情页里。不跟这一步，考试就永远落在「截止未知」。
   */
  detailUrl?: string;
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
 * 超星没有可靠的「直达作业」链接 —— 只能回我的课程。
 *
 * 为什么放弃直达（2026-10-23 连试四版，逐层排除）：
 *   1. `/mooc-ans/work/doWork`        → 404（死路径）
 *   2. `/mooc-ans/mooc2/work/dowork`  → 404（缺 enc）
 *   3. 从列表页 href 原样搬参数（含 answerId + enc）→ 真机回「信息提示 · 无权限！」
 *   4. 再补 Referer 模拟"从列表点进来" → 仍无权限
 *
 * 结论：`enc` 是**服务端按会话/时间签发**的短命参数。同步时抓到的那一份，
 * 用户过一会儿再点就已经失效 —— 任何"提前拼好、存进库里"的链接都会过期，
 * 这条路在原理上走不通（不是参数没找对）。
 *
 * 所以退到首页：让平台自己生成 enc，用户多点两下。
 * 这比给一个必然报错的链接好 —— 后者会让人以为应用坏了。
 */
function chaoxingWorkUrl(
  _course: { courseId: string; classId: string; cpi?: string },
  _workId: string | undefined,
): string {
  return 'https://i.chaoxing.com';
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
  const byId = new Map<string, ParsedWorkItem>();
  const noId: ParsedWorkItem[] = [];
  let conflicts = 0;
  for (const it of items) {
    if (!it.platformTaskId) {
      noId.push(it);
      continue;
    }
    const prev = byId.get(it.platformTaskId);
    if (!prev) {
      byId.set(it.platformTaskId, it);
      continue;
    }
    conflicts += 1;
    byId.set(it.platformTaskId, mergePreferred(prev, it));
  }
  return { items: [...byId.values(), ...noId], conflicts };
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
    const id =
      firstGroup(block, kind === 'exam'
        ? /(?:examId|examid)=(\d{3,})/i
        : /(?:workId|workid|jobid)=(\d{3,})/i) ??
      firstGroup(block, /data-id=["'](\d{3,})["']/);

    // 直达链接：**只接受绝对地址**，原样搬过来。
    // 相对路径不猜 host —— 猜错会得到一个打不开的页面，比退回首页更糟。
    const hrefRaw = firstGroup(block, /href=["']([^"']+)["']/i);
    const sourceUrl =
      hrefRaw && /^https?:\/\//i.test(hrefRaw) ? hrefRaw.replace(/&amp;/g, '&') : undefined;

    // 详情页地址：只用于"同步这一轮立即跟随"，不落库（enc 是短命的）。
    // 相对路径用超星主站补全 —— 考试详情页都在 mooc1.chaoxing.com 下。
    let detailUrl: string | undefined;
    if (hrefRaw && !/^\s*(javascript:|#|mailto:)/i.test(hrefRaw)) {
      try {
        detailUrl = new URL(hrefRaw.replace(/&amp;/g, '&'), 'https://mooc1.chaoxing.com').toString();
      } catch {
        detailUrl = undefined;
      }
    }

    out.push({
      platformTaskId: id ?? undefined,
      title: cleanTitle,
      status,
      ...(statusText ? { statusText } : {}),
      deadline,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(detailUrl ? { detailUrl } : {}),
    });
  }
  return out;
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
