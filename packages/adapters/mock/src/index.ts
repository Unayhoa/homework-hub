/**
 * Mock 平台适配器。
 *
 * 双向价值：
 *   1. 它是端到端验证用的「真平台替身」，让核心引擎的行为可被证明；
 *   2. 它是新适配器作者的**参考实现** —— 一个适配器最少需要写哪些东西，
 *      看这一个文件就够了（登录、探测、课程、分页任务、深链）。
 *
 * 也被刻意写成「教科书式的严格解析」：
 * 绝不假设字段一定存在，字段缺失时抛 schemaDrift 而不是静默返回空数组。
 */
import type {
  AdapterCapabilities,
  AdapterContext,
  AuthMethod,
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

interface WireTask {
  workId?: string;
  courseId?: string;
  workType?: string;
  workName?: string;
  status?: string;
  endTime?: string | number;
  releaseTime?: string;
  score?: number;
  totalScore?: number;
}

/** 平台数字/字符串枚举 → 统一类型。遇到未知值不要抛错，回退到 other/unknown。 */
function mapKind(raw: unknown): TaskKind {
  switch (String(raw ?? '')) {
    case 'homework':
    case 'work':
      return 'homework';
    case 'exam':
      return 'exam';
    case 'quiz':
    case 'test':
      return 'quiz';
    case 'task-point':
    case 'video':
      return 'task-point';
    case 'discussion':
      return 'discussion';
    default:
      return 'other';
  }
}

function mapStatus(raw: unknown): TaskStatus {
  switch (String(raw ?? '')) {
    case 'pending':
    case '未交':
      return 'pending';
    case 'submitted':
    case '已交':
      return 'submitted';
    case 'graded':
    case '已批阅':
      return 'graded';
    case 'expired':
      return 'expired';
    default:
      return 'unknown';
  }
}

export interface MockAdapterOptions {
  baseUrl: string;
  displayName?: string;
}

export class MockAdapter implements PlatformAdapter {
  readonly id = 'mock';
  readonly displayName: string;
  readonly homepage = '';
  readonly #baseUrl: string;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: true,
    incremental: true,
    cookieOnlySession: true,
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
  };

  readonly authMethods: AuthMethod[] = [
    {
      id: 'password',
      label: '账号密码',
      kind: 'password',
      fields: [
        { key: 'username', label: '用户名' },
        { key: 'password', label: '密码', secret: true },
      ],
    },
  ];

  /**
   * 只读策略。
   *
   * 整个适配器唯一允许的非 GET 请求就是登录 —— 这份清单短得可以一眼看完，
   * 而「能不能一眼看完」正是这个设计的目的。
   * 数据读取（课程 / 任务 / 探测）全部是 GET，不可能绕过守卫。
   */
  readonly readOnlyPolicy: ReadOnlyPolicy = {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [{ pattern: /\/login$/, why: '账号密码登录（会在服务端创建会话，但这是用户明确要求的动作）' }],
  };

  constructor(opts: MockAdapterOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.displayName = opts.displayName ?? 'Mock 教学平台（本地）';
  }

  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const session: Session = {
      platformId: this.id,
      accountId: '',
      cookies: {},
      headers: {},
      issuedAt: ctx.clock.now().toISOString(),
      displayName: undefined,
    };
    const http = new SessionHttpClient(ctx, session);

    const res = await http.postForm<{ status?: boolean; message?: string; uid?: string; displayName?: string }>(
      `${this.#baseUrl}/login`,
      { username: cred.username ?? '', password: cred.password ?? '' },
    );

    // 真实平台常见形态：HTTP 200 + 业务错误码，所以不能只看状态码
    if (res.body?.status !== true) {
      throw new HubError('AUTH_FAILED', `登录失败：${res.body?.message ?? '账号或密码错误'}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    return {
      ...session,
      origin: 'derived', // 账号密码独立登录 —— 引擎据此知道「失效时可以让用户重新登录」
      userId: res.body.uid,
      displayName: res.body.displayName,
      issuedAt: ctx.clock.now().toISOString(),
    };
  }

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const http = new SessionHttpClient(ctx, session);
    try {
      const res = await http.getJson<{ username?: string }>(`${this.#baseUrl}/api/user`);
      return res.status === 200 && Boolean(res.body?.username);
    } catch (e) {
      if (e instanceof HubError && e.code === 'AUTH_REQUIRED') return false;
      throw e;
    }
  }

  async fetchCourses(ctx: AdapterContext, session: Session): Promise<Page<PlatformCourse>> {
    const http = new SessionHttpClient(ctx, session);
    const res = await http.getJson<{ courses?: Array<{ courseId?: string; courseName?: string; teacher?: string }>; total?: number }>(
      `${this.#baseUrl}/api/courses`,
    );

    const declaredTotal = res.body?.total ?? 0;
    const list = res.body?.courses;
    if (!Array.isArray(list)) {
      throw schemaDrift(this.id, `预期字段 courses 为数组，实际为 ${typeof list}`);
    }
    if (list.length === 0 && declaredTotal > 0) {
      throw schemaDrift(this.id, `上游声明 ${declaredTotal} 门课程，实际解析出 0 门`);
    }

    return {
      items: list
        .filter((c) => c.courseId)
        .map((c) => ({
          platformCourseId: String(c.courseId),
          name: String(c.courseName ?? '未命名课程'),
          teacher: c.teacher,
        })),
      hasMore: false,
      declaredTotal,
    };
  }

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    const http = new SessionHttpClient(ctx, session);
    const cursor = req.cursor ?? '0';
    const limit = req.limit ?? 100;

    const res = await http.getJson<{
      total?: number;
      list?: WireTask[];
      nextCursor?: string | null;
      hasMore?: boolean;
    }>(`${this.#baseUrl}/api/tasks?cursor=${encodeURIComponent(cursor)}&limit=${limit}`);

    const declaredTotal = res.body?.total;
    const list = res.body?.list;

    // 改版检测：total 在但没有 list —— 典型「字段改名」场景。
    // 如果不抛错而是返回空数组，用户会以为作业做完了。
    if (!Array.isArray(list)) {
      throw schemaDrift(
        this.id,
        `预期字段 list 为数组，实际为 ${typeof list}（响应键：${Object.keys(res.body ?? {}).join(',')}）`,
      );
    }

    return {
      items: list.map((w) => this.#toPlatformTask(w)),
      nextCursor: res.body?.nextCursor ?? undefined,
      hasMore: Boolean(res.body?.hasMore),
      declaredTotal: typeof declaredTotal === 'number' ? declaredTotal : undefined,
    };
  }

  #toPlatformTask(w: WireTask): PlatformTask {
    if (!w.workId && !w.workName) {
      throw schemaDrift(this.id, `任务记录既无 workId 也无 workName：${JSON.stringify(w).slice(0, 120)}`);
    }
    return {
      // 刻意留一个口子：如果上游没给 workId，就交给核心的指纹兜底逻辑处理，
      // 从而验证「无稳定 ID」这条路径。真实平台确实存在这种情况。
      platformTaskId: w.workId ? String(w.workId) : undefined,
      courseId: String(w.courseId ?? 'unknown'),
      kind: mapKind(w.workType),
      title: String(w.workName ?? '（无标题）'),
      status: mapStatus(w.status),
      deadline: w.endTime,
      publishedAt: w.releaseTime,
      score: w.score,
      totalScore: w.totalScore,
      raw: w,
    };
  }

  buildTaskUrl(courseId: string, task: PlatformTask): string | undefined {
    if (!task.platformTaskId) return undefined;
    return `${this.#baseUrl}/work/${encodeURIComponent(courseId)}/${encodeURIComponent(task.platformTaskId)}`;
  }
}

// 把 mock 服务器与夹具一并导出，方便 CLI / 测试端到端驱动
export { MockPlatform, SESSION_COOKIE } from './server.ts';
export type {
  MockMode,
  MockTask,
  MockCourse,
  MockAccount,
  MockPlatformOptions,
  MockState,
} from './server.ts';
export { createFixtures } from './fixtures.ts';
export type { Fixtures } from './fixtures.ts';
