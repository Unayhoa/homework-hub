/**
 * 适配器契约 —— 整个项目的扩展点。
 *
 * 借鉴 WakeUp课程表 CourseAdapter 的做法（那个项目要求贡献者
 * 继承抽象类 Parser 并重写 generateCourseList），但做了三点改进：
 *
 *   1. 数据源无关。CourseAdapter 假设输入是教务系统的 HTML，
 *      而学习通是纯 JSON API、iSmart 是 native 签名请求、
 *      雨课堂是 WebSocket。契约层面不应该假设数据形态。
 *   2. 显式声明能力。capabilities 让 UI 能提前知道
 *      「这个平台能不能增量拉取 / 需不需要额外组件」，
 *      而不是运行到一半才失败。
 *   3. 会话语义化。login 返回 Session 而不是「往全局 cookie jar 里塞」，
 *      这样多账号并存、会话持久化、过期探测才有落点。
 */
import type { Clock } from '../domain/time.ts';
import type { PlatformCourse, UnifiedCourse } from '../domain/course.ts';
import type { PlatformTask } from '../domain/task.ts';
import type { HttpClient } from './http.ts';
import type { Limiter } from './limiter.ts';
import type { Logger } from './logger.ts';
import type { Credentials, Session } from './vault.ts';
import type { NativeSigner } from './signer.ts';
import type { ReadOnlyPolicy } from './read-only.ts';

export interface AdapterCapabilities {
  /** 能拉课程列表 */
  courses: boolean;
  /** 能拉任务（作业/测验/任务点） */
  tasks: boolean;
  /** 能拉考试 */
  exams: boolean;
  /** 支持分页游标增量拉取；false 则每次全量 */
  incremental: boolean;
  /** 登录获得的会话能否长期复用（只靠 cookie 就能续） */
  cookieOnlySession: boolean;
  /** 需要 native 签名组件才能完整工作 */
  requiresNativeSigner: boolean;
  /** 平台对非官方客户端有主动风控，建议保守的请求频率 */
  aggressiveAntiBot: boolean;
  /**
   * 每轮同步开始前先主动探测一次会话。
   *
   * 什么时候该开：会话**本地无法判断是否过期**（平台没下发带 Expires 的凭证，
   * 我们手里没有 expiresAt）。此时引擎默认是"直接去拉数据，失败了再说"，
   * 于是会话失效要跑到第一个业务请求才暴露。
   *
   * 开了之后有两个好处：
   *   1. 失效在第一个请求就被识别，错误分类准确，也不白跑后面的请求；
   *   2. 探测本身是一次请求 —— 如果平台的会话是**闲置超时**（一段时间没有请求
   *      就失效，web 会话的常见形态），它同时起到了"续活"的作用。
   * 代价是每轮同步多 1 个只读请求，所以只在确有需要的平台打开。
   */
  probeBeforeSync?: boolean;
}

export interface AuthField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

export interface AuthMethod {
  id: string;
  label: string;
  /**
   * password: 账号密码
   * qrcode: 扫码
   * cookie-import: 手动粘贴 cookie
   * in-app: 在应用内打开平台官方登录页（cookie 由系统保管，本应用读不到也存不了）
   */
  kind: 'password' | 'qrcode' | 'cookie-import' | 'in-app';
  fields: AuthField[];
  hint?: string;
  /**
   * kind === 'in-app' 时必填：要在应用内打开的平台登录页。
   *
   * 由适配器自己声明 —— 只有适配器知道自家登录页在哪（真机踩过：
   * iSmart 的登录页在 me.ismartlearning.cn，而 homeage 是营销主站 www.，
   * 拿 homepage 当登录页会打开一个没有登录入口的页面）。
   */
  loginUrl?: string;
}

export interface AdapterContext {
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  /** 由 engine 注入，适配器不需要自己控制请求节奏 */
  limiter: Limiter;
  signer: NativeSigner;
}

export interface Page<T> {
  items: T[];
  /** 下一页游标；undefined 表示没有更多 */
  nextCursor?: string;
  hasMore: boolean;
  /**
   * 上游声明的总数（如果平台有返回）。
   * engine 用它做 schema drift 检测：声明 30 条却解析出 0 条 → 一定改版了。
   */
  declaredTotal?: number;

  /**
   * 适配器想对用户说的一句话（诊断结论 / 已知边界）。
   *
   * 为什么要这条通道：适配器是唯一看得见**上游原始数据**的地方，但它此前只能
   * 「抛错」或「什么都不说」。于是像「这个平台的树里没有完成状态」这种结论
   * 只能写在代码注释里 —— 用户永远看不到，而它恰恰解释了「为什么已完成栏是空的」。
   * 沉默的已知缺陷，等价于一个还没被发现的 bug。
   *
   * 由 engine 并进本轮同步消息。**必须简短**（它是消息，不是日志）；
   * 长内容请自己截断，engine 只做总量兜底。
   */
  notes?: string[];
}

export interface FetchCoursesRequest {
  cursor?: string;
}

export interface FetchTasksRequest {
  cursor?: string;
  /** 已缓存的课程列表，省一次请求 */
  courses?: UnifiedCourse[];
  limit?: number;
  /**
   * 跑完整诊断：适配器在疑似会话失效时可以「提前中止」（连续 N 门课失败就停，
   * 避免白打上百个请求）；用户再点一次同步时引擎会带上这个标记，
   * 让适配器跑完全部课程以拿到完整诊断信息。
   */
  fullDiagnostics?: boolean;

  /**
   * 已判定为「静默」的课程（平台原始课程 ID）。
   *
   * 静默 = 该课程全部任务都是终态、且最近 14 天没有任何变化。
   * 这类课程不会再产生新内容（尤其不会再发新的考试/测验），
   * 适配器可以跳过那些**专门为了发现新内容**而发的低频探测请求。
   *
   * 为什么由引擎判定：它能看到全量历史数据；适配器只看得到本次请求。
   * 判定语义属于「数据」层，请求策略属于「适配器」层 —— 分开才不打架。
   *
   * 注意：作业本身查不查仍由 courses / cursor 决定，这里只影响额外探测。
   */
  quietCourseIds?: string[];
}

export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  /** 平台入口，用于「去平台处理」按钮 */
  readonly homepage: string;
  readonly capabilities: AdapterCapabilities;
  readonly authMethods: AuthMethod[];


  /**
   * 会话失效时的「最可能原因」，按可能性**从高到低**排列（可选）。
   *
   * 为什么必须由适配器给、而不是引擎写一句通用的：
   * 这句话直接决定用户下一步做什么。写「可能是异地登录」会让人以为账号被盗、
   * 跑去改密码；而真实主因往往平淡得多（服务端会话闲置超时）。
   * 归因顺序错 = 用户接下来做的事全错，所以只有最了解平台机制的一方有权给出。
   */
  readonly sessionExpiryCauses?: string[];

  /**
   * 「保活探测」的声明（可选）。引擎/宿主照此**定时**发一个最便宜的只读请求。
   *
   * 存在的理由有两层，缺一层就不该声明：
   *   1. **测量**：会话与上一级票据（如 SSO 总票据）到底能活多久，
   *      只有靠"定时打点 + 记录结果"才测得出来 —— 靠用户手动记时间不现实；
   *   2. **减少掉线**：如果平台的失效是闲置超时，那么定时请求本身就能把它续上。
   *
   * ⚠️ 声明它 = 允许 App 在**没打开**的时候也发请求。
   * 所以只允许填最便宜的那一个探活接口，且间隔不得短于 15 分钟。
   */
  readonly keepAliveProbe?: {
    /** 探活请求地址（必须是只读接口，通常是 probeSession 用的那一个） */
    url: string;
    method: 'GET' | 'POST';
    /** POST 时的表单体；GET 留空 */
    body?: string;
    /** 响应文本命中此正则 = 会话仍然有效 */
    alivePattern: string;
    /** 探测间隔（毫秒），不得短于 15 分钟 */
    intervalMs: number;
  };

  /**
   * 只读策略。engine 会用它在 HTTP 层强制拦截一切可能改变服务端状态的请求。
   *
   * 不填则使用最严格的默认值：只允许 GET / HEAD。
   * 如果你的平台连课程列表都只能用 POST，必须在 allowPost 里逐条声明并写清用途 ——
   * 这份声明会构成整个 app「会发出哪些写请求」的完整审计清单。
   */
  readonly readOnlyPolicy?: ReadOnlyPolicy;

  login(ctx: AdapterContext, cred: Credentials): Promise<Session>;

  /**
   * 会话失效时的**自动恢复尝试**（可选能力）。
   *
   * 有些平台在"本层会话"失效时，**上一层凭证**还留着（比如单点登录的总票据）。
   * 浏览器遇到这种情况会静默重新走一遍换票流程，用户毫无察觉 ——
   * 这个钩子就是把这个动作搬到我们这边来。
   *
   * 返回值：
   *   recovered=true  → 会话已经能用了，引擎当作什么都没发生，同步继续；
   *   recovered=false → 正常报会话失效，note 会作为附注出现在给用户看的信息里
   *                     （要重登时，用户至少能看到"为什么自动续登没成功"）。
   *
   * 只在会话**已经失效**时调用 —— 那时同步本来就要失败，多这几个请求没有额外代价。
   *
   * diagnosis 是给**排障**用的，不改变任何行为：
   * 自动接回失败有好几种原因，而它们的下一步完全相反 ——
   * 「上一级票据也过期了」说明这是平台策略、App 侧没有可修的入口；
   * 「换到票了但本域不认」说明这条路本身是坏的、值得继续修。
   * 不区分的话，我们只能靠猜来决定还要不要在这条路上投入。
   */
  recoverSession?(
    ctx: AdapterContext,
    session: Session,
  ): Promise<{
    recovered: boolean;
    note?: string;
    diagnosis?: 'recovered' | 'ticket-expired' | 'mechanism' | 'channel';
  }>;

  /**
   * 轻量探测会话是否仍有效。
   * 注意：必须用最便宜的接口（比如「获取用户信息」），
   * 绝不能为了探测去拉全量作业 —— 那会让请求量翻倍。
   */
  probeSession(ctx: AdapterContext, session: Session): Promise<boolean>;

  fetchCourses(ctx: AdapterContext, session: Session, req?: FetchCoursesRequest): Promise<Page<PlatformCourse>>;

  fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>>;

  /** 构造任务深链，UI 里点一下就能跳到平台对应页面 */
  buildTaskUrl?(courseId: string, task: PlatformTask): string | undefined;
}

/** 适配器元信息，用于「支持的平台」列表页展示（不需要实例化适配器）。 */
export interface AdapterManifest {
  id: string;
  displayName: string;
  homepage: string;
  capabilities: AdapterCapabilities;
  authMethods: AuthMethod[];
  /** 适配器成熟度，让用户心里有数 */
  maturity: 'stable' | 'beta' | 'experimental';
  notes?: string;
}
