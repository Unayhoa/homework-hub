/**
 * Mock 平台服务器。
 *
 * 存在的意义：真实的超星/雨课堂/iSmart 我无法在没有真实账号的前提下验证，
 * 但「同步引擎是否正确」这件事完全可以被证明 —— 只要有一个能
 * 精准复现平台各种恶劣行为的假平台。
 *
 * 它能复现的行为：
 *   - Cookie 会话登录与 401 过期
 *   - 分页游标
 *   - 429 限流（带 Retry-After）
 *   - 5xx 抖动
 *   - 平台改版（字段改名 / 整个字段消失）
 *   - 任务新增、截止时间被老师改、任务被删
 *   - 脏数据：截止时间混用 ISO 字符串 / epoch 毫秒 / 「还剩 3 天」/ 不限时
 *
 * 这些正是生产环境里会把聚合类应用搞崩的全部情况。
 */
// 注意：node:http / node:crypto 只在开发环境用。
// 为了让 mock 适配器也能被打进 Android WebView 的模块图（虽然从不在那跑），
// 顶层的 node 引入必须去掉 —— 否则前端 bundle 会因为解析不到 node:http 而整个加载失败。
// 所以这里：createServer 用动态 import，随机数用全局 crypto。
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** 生成随机会话 token。Node 与浏览器都有 globalThis.crypto。 */
function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type MockMode = 'ok' | 'drift' | 'ratelimit' | 'flaky' | 'expired';

export interface MockTask {
  id: string;
  courseId: string;
  kind: string;
  title: string;
  status?: string;
  /** 故意允许各种脏格式 */
  deadline?: string | number;
  publishedAt?: string;
  score?: number;
  totalScore?: number;
  /**
   * 线上格式里不返回本任务的 ID。
   * 用来复现「平台不提供稳定任务 ID」这一真实情况，
   * 以验证核心的指纹兜底主键逻辑。
   */
  omitWireId?: boolean;
}

export interface MockCourse {
  id: string;
  name: string;
  teacher?: string;
}

export interface MockAccount {
  username: string;
  password: string;
  displayName?: string;
}

export interface MockPlatformOptions {
  port?: number;
  host?: string;
  accounts: MockAccount[];
  courses: MockCourse[];
  tasks: MockTask[];
  /** 每页条数 */
  pageSize?: number;
  /** 人为延迟，模拟真实网络 */
  latencyMs?: number;
}

export interface MockRequestRecord {
  method: string;
  path: string;
  at: number;
}

export interface MockState {
  mode: MockMode;
  taskCount: number;
  courseCount: number;
  requestCount: number;
  activeSessions: number;
  tasks: MockTask[];
  /**
   * 收到的所有请求（方法与路径）。
   *
   * 这个字段是「只读承诺」的证据：测试可以断言
   * 「除登录外，平台只收到过 GET」——把「我们不影响平台」这句话
   * 从文档里的声明，变成一条可执行的断言。
   */
  requests: MockRequestRecord[];
  /** 按方法聚合的计数 */
  methods: Record<string, number>;
}

interface SessionRecord {
  username: string;
  createdAt: number;
}

export const SESSION_COOKIE = 'MOCK_SESSION';

export class MockPlatform {
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #accounts: MockAccount[];
  readonly #pageSize: number;
  readonly #latencyMs: number;
  readonly #initialTasks: MockTask[];
  readonly #initialCourses: MockCourse[];

  #tasks: MockTask[];
  #courses: MockCourse[];
  #sessions = new Map<string, SessionRecord>();
  #mode: MockMode = 'ok';
  #requestCount = 0;
  #requestLog: MockRequestRecord[] = [];
  #submitCount = 0;
  /** flaky / ratelimit 模式下的剩余触发次数 */
  #failBudget = 0;
  #server: Server | undefined;
  #port = 0;

  constructor(opts: MockPlatformOptions) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#requestedPort = opts.port ?? 0;
    this.#accounts = opts.accounts;
    this.#pageSize = opts.pageSize ?? 3;
    this.#latencyMs = opts.latencyMs ?? 0;
    this.#initialTasks = structuredClone(opts.tasks);
    this.#initialCourses = structuredClone(opts.courses);
    this.#tasks = structuredClone(opts.tasks);
    this.#courses = structuredClone(opts.courses);
  }

  get url(): string {
    if (!this.#port) throw new Error('服务器尚未启动');
    return `http://${this.#host}:${this.#port}`;
  }

  get state(): MockState {
    const methods: Record<string, number> = {};
    for (const r of this.#requestLog) methods[r.method] = (methods[r.method] ?? 0) + 1;
    return {
      mode: this.#mode,
      taskCount: this.#tasks.length,
      courseCount: this.#courses.length,
      requestCount: this.#requestCount,
      activeSessions: this.#sessions.size,
      tasks: structuredClone(this.#tasks),
      requests: structuredClone(this.#requestLog),
      methods,
    };
  }

  async start(): Promise<string> {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      this.#route(req, res).catch((e: unknown) => {
        writeJson(res, 500, { error: 'mock server internal error', detail: String(e) });
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(this.#requestedPort, this.#host, resolve));
    const addr = server.address();
    if (addr && typeof addr === 'object') this.#port = addr.port;
    return this.url;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }

  // ------------------------------------------------------------ 故障控制

  setMode(mode: MockMode, failBudget = 2): void {
    this.#mode = mode;
    this.#failBudget = failBudget;
  }

  addTask(task: MockTask): void {
    this.#tasks.push(task);
  }

  shiftDeadline(taskId: string, newDeadline: string | number): boolean {
    const t = this.#tasks.find((x) => x.id === taskId);
    if (!t) return false;
    t.deadline = newDeadline;
    return true;
  }

  deleteTask(taskId: string): boolean {
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter((t) => t.id !== taskId);
    return this.#tasks.length < before;
  }

  invalidateSessions(): void {
    this.#sessions.clear();
  }

  reset(): void {
    this.#tasks = structuredClone(this.#initialTasks);
    this.#courses = structuredClone(this.#initialCourses);
    this.#mode = 'ok';
    this.#requestCount = 0;
    this.#requestLog = [];
    this.#submitCount = 0;
    this.#failBudget = 0;
  }

  // ------------------------------------------------------------ 路由

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#requestCount += 1;
    if (this.#latencyMs > 0) await new Promise((r) => setTimeout(r, this.#latencyMs));

    const url = new URL(req.url ?? '/', `http://${this.#host}:${this.#port}`);
    const path = url.pathname;
    this.#requestLog.push({
      method: (req.method ?? 'GET').toUpperCase(),
      path: `${path}${url.search}`,
      at: Date.now(),
    });

    // 控制接口不受故障模式影响，否则注入故障后就没法恢复
    if (path === '/__state') return writeJson(res, 200, this.state);
    if (path === '/__control') return this.#handleControl(req, res);
    if (path === '/login') return this.#handleLogin(req, res);
    // 一个「危险端点」：只读守卫应该永远不让请求到达这里。
    // 如果它出现在请求日志里，说明守卫被绕过了。
    if (path === '/submit') return this.#handleSubmit(req, res);

    if (this.#mode === 'expired') {
      return writeJson(res, 401, { error: 'session expired' });
    }
    if (this.#mode === 'ratelimit' && this.#failBudget > 0) {
      this.#failBudget -= 1;
      return writeJson(res, 429, { error: 'too many requests' }, { 'Retry-After': '1' });
    }
    if (this.#mode === 'flaky' && this.#failBudget > 0) {
      this.#failBudget -= 1;
      return writeJson(res, 503, { error: 'temporarily unavailable' });
    }

    if (path === '/api/user') return this.#handleUser(req, res);
    if (path === '/api/courses') return this.#handleCourses(req, res);
    if (path === '/api/tasks') return this.#handleTasks(req, res, url);

    writeJson(res, 404, { error: 'not found', path });
  }

  /** 会话校验：返回用户名，未登录返回 null。 */
  #auth(req: IncomingMessage): string | null {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE];
    if (!sid) return null;
    return this.#sessions.get(sid)?.username ?? null;
  }

  async #handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');

    const account = this.#accounts.find((a) => a.username === username);
    if (!account || account.password !== password) {
      // 与真实平台一致：登录失败返回 200 + status:false，而不是 4xx
      return writeJson(res, 200, { status: false, message: '用户名或密码错误' });
    }

    const sid = randomToken(16);
    this.#sessions.set(sid, { username, createdAt: Date.now() });
    return writeJson(
      res,
      200,
      { status: true, uid: username, displayName: account.displayName ?? username },
      {
        'Set-Cookie': `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly`,
      },
    );
  }

  async #handleUser(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const username = this.#auth(req);
    if (!username) return writeJson(res, 401, { error: 'not logged in' });
    writeJson(res, 200, { username, displayName: username, uid: username });
  }

  /**
   * 「危险端点」诱饵。
   *
   * 真实场景里这个路径会提交作业答案。它存在的唯一目的，
   * 是让测试有机会去**尝试**提交，从而证明只读守卫确实拦住了 —— 
   * 一个从没被尝试过的保护措施，等于没有保护措施。
   */
  async #handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#auth(req)) return writeJson(res, 401, { error: 'not logged in' });
    this.#submitCount += 1;
    writeJson(res, 200, { ok: true, submitted: true, warn: '如果这行出现，说明只读守卫被绕过了' });
  }

  /** 被真正提交过的次数。只读模式下属正常路径应恒为 0。 */
  get submitCount(): number {
    return this.#submitCount;
  }

  async #handleCourses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#auth(req)) return writeJson(res, 401, { error: 'not logged in' });
    writeJson(res, 200, {
      courses: this.#courses.map((c) => ({
        courseId: c.id,
        courseName: c.name,
        teacher: c.teacher,
      })),
      total: this.#courses.length,
    });
  }

  async #handleTasks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#auth(req)) return writeJson(res, 401, { error: 'not logged in' });

    // 改版模式：字段整体改名 + 总数恢复正常。
    // 一个幼稚的解析器会解析出 0 条并且「成功」返回 —— 正是要防守的场景。
    if (this.#mode === 'drift') {
      return writeJson(res, 200, { total: this.#tasks.length, dataList: [] });
    }

    const offset = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const limit = Number(url.searchParams.get('limit') ?? String(this.#pageSize)) || this.#pageSize;
    const slice = this.#tasks.slice(offset, offset + limit);
    const next = offset + limit;
    const hasMore = next < this.#tasks.length;

    writeJson(res, 200, {
      total: this.#tasks.length,
      list: slice.map(toWireTask),
      nextCursor: hasMore ? String(next) : null,
      hasMore,
    });
  }

  async #handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const action = String(body.action ?? '');

    switch (action) {
      case 'setMode':
        this.setMode(body.mode as MockMode, Number(body.failBudget ?? 2));
        return writeJson(res, 200, { ok: true, mode: this.#mode });
      case 'addTask':
        this.addTask(body.task as MockTask);
        return writeJson(res, 200, { ok: true, tasks: this.#tasks.length });
      case 'shiftDeadline':
        return writeJson(res, 200, {
          ok: this.shiftDeadline(String(body.taskId), body.deadline as string | number),
        });
      case 'deleteTask':
        return writeJson(res, 200, { ok: this.deleteTask(String(body.taskId)) });
      case 'invalidateSessions':
        this.invalidateSessions();
        return writeJson(res, 200, { ok: true });
      case 'reset':
        this.reset();
        return writeJson(res, 200, { ok: true });
      case 'state':
        return writeJson(res, 200, this.state);
      default:
        return writeJson(res, 400, { error: `unknown action: ${action}` });
    }
  }
}

/**
 * 把内部任务转成「线上格式」。
 * 刻意模仿真实平台的坏习惯：字段命名不统一、时间格式混杂、存在多余包装层。
 */
function toWireTask(t: MockTask): Record<string, unknown> {
  return {
    // 超星风格：ID 藏在 workId 里，且写成字符串。
    // omitWireId 时整个字段不下发 —— 平台确实会这样。
    ...(t.omitWireId ? {} : { workId: t.id }),
    courseId: t.courseId,
    // 类型字段是字符串枚举，不是数字 —— 归一化必须在这里做
    workType: t.kind,
    workName: t.title,
    status: t.status ?? 'pending',
    endTime: t.deadline,
    releaseTime: t.publishedAt,
    score: t.score,
    totalScore: t.totalScore,
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * 解析请求体。
 * 同时支持 JSON 与 application/x-www-form-urlencoded ——
 * 真实平台大多是表单登录（超星的 fanyalogin 就是表单），
 * mock 服务器必须两种都收，否则测不出适配器的编码是否正确。
 */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType.includes('application/json')) {
        try {
          return resolve(JSON.parse(buf) as Record<string, unknown>);
        } catch {
          return resolve({});
        }
      }
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(buf);
        const out: Record<string, unknown> = {};
        for (const [k, v] of params) out[k] = v;
        return resolve(out);
      }
      // 没声明 content-type 时两种都试
      try {
        return resolve(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        const params = new URLSearchParams(buf);
        const out: Record<string, unknown> = {};
        for (const [k, v] of params) out[k] = v;
        return resolve(out);
      }
    });
  });
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
