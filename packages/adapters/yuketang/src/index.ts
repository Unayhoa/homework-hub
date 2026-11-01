/**
 * 雨课堂 / 长江雨课堂适配器（experimental）。
 *
 * ⚠️ 与超星适配器同样的前提：接口路径来自社区公开信息
 * （yuketang-helper-auto、YuKeTang 等项目），我没有真实账号逐条验证。
 * 请按真实返回修正 YuketangEndpoints 与解析逻辑。
 *
 * 雨课堂的鉴权比超星干净一些，但有两个坑：
 *
 *   坑 1｜token 不在 cookie 里，而在响应头。
 *     登录成功后服务端通过 `Set-Authorization` 下发 JWT，
 *     后续所有请求要放在 `Authorization` 头里（注意**没有** Bearer 前缀）。
 *     很多实现把 token 当 cookie 存，于是每次请求都 401。
 *     所以本适配器显式把它放进 Session.headers。
 *
 *   坑 2｜多域名。
 *     「长江雨课堂」是独立部署（changjiang.yuketang.cn），
 *     课程与课次接口路径和主站不同。所以端点表按学校可覆盖。
 *     客户端在登录时会从跳转链路里识别出实际域名。
 *
 * 数据模型差异：雨课堂的核心概念是「课次（lessonId）」而不是「作业」。
 * 每节课下有课件、习题、考试。所以这里做了层映射：
 *   未开始的考试 → kind: exam
 *   课后习题     → kind: homework
 *   课堂限时题   → kind: quiz
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
import { mapLimit } from '#core/engine/http-pipeline.ts';

/** 见 ChaoxingEndpointMap 的说明：显式 interface 而不是 as const，便于覆盖。 */
export interface YuketangEndpointMap {
  /** 主站登录。TODO(verify)：部分学校走 sso，需要先跳转拿 ticket。 */
  login: string;
  /** 长江雨课堂登录。 */
  changjiangLogin: string;
  /** 学生课程列表。 */
  studentCourses: string;
  /** 课次（每次课）列表。 */
  lessonList: string;
  /** 课次下的习题 / 考试。 */
  lessonActivities: string;
  /** 会话探测。 */
  userInfo: string;
}

export const YuketangEndpoints: YuketangEndpointMap = {
  login: 'https://www.yuketang.cn/api/v3/user/login',
  changjiangLogin: 'https://changjiang.yuketang.cn/api/v3/user/login',
  studentCourses: '/api/v3/lesson/student/course-list',
  lessonList: '/api/v3/lesson/student/lesson-list',
  lessonActivities: '/api/v3/lesson/student/lesson-activities',
  userInfo: '/api/v3/user/basic-info',
};

export interface YuketangAdapterOptions {
  /**
   * 适配器 ID。长江雨课堂是独立部署，需要和主站同时存在，
   * 所以允许指定不同的 id（如 'yuketang-changjiang'）。
   */
  id?: string;
  /**
   * 站点根地址。默认主站；长江雨课堂填 https://changjiang.yuketang.cn
   * 这是「长江雨课堂」和主站唯一的差异点，所以做成配置项。
   */
  baseUrl?: string;
  endpoints?: Partial<YuketangEndpointMap>;
}

export class YuketangAdapter implements PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;
  readonly #base: string;
  readonly #isChangjiang: boolean;
  readonly #ep: typeof YuketangEndpoints;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: true,
    incremental: false,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };

  /**
   * 登录方式：只有「应用内登录」。
   *
   * 密码登录不提供 —— 真实登录走 SSO（account.yuketang.cn）+ 密码加密传输，
   * 而且请求体里必须带腾讯 turing 点选验证码的 ticket/randstr
   * （HAR 实证，见 0.1.12 的结论）。这类验证码的设计目标就是拦截自动化，
   * 无法也不应绕过。用 getter 是因为登录页地址随实例（雨课堂 / 长江）而变。
   */

  get authMethods(): AuthMethod[] {
    return [
      {
        id: 'in-app',
        label: '应用内登录',
        kind: 'in-app',
        fields: [],
        loginUrl: this.#base,
        hint:
          '会打开雨课堂官方页面，你正常登录即可。' +
          '雨课堂的 API 凭据不止 cookie（token 存在网页 localStorage 里），' +
          '返回应用时会自动读取并接续 —— 不需要你手动复制任何东西。',
      },
    ];
  }

  /** 见 ChaoxingAdapter.readOnlyPolicy 的说明。雨课堂的查询接口都是 GET，更简单。 */
  readonly readOnlyPolicy: ReadOnlyPolicy = {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [{ pattern: /\/api\/v3\/user\/login$/, why: '账号密码登录' }],
  };

  constructor(opts: YuketangAdapterOptions = {}) {
    this.#base = (opts.baseUrl ?? 'https://www.yuketang.cn').replace(/\/$/, '');
    this.#ep = { ...YuketangEndpoints, ...opts.endpoints };
    const isChangjiang = this.#base.includes('changjiang');
    this.#isChangjiang = isChangjiang;
    this.id = opts.id ?? (isChangjiang ? 'yuketang-changjiang' : 'yuketang');
    this.displayName = isChangjiang ? '长江雨课堂' : '雨课堂';
    this.homepage = this.#base;
  }

  // ---------------------------------------------------------------- 登录

  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const issuedAt = ctx.clock.now().toISOString();
    const session: Session = {
      platformId: this.id,
      accountId: '',
      cookies: {},
      headers: {
        // 雨课堂对缺失这个头的请求会返回 403，即便 token 正确
        'X-Client': 'web',
        Referer: `${this.#base}/`,
        Origin: this.#base,
      },
      issuedAt,
    };
    const http = new SessionHttpClient(ctx, session);

    if (cred.cookie) {
      // 标记为 imported：雨课堂的 token 在每次登录时会轮换，
      // 如果我们擅自用密码重新登录，会把用户手机上正在用的会话顶掉。
      session.origin = 'imported';
      // 用户粘贴的可能是纯 JWT，也可能是 `a=1; b=2` 形式的 cookie 串
      if (cred.cookie.includes('=') && !cred.cookie.startsWith('ey')) {
        for (const part of cred.cookie.split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) session.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        }
      } else {
        session.headers['Authorization'] = cred.cookie.trim();
      }
      return session;
    }

    const url = this.#base.includes('changjiang') ? this.#ep.changjiangLogin : this.#ep.login;
    const res = await http.postForm<{ code?: number; msg?: string; data?: { name?: string; id?: string } }>(url, {
      phone: cred.username ?? '',
      password: cred.password ?? '',
      loginType: 1,
    });

    // 雨课堂把 token 放在响应头而不是 body。
    // 这里同时兼容两种写法，因为不同版本用过不同的头名。
    const token =
      res.raw.headers['set-authorization'] ??
      res.raw.headers['authorization'] ??
      res.raw.headers['x-access-token'];
    if (!token) {
      throw schemaDrift(
        this.id,
        `登录响应未包含 token（响应头：${Object.keys(res.raw.headers).join(',')}）`,
      );
    }

    const code = res.body?.code;
    if (code !== undefined && code !== 0) {
      throw new HubError('AUTH_FAILED', `雨课堂登录失败：${res.body?.msg ?? `code=${code}`}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    session.headers['Authorization'] = token;
    session.origin = 'derived';
    session.userId = res.body?.data?.id;
    session.displayName = res.body?.data?.name ?? cred.username;
    return session;
  }

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const http = new SessionHttpClient(ctx, session);
    try {
      const res = await http.getJson<{ code?: number }>(`${this.#base}${this.#ep.userInfo}`);
      return res.status === 200 && (res.body?.code === 0 || res.body?.code === undefined);
    } catch (e) {
      if (e instanceof HubError && e.code === 'AUTH_REQUIRED') return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- 课程

  async fetchCourses(ctx: AdapterContext, session: Session, _req?: FetchCoursesRequest): Promise<Page<PlatformCourse>> {
    const http = new SessionHttpClient(ctx, session);

    // 长江雨课堂：真实课程列表接口来自 2026-09-29 抓包 ——
    // GET /v2/api/web/courses/list?identity=N（1=我教的课，2=我听的课），
    // 学生用 identity=2；教师视角常为空，所以两个 identity 都拉一遍合并去重。
    if (this.#isChangjiang) {
      const seen = new Set<string>();
      const items: PlatformCourse[] = [];
      let lastErr: unknown;
      for (const identity of [1, 2] as const) {
        try {
          const res = await http.getJson<{ errcode?: number; errmsg?: string; data?: { list?: unknown[] } }>(
            `${this.#base}/v2/api/web/courses/list?identity=${identity}&pageSize=100&page=1`,
          );
          const list = res.body?.data?.list;
          if (!Array.isArray(list)) {
            lastErr = schemaDrift(this.id, `课程列表缺少 data.list（响应键：${Object.keys(res.body ?? {}).join(',')}）`);
            continue;
          }
          for (const item of parseYuketangCourses(list)) {
            if (seen.has(item.platformCourseId)) continue;
            seen.add(item.platformCourseId);
            items.push(item);
          }
        } catch (e) {
          lastErr = e;
        }
      }
      if (items.length === 0 && lastErr) throw lastErr;
      return { items, hasMore: false, declaredTotal: items.length };
    }

    const res = await http.getJson<{
      code?: number;
      data?: { list?: unknown[]; courseList?: unknown[] };
      list?: unknown[];
    }>(`${this.#base}${this.#ep.studentCourses}?page=1&pageSize=200`);

    const list = res.body?.data?.list ?? res.body?.data?.courseList ?? res.body?.list;
    if (!Array.isArray(list)) {
      throw schemaDrift(this.id, `课程列表字段不存在（响应键：${Object.keys(res.body ?? {}).join(',')}）`);
    }

    // 用显式累加而不是 map+filter+类型谓词：
    // 谓词写法要求 PlatformCourse 反向可赋值给推断出的字面量结构，
    // 而 raw 的类型是 unknown，这个方向不成立。
    const items: PlatformCourse[] = [];
    for (const row of list) {
      const r = row as Record<string, unknown>;
      const classroom = (r.classroom ?? r.course ?? {}) as Record<string, unknown>;
      const id = classroom.id ?? r.courseId ?? r.classroomId ?? r.id;
      const name = classroom.name ?? r.name ?? r.title;
      if (id === undefined || !name) continue;
      items.push({
        platformCourseId: String(id),
        name: String(name),
        teacher:
          typeof classroom.teacher === 'object' && classroom.teacher !== null
            ? String((classroom.teacher as Record<string, unknown>).name ?? '')
            : undefined,
        raw: r,
      });
    }

    return { items, hasMore: false, declaredTotal: list.length };
  }

  // ---------------------------------------------------------------- 任务

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    const http = new SessionHttpClient(ctx, session);
    const courses = req.courses ?? [];
    const items: PlatformTask[] = [];
    const failures: string[] = [];
    /** 只进日志的排查结论（例如"这个接口里出现过哪些 type"） */
    const details: string[] = [];

    // 长江雨课堂：作业抓取主通道（2026-09-29 真实抓包校准）——
    //   1) GET /c27/.../get_basic_info/ → course_sign
    //   2) GET /mooc-api/v1/lms/learn/course/chapter?cid=&sign=&term=latest
    //      → 章节树，leaf_type=9 的叶子就是作业/测验（name + score_deadline 毫秒）。
    // 此前用的 on-lesson-upcoming-exam 是时段性接口（有时返回全部、有时返回空），
    // 已弃用。已知边界：chapter 树没有「已提交」状态，雨课堂的已完成栏暂为空。
    if (this.#isChangjiang) {
      const nowMs = ctx.clock.nowMs();
      // 作业的**真实入口**是 /v2/web/studentQuiz/{quizId}/1（2026-10-23 截图实证），
      // 而这个 quizId 与章节树叶子的 id 是**两套 ID**（章节树里根本搜不到它）。
      // 唯一来源是 /api/v3/classroom/on-lesson-upcoming-exam —— 但它只列「即将截止」的几条，
      // 所以：匹配得到的给精确链接，匹配不到的统一给平台首页
      // （用户 2026-10-23 明确：修不好就退首页，不要给一个必然报错的地址）。
      const quizLinks = new Map<string, string>();
      /** 这个接口里真正是「考试」的条目（type === 'exam'）—— 章节树里没有它们 */
      const examFromUpcoming: PlatformTask[] = [];
      /** 见过的 type 取值。写进诊断，用来判断"考试到底叫什么类型" */
      const upstreamTypes = new Set<string>();
      try {
        const up = await http.getJson<{ data?: { upcomingExam?: Array<Record<string, unknown>> } }>(
          `${this.#base}/api/v3/classroom/on-lesson-upcoming-exam`,
        );
        for (const e of up.body?.data?.upcomingExam ?? []) {
          const cid = String(e.classroom_id ?? '');
          const title = String(e.title ?? '');
          const id = e.id;
          if (!cid || !title || id === undefined || id === null) continue;
          quizLinks.set(`${cid}|${title}`, `${this.#base}/v2/web/studentQuiz/${id}/1`);

          // ---- 考试：章节树里没有，只能从这里拿 ----
          //
          // 2026-11-01 核对用户 HAR：这个接口一次返回全部「即将到来」的条目，
          // 每条带 `type`（样本里是 "quiz"）和 `start_time`/`end_time`（epoch **秒**）。
          // 章节树（mooc-api chapter）只有 leaf_type 7/8/9，都是授课/资料/作业，
          // 没有考试 —— 所以考试如果存在，唯一来源就是这里。
          //
          // 之前这段只拿 `id` 拼作业链接，把条目本身丢掉了，于是「考试」这类内容
          // 从来不会进库。现在只补 `type === 'exam'` 的（quiz 章节树已经覆盖，避免重复）。
          const type = String(e.type ?? '');
          if (type) upstreamTypes.add(type);
          if (type === 'exam') {
            const endSec = typeof e.end_time === 'number' ? e.end_time : undefined;
            examFromUpcoming.push({
              platformTaskId: String(id),
              courseId: cid,
              courseName: String(e.classroom_name ?? ''),
              kind: 'exam',
              title,
              status: 'pending',
              ...(endSec !== undefined ? { deadline: new Date(endSec * 1000) } : {}),
              raw: e,
            });
          }
        }
      } catch {
        // 拿不到就全部退首页，不影响作业本身
      }
      // type 分布只进日志（排查用）：如果哪天出现 "exam"，说明有考试可采
      if (upstreamTypes.size > 0) {
        details.push(`雨课堂 upcomingExam 的 type 取值：${[...upstreamTypes].join(' / ')}`);
      }
      items.push(...examFromUpcoming);
      for (const course of courses) {
        try {
          // 浏览器真实请求：?classroom_id=&notSetParamsUvId=true（缺参返回 XTBZ IS REQUIRED）
          const info = await http.getJson<Record<string, unknown>>(
            `${this.#base}/c27/online_courseware/course/classroom/${encodeURIComponent(course.platformCourseId)}/get_basic_info/?classroom_id=${encodeURIComponent(course.platformCourseId)}&notSetParamsUvId=true`,
          );
          const infoData = (info.body?.data ?? {}) as Record<string, unknown>;
          const sign = typeof infoData.course_sign === 'string' ? infoData.course_sign : '';
          if (!sign) {
            // 诊断：签名拿不到时把 basic_info 的真实返回片段带回日志，定位接口差异
            failures.push(
              `${course.name}: get_basic_info 无 course_sign（${JSON.stringify(info.body).slice(0, 200)}）`,
            );
            continue;
          }
          // 浏览器真实请求还带 uv_id（学校ID）与 classroom_id，来自课程列表的 course.university_id
          const rawCourse = (course.raw ?? {}) as Record<string, unknown>;
          const uni = (rawCourse.course ?? {}) as Record<string, unknown>;
          const uvId = typeof uni.university_id === 'string' || typeof uni.university_id === 'number'
            ? String(uni.university_id)
            : '';
          const chUrl =
            `${this.#base}/mooc-api/v1/lms/learn/course/chapter?cid=${encodeURIComponent(course.platformCourseId)}` +
            `&sign=${encodeURIComponent(sign)}&term=latest` +
            // uv_id 拿不到就**整段省略**。取证期间我曾把它写成 `uv_id=(未提供)`，
            // 那是把一句给人看的说明塞进了真实请求参数 —— 服务端会收到一个字面量垃圾值。
            // 取证代码已删，这里恢复成条件省略。
            (uvId ? `&uv_id=${encodeURIComponent(uvId)}` : '') +
            `&classroom_id=${encodeURIComponent(course.platformCourseId)}`;
          const ch = await http.getJson<Record<string, unknown>>(chUrl);
          const chData = (ch.body?.data ?? {}) as Record<string, unknown>;
          const chapters = chData.course_chapter;
          if (!Array.isArray(chapters)) {
            // 诊断：真机上 mooc-api 的返回形态与浏览器抓包不同时，把片段带回日志
            failures.push(
              `${course.name}: chapter 响应无 course_chapter（${JSON.stringify(ch.body).slice(0, 220)}）`,
            );
            continue;
          }
          const before = items.length;
          collectChangjiangLeaves(chapters, items, course.platformCourseId, course.name, nowMs);
          // 教室的学习内容页 —— 2026-10-23 抓包实证的真实形态：
          // /pro/lms/{sign}/{classroomId}/studycontent?university_id=&platform_id=3&classroom_id=
          // 这里只能定位到**这个教室**，定位不到具体某份作业：
          // 章节树叶子里没有可用的作业路由，而 /v2/web/classroom/{id} 用的是班级 ID，
          // 我们手上只有课程 ID（拼出来会报「内容不存在」）。
          for (let i = before; i < items.length; i += 1) {
            const t = items[i]!;
            t.sourceUrl =
              quizLinks.get(`${course.platformCourseId}|${t.title}`) ?? this.#base;
          }
        } catch (e) {
          failures.push(`${course.name}: ${(e as Error).message}`);
        }
      }
      if (items.length === 0 && failures.length >= courses.length && courses.length > 0) {
        throw new HubError('UPSTREAM', `雨课堂全部课程作业拉取失败：${failures.slice(0, 3).join('；')}`, {
          platformId: this.id,
        });
      }
      return {
        items,
        hasMore: false,
        declaredTotal: items.length,
        ...(details.length > 0 ? { details } : {}),
      };
    }

    // 性能关键路径：一学期 = N 门课 × M 个课次，请求数轻松过百。
    // 全串行 + 限流下要好几分钟（真机已验证），所以拆成两阶段：
    //   阶段 1：逐课程拉课次列表（每门课 1 个请求，量小，串行即可）
    //   阶段 2：把所有 (课程, 课次) 对摊平，4 路并行拉活动
    // 平台限流器是共享的，并行只会「填满」限流配额，不会超发请求。
    const pairs: Array<{ course: PlatformCourse; lessonId: string; title: string }> = [];
    for (const course of courses) {
      try {
        const lessons = await this.#fetchLessons(http, course.platformCourseId);
        for (const lesson of lessons) {
          pairs.push({ course, lessonId: lesson.lessonId, title: lesson.title });
        }
      } catch (e) {
        failures.push(`${course.name}: ${(e as Error).message}`);
      }
    }

    const results = await mapLimit(pairs, 6, async (pair) => {
      try {
        return { ok: true as const, tasks: await this.#fetchLessonActivities(http, pair.course, { lessonId: pair.lessonId, title: pair.title }) };
      } catch (e) {
        return { ok: false as const, message: `${pair.course.name}/${pair.lessonId}: ${(e as Error).message}` };
      }
    });
    for (const r of results) {
      if (r.ok) items.push(...r.tasks);
      else failures.push(r.message);
    }

    if (items.length === 0 && failures.length > 0) {
      const authLike = failures.some((f) => /登录|token|401|403|会话/.test(f));
      throw new HubError(
        authLike ? 'AUTH_REQUIRED' : 'UPSTREAM',
        `雨课堂拉取全部失败：${failures.slice(0, 3).join('；')}`,
        { platformId: this.id, requiresUserAction: authLike },
      );
    }

    return { items, hasMore: false };
  }

  async #fetchLessons(http: SessionHttpClient, courseId: string): Promise<Array<{ lessonId: string; title: string; startAt?: unknown; endAt?: unknown }>> {
    const res = await http.getJson<{ code?: number; data?: { activities?: unknown[]; list?: unknown[] }; list?: unknown[] }>(
      `${this.#base}${this.#ep.lessonList}?classroom_id=${encodeURIComponent(courseId)}&page=1&pageSize=200`,
    );
    const list = res.body?.data?.list ?? res.body?.data?.activities ?? res.body?.list;
    if (!Array.isArray(list)) {
      // 课程没有课次时返回空是正常的
      if (res.body && Object.keys(res.body).length <= 2) return [];
      throw schemaDrift(this.id, `课次列表字段不存在（响应键：${Object.keys(res.body ?? {}).join(',')}）`);
    }
    const lessons: Array<{ lessonId: string; title: string; startAt: unknown; endAt: unknown }> = [];
    for (const row of list) {
      const r = row as Record<string, unknown>;
      const id = r.id ?? r.lessonId ?? r.activityId;
      if (id === undefined) continue;
      lessons.push({
        lessonId: String(id),
        title: String(r.title ?? r.name ?? '未命名课次'),
        startAt: r.startTime ?? r.start_at,
        endAt: r.endTime ?? r.end_at,
      });
    }
    return lessons;
  }

  async #fetchLessonActivities(
    http: SessionHttpClient,
    course: PlatformCourse,
    lesson: { lessonId: string; title: string },
  ): Promise<PlatformTask[]> {
    const res = await http.getJson<{ code?: number; data?: unknown[]; list?: unknown[] }>(
      `${this.#base}${this.#ep.lessonActivities}?lesson_id=${encodeURIComponent(lesson.lessonId)}`,
    );
    const list = res.body?.data ?? res.body?.list;
    if (!Array.isArray(list)) return [];

    const tasks: PlatformTask[] = [];
    for (const row of list) {
      const r = row as Record<string, unknown>;
      const id = r.id ?? r.examId ?? r.problemId ?? r.activityId;
      const title = r.title ?? r.name;
      if (title === undefined) continue;

      // 雨课堂的类型字段：0/1=课件 2=习题 3=考试（社区观察到的取值）
      const typeCode = Number(r.type ?? r.activityType ?? -1);
      const kind: TaskKind = typeCode === 3 ? 'exam' : typeCode === 2 ? 'quiz' : 'homework';

      tasks.push({
        platformTaskId: id === undefined ? undefined : String(id),
        courseId: course.platformCourseId,
        courseName: course.name,
        kind,
        // 用「课次名 · 活动名」作标题，否则只看到一堆「习题」无从区分
        title: `${lesson.title} · ${String(title)}`.trim(),
        status: mapYuketangStatus(r.status ?? r.submitStatus),
        deadline: r.endTime ?? r.deadline ?? r.end_at,
        publishedAt: r.startTime ?? r.start_at,
        score: toNumber(r.score),
        totalScore: toNumber(r.totalScore ?? r.scoreTotal),
        raw: r,
      });
    }
    return tasks;
  }

  buildTaskUrl(courseId: string, task: PlatformTask): string | undefined {
    if (this.#isChangjiang) {
      // ⚠️ 这里踩过一次（2026-10-23 真机）：拼成 /v2/web/classroom/{id}/exams 之后，
      // 打开是「页面不存在或学习内容被删除」—— 因为那个位置要的是 **classroomId（班级）**，
      // 而我们存的 platformCourseId 是 **courseId（课程）**：
      // 详见 parseYuketangCourses，它在拿不到 classroomId 时回落到 course.id，
      // 而拉作业用的是 cid=（课程 ID），说明这个值确实只当课程 ID 用。
      //
      // 没有真实抓包确认「课程 ID → 班级 ID」的映射来源之前，先退到平台首页：
      // 用户点进去还能自己找到那门课，而给一个必然报错的链接只会让人以为应用坏了。
      return this.#base;
    }
    // 主站和长江是同一套 /v2/web 前端，所以走同一个形态。
    // 旧的 /lesson/{courseId}/{exercise|exam}/{id} 实测 **404**（2026-10-23 未登录请求验证），
    // 那条路径已经废弃。这里只能定位到「该课程的作业标签」，因为主站没有稳定的单条作业 URL 形态。
    return `${this.#base}/v2/web/classroom/${encodeURIComponent(courseId)}/exams?tab=homework`;
  }
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 雨课堂的状态字段。
 * 注意：只看到过「未提交 / 已提交」两态，成绩接口是分开的，
 * 所以 graded 只能通过 score 是否存在推断。
 */
function mapYuketangStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? '').toLowerCase();
  if (['0', '未提交', '未交', 'pending', 'todo'].includes(s)) return 'pending';
  if (['1', '已提交', 'submitted'].includes(s)) return 'submitted';
  if (['2', '已批改', 'graded'].includes(s)) return 'graded';
  return 'unknown';
}


/**
 * 长江雨课堂课程列表解析（字段名来自 2026-09-29 真实抓包）：
 * { name: '2026秋-25网络空间01；…'（班级名）, classroom_id: 26617021,
 *   course: { name: '信息安全数学基础'（课程名）, id }, teacher: { name } }
 */
export function parseYuketangCourses(list: unknown[]): PlatformCourse[] {
  const out: PlatformCourse[] = [];
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const course = (r.course ?? {}) as Record<string, unknown>;
    const id = r.classroomId ?? r.classroom_id ?? course.id;
    // r.name 是班级名（'2026秋-25网络空间01；…'），course.name 才是课程名
    const name = course.name ?? r.courseName ?? r.name;
    if (id === undefined || !name) continue;
    const teacher = (r.teacher ?? {}) as Record<string, unknown>;
    out.push({
      platformCourseId: String(id),
      name: String(name).trim(),
      teacher: typeof teacher.name === 'string' ? teacher.name : undefined,
      raw: r,
    });
  }
  return out;
}

/**
 * 递归收集章节树里的作业/测验叶子（leaf_type=9）。
 * 字段来自真实抓包：{ name, leaf_type:9, id, start_time/end_time/score_deadline（毫秒）, is_assessed }。
 * 计分截止（score_deadline）优先作为 deadline；已过 → expired。
 *
 * ⚠️ **这个接口里没有完成态** —— 已用字段取证钉死（2026-10-11 真机，v0.1.53/0.1.55）：
 * 整棵树的**全局字段并集**只有 17 个键（比叶子多一个 `section_leaf_list`），
 * 没有 status / is_finish / progress 之类。而平台的学习目录页确实给已完成的试卷打了绿勾。
 *
 * 所以完成态一定在**别处**。查前端 JS（HAR 里 45 个文件、2000 万字符）得到的结论：
 * 它按 leaf 类型**分散在各自的 per-leaf 接口**里 ——
 *   图文 `/mooc-api/v1/lms/learn/user_article_finish(_status)/{leaf_id}/`
 *   视频 `/video-log/get_video_watch_progress/`
 *   讨论 `/v/discussion/v2/student/comment/status/`
 *   试卷/成绩 `/c27/online_courseware/schedule/score_detail/single/user-score/{classroom_id}/{sku_id}/{user_id}/`
 * 而且学习目录页自己调的就是本章节接口（参数只有 cid/sign，比我们还少）——
 * **不是我们漏参数，是这个接口就没有这个信息**。
 *
 * ⇒ 要拿完成态 = 每个 leaf 一个请求，试卷那条还要先换 sku_id / user_id。
 * 成本远超收益，**不做**；改由用户手动标记（见 domain/task.ts 的 effectiveStatus）。
 * 因此这里的状态必须标 `statusSource: 'inferred'` —— 平台什么都没说，
 * 不能让界面替它断言"你还没交"。
 */
export function collectChangjiangLeaves(
  node: unknown,
  out: PlatformTask[],
  courseId: string,
  courseName: string,
  nowMs: number,
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectChangjiangLeaves(child, out, courseId, courseName, nowMs);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const r = node as Record<string, unknown>;
  const leafType = Number(r.leaf_type);
  const name = r.name;
  if (leafType === 9 && typeof name === 'string' && name.trim()) {
    const scoreMs = Number(r.score_deadline);
    const endMs = Number(r.end_time);
    const deadlineMs = Number.isFinite(scoreMs) && scoreMs > 1e12 ? scoreMs : Number.isFinite(endMs) && endMs > 1e12 ? endMs : undefined;
    const startMs = Number(r.start_time);
    out.push({
      platformTaskId: r.id !== undefined ? String(r.id) : r.leafinfo_id !== undefined ? String(r.leafinfo_id) : undefined,
      courseId,
      courseName,
      kind: 'homework',
      title: name.trim(),
      status: deadlineMs !== undefined && deadlineMs < nowMs ? 'expired' : 'pending',
      // **这是推断，不是平台说的。** 章节树里没有任何完成态字段（2026-10-11 字段取证），
      // 所以标 inferred：用户手动标「已完成」时才不会被"平台优先"规则压住 ——
      // 否则界面就是在替平台断言"你还没交"，而平台其实什么都没说。
      statusSource: 'inferred',
      deadline: deadlineMs !== undefined ? new Date(deadlineMs).toISOString() : undefined,
      publishedAt: Number.isFinite(startMs) && startMs > 1e12 ? new Date(startMs).toISOString() : undefined,
      raw: r,
    });
    return; // 叶子节点不再下钻
  }
  for (const k of Object.keys(r)) collectChangjiangLeaves(r[k], out, courseId, courseName, nowMs);
}
