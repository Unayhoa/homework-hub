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
 *   - 「共享课」（如“大学生心理健康”）不在首批：它走
 *     `student/course/share/queryShareCourseInfo`，请求体里的 `secretStr` 由页面
 *     `window.yxyz()` + RSA/AES 动态生成（HAR 实证）；服务端适配器无法安全复现，
 *     需要后续用 WebView 采集页面状态再补。首批只覆盖普通学习课/翻转课。
 *   - `status` 是提交状态：1=未提交、2=被打回、3=待批阅/批阅中、4=已批阅、5=已出分。
 *   - 截止时间用 `endTime`（epoch 毫秒），`homeworkEndDate` 作为兜底。
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
    allowPost: [
      { pattern: /student\/course\/share\/queryShareCourseInfo/, why: '查询共享课列表（只读，POST 只为传加密参数）' },
      {
        pattern: /stuonline\.zhihuishu\.com\/stuonline\/json\//,
        why: '查询共享课学习进度/成绩/教学任务（只读 JSON 接口，POST 只为传 courseId/recruitId）',
      },
    ],
  };

  /**
   * 智慧树的保活探测：用最便宜的「登录用户信息」接口。
   * 它只回答「cookie 还能不能用」，不拉课程/作业；间隔 20 分钟，
   * 比 iSmart 的 ticket 换票机制更简单 —— 智慧树是 cookie-only，没有
   * 可自动续期的 ticket，能做的只是尽量在会话闲置过期前轻触一下。
   */
  readonly keepAliveProbe = {
    url: 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo',
    method: 'GET' as const,
    alivePattern: '"uuid"',
    intervalMs: 20 * 60 * 1000,
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
        try {
          items.push(...(await this.#listSharedTasks(http, course)));
        } catch (e) {
          // 共享课作业/考试首批不完整；失败不拖垮整轮同步，但要在日志里留下原因
          sharedErrors.push(`${course.name}/共享课章节测验: ${String((e as Error).message ?? e).slice(0, 300)}`);
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
        const grade = await this.#fetchGrade(http, c);
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

  /** 平时分/总评/学习习惯/互动分：四个免加密接口，一个失败不影响其他。 */
  async #fetchGrade(http: SessionHttpClient, c: UnifiedCourse): Promise<CourseGradeSummary | undefined> {
    const raw = (c.raw ?? {}) as { recruitId?: string | number };
    if (raw.recruitId === undefined || raw.recruitId === null) return undefined;
    const base = { courseId: c.platformCourseId, recruitId: String(raw.recruitId), type: 'l', courseTypeEs: '1' };
    const headers = {
      Origin: 'https://stuonline.zhihuishu.com',
      Referer: `https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index?recruitId=${encodeURIComponent(
        String(raw.recruitId),
      )}&courseId=${encodeURIComponent(c.platformCourseId)}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const safe = async (url: string, form: Record<string, string>) => {
      try {
        const r = await http.postForm<Record<string, unknown>>(url, form, { headers });
        return r.body ?? {};
      } catch {
        return {} as Record<string, unknown>;
      }
    };
    const [report, habit, forum] = await Promise.all([
      safe(this.#ep.stuReport, { courseId: base.courseId, recruitId: base.recruitId, stuRankType: 'classRank' }),
      safe(this.#ep.stuHabit, base),
      safe(this.#ep.stuForum, base),
    ]);
    const ssd = (report.ssd ?? (report.data as { ssd?: unknown } | undefined)?.ssd ?? {}) as Record<string, unknown>;
    const habitBody = (habit.data ?? habit) as Record<string, unknown>;
    const forumBody = (forum.data ?? forum) as Record<string, unknown>;
    const grade: CourseGradeSummary = {
      ...(numeric(ssd.totalScore) !== undefined ? { totalScore: numeric(ssd.totalScore) } : {}),
      ...(numeric(ssd.usualScore) !== undefined ? { usualScore: numeric(ssd.usualScore) } : {}),
      ...(numeric(ssd.finalScore) !== undefined ? { finalScore: numeric(ssd.finalScore) } : {}),
      ...(numeric(ssd.examScore) !== undefined ? { examScore: numeric(ssd.examScore) } : {}),
      ...(numeric(ssd.meetScore) !== undefined ? { meetScore: numeric(ssd.meetScore) } : {}),
      ...(numeric(ssd.courseScore) !== undefined ? { studyScore: numeric(ssd.courseScore) } : {}),
      ...(numeric(habitBody.learnedHabitScore) !== undefined ? { habitScore: numeric(habitBody.learnedHabitScore) } : {}),
      ...(numeric(habitBody.learnedHabitTotalScore) !== undefined
        ? { habitTotal: numeric(habitBody.learnedHabitTotalScore) }
        : {}),
      ...(numeric(forumBody.learnedInteractiveScore) !== undefined
        ? { interactionScore: numeric(forumBody.learnedInteractiveScore) }
        : {}),
      ...(numeric(forumBody.learnedInteractiveTotalScore) !== undefined
        ? { interactionTotal: numeric(forumBody.learnedInteractiveTotalScore) }
        : {}),
    };
    return Object.keys(grade).length > 0 ? grade : undefined;
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
    if (Number(body.code) !== 200 || typeof uuid !== 'string' || !uuid) {
      throw new HubError('AUTH_REQUIRED', '智慧树会话已失效（未拿到登录用户 uuid），请重新登录', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    return uuid;
  }

  /** 共享课的章节测验：从成绩分析页「学习进度/章节测验」接口拿 chapterName + state。 */
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
    if (ids.length === 0) return [];
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
