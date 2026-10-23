/**
 * iSmart（外研社智慧教学平台）适配器。
 *
 * ★ 2026-09-27 按真实抓包（HAR）校准过，不再是推断值 ★
 *
 * 真实接口结构（来自 me.ismartlearning.cn 学生端的抓包）：
 *   - API 主机是 school.ismartlearning.cn（me. 只出 HTML 页面，www. 是营销官网）
 *   - 全部是 POST + application/x-www-form-urlencoded 表单，无签名、无 token 头，
 *     鉴权就是会话 cookie（页面在 me. 而接口在 school. 能工作，
 *     说明 cookie 挂在 .ismartlearning.cn 域下 —— Android 的 CookieManager 会自动带上）
 *   - 应答统一为 { data: {...}, result: { code: 0, msg: 'success' } }
 *
 * 此前社区流传的「ut 签名墙」说法对网页端学生接口不成立（那可能是客户端专属接口）。
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
import { md5 } from './md5.ts';
import { SessionHttpClient } from '#core/engine/session-http.ts';
import { looksLikeAuthWall } from '#core/infra/html.ts';

/** 端点表。已按 2026-09-27 抓包校准；平台改版时只需改这里。 */
export interface SmartEndpointMap {
  /** API 主机（学生端接口，抓包确认） */
  base: string;
  /** 学生端页面主机（buildTaskUrl 用） */
  webBase: string;
  /** SSO 主机（账号密码登录，来自登录页 up366config.ssoServer） */
  ssoBase: string;
  /** 当前用户信息 —— 会话探测。POST，无参数。 */
  currentUser: string;
  /** 课程列表。POST，表单 pager.currentPage / pager.pageSize。 */
  courseList: string;
  /** 作业（测验）列表。POST，表单 courseId / testStatus(0=进行中,1=已结束) / pager.*。 */
  homeworkTests: string;
  /** 账号密码登录。POST，表单 username / password / captcha。 */
  ssoLogin: string;
  /** 图形验证码图片（与会话 cookie 绑定，登录页 changeCode() 的真实地址）。 */
  captcha: string;
  /** 用 SSO 总票据换「访问票据」。POST，表单 service=…，靠 CASTGC 认人。 */
  ssoServiceTicket: string;
  /**
   * CAS 登录端点：`GET /login?service=<本域地址>`。
   * 带着总票据访问它 → 302 回本域并附服务票据 → 本域校验后下发新会话。
   * 这是浏览器里会话过期后**自动**恢复的真实路径（实测确认）。
   */
  ssoLoginEntry: string;
}

export const SmartEndpoints: SmartEndpointMap = {
  base: 'https://school.ismartlearning.cn',
  webBase: 'https://me.ismartlearning.cn',
  ssoBase: 'https://sso.ismartlearning.cn',
  currentUser: '/client/user/currentuser',
  courseList: '/client/course/list-of-student',
  homeworkTests: '/client/homework/tests/list-of-student',
  ssoLogin: '/v2/tickets-v3',
  captcha: '/captcha.html',
  ssoServiceTicket: '/v1/serviceTicket',
  ssoLoginEntry: '/login',
};

/**
 * 登录页 JS 里的密码加盐（login() 函数原文：
 *   hex_md5(hex_md5(password) + "fa&s*l%$k!fq$k!ld@fjlk")）。
 * 平台改登录逻辑时同步改这里。
 */
export const SMART_PASSWORD_SALT = 'fa&s*l%$k!fq$k!ld@fjlk';

/**
 * 验证码会话暂存：第一次 login（无 captcha）取图后把已绑定 kaptcha cookie 的
 * 会话放在这里，等用户填完验证码的第二次 login 复用。key = username。
 * 单用户设备场景，内存态足够；进程结束即失效（重新走一遍取图流程即可）。
 */
const pendingCaptchaSessions = new Map<string, Session>();

export interface SmartAdapterOptions {
  baseUrl?: string;
  endpoints?: Partial<SmartEndpointMap>;
}

export class IsmartAdapter implements PlatformAdapter {
  readonly id = 'ismart';
  readonly displayName = 'iSmart（外研社）';
  readonly homepage = 'https://me.ismartlearning.cn';
  readonly #base: string;
  readonly #webBase: string;
  readonly #ep: SmartEndpointMap;

  readonly capabilities: AdapterCapabilities = {
    courses: true,
    tasks: true,
    exams: false,
    incremental: false,
    cookieOnlySession: true,
    // 抓包证实：网页端学生接口是普通表单 POST，不需要任何签名
    requiresNativeSigner: false,
    aggressiveAntiBot: false,
    // iSmart 的会话是纯服务端会话（我们拿不到带 Expires 的凭证），
    // 本地无从判断是否过期 —— 所以每轮同步先探测一次：
    // 失效立刻识别，同时顺带续活（真机观察到约 2 小时后掉登录，
    // 与 web 会话的闲置超时形态高度吻合）。
    probeBeforeSync: true,
  };

  /**
   * 登录方式：cookie 导入（桌面）/ 账号密码（打通「一键同步」的自动重登）。
   * 密码协议来自登录页 JS 逆向：POST sso/v2/tickets-v3，
   * password = md5(md5(原文) + SMART_PASSWORD_SALT)。若平台要求图形验证码，
   * 会返回 CAPTCHA_REQUIRED，届时改用 cookie 导入或在应用内登录。
   */
  // 登录方式：只呈现「应用内登录（WebView）+ 粘贴 Cookie」。
  // 账号密码登录的协议已完整逆向（见 login() 与 SMART_PASSWORD_SALT），
  // 但真机验证到最后一环：school.ismartlearning.cn 的会话无法用 sso 下发的
  // CASTGC（cookie 与 Bearer 两种形态都试过）建立 —— 它只能由真实浏览器
  // 环境的跳转交互种下。所以密码登录在 UI 上不提供，避免用户走死路；
  // 会话失效时请在应用内重新登录一次。
  /**
   * 登录方式：只有「应用内登录」。
   *
   * 账号密码登录的协议已完整逆向，但真机验证到最后一环：
   * school.ismartlearning.cn 的会话无法用 sso 下发的 CASTGC
   * （cookie 与 Bearer 两种形态都试过）建立 —— 只能由真实浏览器
   * 的跳转交互种下。所以 UI 上不提供密码登录，避免用户走死路。
   *
   * 用 getter 是因为登录页地址来自实例配置（#webBase）。
   *
   * ⚠️ 注意：这里的登录会在平台侧**新建一个会话**。若平台是单会话策略，
   * 可能使 iSmart 官方 App 的登录失效（真机观察到过）。介意的话，
   * 让官方 App 保持登录就好，本应用会话失效时再登一次。
   */
  get authMethods(): AuthMethod[] {
    return [
      {
        id: 'in-app',
        label: '应用内登录',
        kind: 'in-app',
        fields: [],
        // 登录入口走 SSO 而不是登录页：总票据还在时它会**直接放行**
        // （浏览器里就是这个行为），用户不用输账号密码，通常连验证码都不用。
        // 总票据过期时它同样会落到登录页，所以严格优于直接打开登录页。
        loginUrl: `${this.#ep.ssoBase}${this.#ep.ssoLoginEntry}?service=${encodeURIComponent(`${this.#ep.base}/`)}`,
        hint:
          '会打开 iSmart 的单点登录入口。若你近期登录过，它通常会**直接放行**（不用输账号密码）；' +
          '凭据过期时才需要重新输入 —— cookie 由系统保管，本应用读不到也存不了。' +
          '提示：这里登录会在平台侧新建会话，若 iSmart 官方 App 需要保持登录，请留意它是否会掉线。',
      },
    ];
  }

  readonly maturity = 'experimental' as const;


  /**
   * 会话失效时最可能的原因，**按可能性从高到低**。
   *
   * 顺序是有事实依据的（2026-10-12/13 两夜对照取证）：
   * 有网的那一夜会话活了 22.8 小时；没网的那一夜，探针连续 5.5 小时「未测成」之后必掉。
   * iSmart 的会话是**服务端会话**（Tomcat SESSION），闲置约 2 小时就被作废 ——
   * 但它只是**结果**，主因是本机深夜没能联网。
   * 以前那句「可能是异地登录，或你在别处退出了」把罕见原因放最前，
   * 会让人以为账号被盗、跑去改密码 —— 归因顺序错，用户下一步做的事就全错。
   */
  readonly sessionExpiryCauses = [
    // 排在第一位是**有证据**的（2026-10-12/13 两夜对照）：
    // 有网的那一夜会话活了 22.8 小时；没网的那一夜，探针连续 5.5 小时「未测成」之后必掉。
    // 所以主因是"本机没网"，而"闲置超时"只是它的结果 —— 不拆开说，
    // 用户会去怀疑账号或平台，下一步做的事就全错。
    '手机在深睡时没给本应用联网（见「账号」页后台保活里的「未测成」）——会话在那段空档里闲置作废，不是账号问题',
    'SSO 总票据也过期了，自动续登因此走不通',
    '你在别处登录或主动退出了',
  ];

  /**
   * 定时探活声明（原生侧按此在后台发一个只读请求）。
   *
   * 为什么 iSmart 需要它，而雨课堂不需要：
   * 雨课堂下发的是自包含 JWT，服务端不维护会话 —— 根本不存在"闲置超时"这一层；
   * iSmart 是服务端会话，闲置就掉。定时打一个最便宜的探活请求，既能**测量**
   * 「凭据到底能活多久」，也顺带把闲置计时续上（减少掉线本身）。
   *
   * 用 currentuser 而不是课程/作业接口：一次探测只发 1 个请求，
   * 绝不能为了探活去拉业务数据（那会让请求量翻倍）。
   */
  get keepAliveProbe() {
    return {
      url: `${this.#ep.base}${this.#ep.currentUser}`,
      method: 'POST' as const,
      // 30 分钟：一天 48 个只读请求，比用户自己刷两下网页还轻。
      // 会话闲置阈值约 2 小时，间隔取 1/4 阈值，深度省电下被推迟也仍有余量。
      intervalMs: 30 * 60 * 1000,
      // 会话有效时接口回 { ..., "uid": ... }；失效时返回 HTML 登录页，匹配不上
      alivePattern: '"uid"\\s*:',
    };
  }

  /**
   * 这三个查询 POST + SSO 登录 POST + 换票 POST，逐条放行。
   * 注意不要用 $ 锚点（URL 可能带查询串）。
   *
   * 换票为什么也算只读：它只是把「我是谁」换成一张访问票据，
   * 不改变平台上的任何数据 —— 性质和登录一样。
   */
  readonly readOnlyPolicy: ReadOnlyPolicy = {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [
      { pattern: /\/client\/user\/currentuser/, why: '会话探测（只读）' },
      { pattern: /\/client\/course\/list-of-student/, why: '查询课程列表（只读）' },
      { pattern: /\/client\/homework\/tests\/list-of-student/, why: '查询作业列表（只读）' },
      { pattern: /\/v2\/tickets-v3/, why: '账号密码登录（SSO）' },
      { pattern: /\/front\/authlog\/check/, why: '登录后会话自检（只读）' },
      { pattern: /\/v1\/serviceTicket/, why: '用 SSO 总票据换访问票据（只读）' },
    ],
  };

  constructor(opts: SmartAdapterOptions = {}) {
    this.#base = (opts.baseUrl ?? SmartEndpoints.base).replace(/\/$/, '');
    this.#webBase = opts.endpoints?.webBase ?? SmartEndpoints.webBase;
    this.#ep = { ...SmartEndpoints, ...opts.endpoints };
  }

  // ---------------------------------------------------------------- 会话探测

  async probeSession(ctx: AdapterContext, session: Session): Promise<boolean> {
    const http = new SessionHttpClient(ctx, session);
    try {
      const res = await this.#post(http, this.#ep.currentUser, {});
      return res.code === 0 && typeof (res.data as { uid?: unknown } | undefined)?.uid !== 'undefined';
    } catch (e) {
      // 探测的目的只有一个：会话还能不能用。所以**任何**"需要重新登录"的形态
      // 都应该回答"不能用"，而不是往外抛 —— 否则调用方会以为"探测本身坏了"。
      //
      // 真机踩过：会话失效时这个接口直接返回**HTML 登录页**（不是 JSON），
      // 解析层把它抛成 CAPTCHA_REQUIRED（"疑似返回登录/验证页面"）。原来只吞
      // AUTH_REQUIRED，于是这个错误一路冒泡，把上层"自动接回会话"的机会直接掐掉了。
      if (
        e instanceof HubError &&
        (e.code === 'AUTH_REQUIRED' || e.code === 'AUTH_FAILED' || e.code === 'CAPTCHA_REQUIRED')
      ) {
        return false;
      }
      throw e;
    }
  }

  /**
   * 会话失效时**自动把它接回来**。
   *
   * 原理（真机实测确认）：iSmart 掉登录时，本机的会话 cookie 和 SSO 总票据（CASTGC）
   * 都还在 —— 是服务端把那一层会话作废了。而总票据还在，浏览器就会静默重走一遍换票：
   *
   *   GET sso/login?service=<本域地址>   ← 带着总票据
   *     → 302 回本域并附上服务票据（ticket=ST-…）
   *     → 本域校验票据后下发新的会话 cookie
   *
   * 关键是这条链**在原生桥里就能走完**：桥是逐跳处理重定向的，
   * 并且把每一跳的 Set-Cookie 都写回 CookieManager
   * （当初就是为了防「登录 → 302 → 主页才下发会话」这种链路丢会话而写的）。
   * 所以这里只要发一个 GET，会话就回来了 —— 不需要打开网页、不需要用户做任何事。
   *
  /**
   * 总票据也过期时会停在登录页，此时返回失败并由界面引导手动登录。
   *
   * ── 失败时必须留下「断在哪一环」（2026-10-09 补）──
   * 只说「自动续登未成功」是不够的：这条路断掉有两种截然相反的原因，
   * 而它们的下一步完全相反 ——
   *   · 换票被退回登录页 = 总票据在服务端失效 → 平台策略，App 侧没有可修入口；
   *   · 票换到手了但本域仍不认 = 这条路自身是坏的 → 值得继续修。
   * 所以这里把换票那一跳的**响应指纹**记下来（最终落到哪个域、什么状态码），
   * 由它给出 diagnosis。响应本来就在手上，只是以前拿到就丢了。
   */
  async recoverSession(
    ctx: AdapterContext,
    session: Session,
  ): Promise<{
    recovered: boolean;
    note?: string;
    diagnosis?: 'recovered' | 'ticket-expired' | 'mechanism' | 'channel';
  }> {
    // 换票那一跳的响应指纹。用「最终 URL 落在哪个域」做判据 ——
    // 原生桥只回传 status 与跟随重定向后的最终 URL（Set-Cookie 刻意不回传 JS），
    // 而这两者已经足够区分「票换到了」和「被退回登录页」。
    let status = 0;
    let finalUrl = '';
    let body = '';
    try {
      const http = new SessionHttpClient(ctx, session);
      const res = await http.request({
        // service 必须是本域地址，且要和浏览器里用的一致 ——
        // 换别的值（例如登录页地址）服务端会拒绝生成票据（实测 code=-25「生成st失败」）。
        url: `${this.#ep.ssoBase}${this.#ep.ssoLoginEntry}?service=${encodeURIComponent(`${this.#ep.base}/`)}`,
        method: 'GET',
      });
      status = res.status;
      finalUrl = res.url;
      body = await res.text().catch(() => '');
    } catch (e) {
      return {
        recovered: false,
        diagnosis: 'channel',
        note: `自动续登未成功：换票请求本身没发成（网络或请求通道问题）—— ${(e as Error).message.slice(0, 100)}`,
      };
    }

    const alive = await this.probeSession(ctx, session);
    if (alive) return { recovered: true, diagnosis: 'recovered' };

    const schoolHost = hostOf(this.#ep.base);
    const ssoHost = hostOf(this.#ep.ssoBase);
    const finalHost = hostOf(finalUrl);
    // 回到本域 = 服务端确实下发了服务票据（换票成功）
    const landedOnService = finalHost !== '' && finalHost === schoolHost;
    // 停在 SSO 域 = 没有下发票据，被退回登录页
    const landedOnSso = finalHost !== '' && finalHost === ssoHost;
    // 兜底证据：响应体里出现登录表单/验证码字样
    const looksLoginPage = /type=["']?password|验证码|captcha|请输入账号/i.test(body.slice(0, 4000));

    if (landedOnService) {
      return {
        recovered: false,
        diagnosis: 'mechanism',
        note:
          `自动续登未成功：换票这一步是成功的（已跳回 ${schoolHost} 并下发新票据），` +
          '但本域会话仍不被接受 —— 这是自动接回这条路径自身的问题，不是总票据过期，值得继续修',
      };
    }
    if (landedOnSso || looksLoginPage) {
      return {
        recovered: false,
        diagnosis: 'ticket-expired',
        note:
          '自动续登未成功：换票被退回登录页 —— SSO 总票据已在服务端失效（本机 cookie 还在也没用）。' +
          '这是 iSmart 自己的登录有效期策略，App 无法把它延长，重新登录一次即可',
      };
    }
    return {
      recovered: false,
      diagnosis: 'channel',
      note: `自动续登未成功：换票请求落到了意料之外的地址（HTTP ${status} → ${finalUrl.slice(0, 80)}）`,
    };
  }

  // ---------------------------------------------------------------- 登录

  async login(ctx: AdapterContext, cred: Credentials): Promise<Session> {
    const issuedAt = ctx.clock.now().toISOString();

    if (!cred.cookie && (!cred.username || !cred.password)) {
      throw new HubError('AUTH_FAILED', '需要账号和密码（或粘贴 Cookie）', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    if (cred.cookie) {
      const session: Session = {
        platformId: this.id,
        accountId: '',
        origin: 'imported',
        cookies: parseCookieString(cred.cookie),
        headers: {
          Referer: `${this.#webBase}/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        issuedAt,
      };
      if (Object.keys(session.cookies).length === 0) {
        throw new HubError('AUTH_FAILED', '未能从输入中解析出任何 Cookie', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      return session;
    }

    // ---- 账号密码登录（协议来自登录页 JS，见 SMART_PASSWORD_SALT 注释） ----
    // 验证码流程：SSO 强制要求图形验证码，且图片与会话 cookie 绑定 ——
    // 所以第一次不带 captcha 的调用先取验证码图，把「已绑定 cookie 的会话」
    // 暂存在内存里，抛 CAPTCHA_REQUIRED（携带 data URL 图片）；
    // 用户填完验证码再调一次 login（带 captcha），复用同一个会话完成登录。
    let session: Session;
    if (cred.captcha) {
      const pending = pendingCaptchaSessions.get(cred.username ?? '');
      if (!pending) {
        throw new HubError('CAPTCHA_REQUIRED', '验证码会话已过期，请重新提交一次登录', {
          platformId: this.id,
          requiresUserAction: true,
        });
      }
      session = pending;
    } else {
      session = {
        platformId: this.id,
        accountId: '',
        cookies: {},
        headers: {
          Referer: `${this.#webBase}/front/login.html`,
          Origin: this.#webBase,
          'X-Requested-With': 'XMLHttpRequest',
        },
        issuedAt,
      };
    }
    const http = new SessionHttpClient(ctx, session);

    if (!cred.captcha) {
      // 取验证码图（GET 会种下与会话绑定的 kaptcha cookie）
      const img = await http.request({
        url: `${this.#ep.ssoBase}${this.#ep.captcha}?aaa=${Math.floor(Math.random() * 100)}`,
        method: 'GET',
      });
      const bytes = await img.bytes();
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
      const dataUrl = `data:image/jpeg;base64,${btoa(bin)}`;
      pendingCaptchaSessions.set(cred.username ?? '', session);
      throw new HubError('CAPTCHA_REQUIRED', 'iSmart 要求图形验证码，请输入图片中的字符', {
        platformId: this.id,
        requiresUserAction: true,
        details: { captchaImage: dataUrl },
      });
    }

    // password = md5(md5(原文) + 盐)，与登录页 hex_md5(hex_md5(...) + salt) 一致
    const password = md5(md5(cred.password as string) + SMART_PASSWORD_SALT);
    const res = await http.postForm<{
      result?: { code?: number; msg?: string };
      data?: unknown;
    }>(`${this.#ep.ssoBase}${this.#ep.ssoLogin}`, {
      username: cred.username ?? '',
      password,
      captcha: cred.captcha,
    });

    const code = res.body?.result?.code ?? -1;
    const msg = res.body?.result?.msg ?? `code=${code}`;

    // 验证码错误 → 换新图重填
    const needCaptcha = /验证码|captcha/i.test(msg) || code === -41 || code === -42;
    if (needCaptcha) {
      pendingCaptchaSessions.set(cred.username ?? '', session);
      let dataUrl = '';
      try {
        const img = await http.request({
          url: `${this.#ep.ssoBase}${this.#ep.captcha}?aaa=${Math.floor(Math.random() * 100)}`,
          method: 'GET',
        });
        const bytes = await img.bytes();
        let bin = '';
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
        dataUrl = `data:image/jpeg;base64,${btoa(bin)}`;
      } catch {
        // 取图失败也要抛，否则 UI 没有下一步
      }
      throw new HubError('CAPTCHA_REQUIRED', `验证码不对（${msg}），请输入新图中的字符`, {
        platformId: this.id,
        requiresUserAction: true,
        details: dataUrl ? { captchaImage: dataUrl } : undefined,
      });
    }

    // SSO 的成功态不可靠：真机观测到「生成 Tgt成功」时 code 并不是 0。
    // 页面 JS 的策略也是「返回即跳转」，最终真伪交给 cookie + 接口域探测裁决。
    // 所以这里只拦截明确的失败（如「用户名密码错误」），其余放行进入探测。
    if (code !== 0 && !/成功/.test(msg)) {
      throw new HubError('AUTH_FAILED', `iSmart 登录失败：${msg}`, {
        platformId: this.id,
        requiresUserAction: true,
      });
    }

    // 登录成功：清掉暂存会话
    pendingCaptchaSessions.delete(cred.username ?? '');

    // 复刻浏览器的「会话接力」：TGT 只是 sso 域的票据，浏览器拿到它之后
    // 会跳转到个人中心页并做一次登录态自检（front/authlog/check），
    // 过程中各级 Set-Cookie 才最终落位。照原样走一遍，每一步的
    // Set-Cookie 都进了 CookieManager / 会话，最后由探测裁决真伪。
    try {
      await http.request({ url: `${this.#webBase}/center/student/index.html`, method: 'GET' });
      await http.postForm(`${this.#base}/front/authlog/check`, {});
    } catch {
      // 接力失败不算定论 —— 让下面的探测说话
    }

    // 注意：不要用「session.cookies 是否为空」判断风控 ——
    // Android 上 cookie 由原生 CookieManager 保管（凭据不过手），JS 侧永远看不到。
    // 真伪由下面的接口域探测裁决：TGT 有效 → currentuser 返回 uid；无效 → 这里就拦下。
    const alive = await this.probeSession(ctx, session);
    if (!alive) {
      throw new HubError(
        'AUTH_REQUIRED',
        'iSmart 登录成功，但会话未通过接口域校验（SSO cookie 可能未覆盖 school.ismartlearning.cn）。' +
          '请改用「在应用内登录」或粘贴 Cookie。',
        { platformId: this.id, requiresUserAction: true },
      );
    }

    return { ...session, origin: 'derived', displayName: cred.username };
  }

  // ---------------------------------------------------------------- 课程

  async fetchCourses(ctx: AdapterContext, session: Session, _req?: FetchCoursesRequest): Promise<Page<PlatformCourse>> {
    const http = new SessionHttpClient(ctx, session);
    const body = await this.#post(
      http,
      `${this.#ep.courseList}?status=1`,
      { 'pager.currentPage': 1, 'pager.pageSize': 100 },
    );
    const list = (body.data as { list?: unknown[] } | undefined)?.list;
    if (!Array.isArray(list)) {
      throw schemaDrift(this.id, `课程列表缺少 data.list（响应键：${Object.keys(body).join(',')}）`);
    }
    return {
      items: parseSmartCourses(list),
      hasMore: false,
      declaredTotal: list.length,
    };
  }

  // ---------------------------------------------------------------- 任务

  async fetchTasks(ctx: AdapterContext, session: Session, req: FetchTasksRequest): Promise<Page<PlatformTask>> {
    // 与学习通适配器同样的铁律：没有课程列表就响亮报错，
    // 绝不能静默返回空 —— 否则「课程拉取失败」会被伪装成「没有作业」。
    if (!req.courses || req.courses.length === 0) {
      throw new HubError('UPSTREAM', '缺少课程列表，无法拉取作业（课程缓存可能为空）', {
        platformId: this.id,
      });
    }
    const http = new SessionHttpClient(ctx, session);
    const items: PlatformTask[] = [];
    const failures: string[] = [];

    for (const course of req.courses ?? []) {
      // testStatus 0=进行中的作业，1=已结束的作业 —— 两页都要，「已完成」栏目才完整
      for (const testStatus of [0, 1] as const) {
        try {
          const body = await this.#post(http, this.#ep.homeworkTests, {
            courseId: course.platformCourseId,
            testStatus,
            'pager.currentPage': 1,
            'pager.pageSize': 100,
          });
          const list = (body.data as { list?: unknown[] } | undefined)?.list;
          if (!Array.isArray(list)) {
            throw schemaDrift(this.id, `作业列表缺少 data.list（响应键：${Object.keys(body).join(',')}）`);
          }
          items.push(...parseSmartTests(list, course.platformCourseId, course.name));
        } catch (e) {
          failures.push(`${course.name}/testStatus=${testStatus}: ${(e as Error).message}`);
        }
      }
    }

    if (items.length === 0 && failures.length > 0 && failures.length >= (req.courses?.length ?? 1)) {
      const authLike = failures.some((f) => /登录|会话|401|403/.test(f));
      throw new HubError(authLike ? 'AUTH_REQUIRED' : 'UPSTREAM', `iSmart 全部课程拉取失败：${failures.slice(0, 3).join('；')}`, {
        platformId: this.id,
        requiresUserAction: authLike,
      });
    }

    return { items, hasMore: false };
  }

  /** 统一 POST 表单 + 应答解包。iSmart 的失败形态：HTML（登录墙/404）或 result.code !== 0。 */
  async #post(http: SessionHttpClient, path: string, form: Record<string, string | number | boolean | undefined>): Promise<{
    code: number;
    data: unknown;
    raw: Record<string, unknown>;
  }> {
    const res = await http.postForm<Record<string, unknown>>(`${this.#base}${path}`, form);
    const text = res.status >= 400 ? '' : JSON.stringify(res.body ?? {});
    if (looksLikeAuthWall(text) || res.status === 401 || res.status === 403) {
      throw new HubError('AUTH_REQUIRED', 'iSmart 返回登录页/拒绝访问，会话已失效', {
        platformId: this.id,
        requiresUserAction: true,
      });
    }
    const body = (res.body ?? {}) as { result?: { code?: number; msg?: string }; data?: unknown };
    const code = body.result?.code ?? -1;
    if (code !== 0) {
      throw new HubError('UPSTREAM', `iSmart 接口返回 code=${code}：${body.result?.msg ?? '无信息'}`, {
        platformId: this.id,
      });
    }
    return { code, data: body.data, raw: body };
  }

  buildTaskUrl(courseId: string, _task: PlatformTask): string | undefined {
    // 作业列表页（测验 tab），从 HAR 里的真实 URL 形态取的
    return `${this.#webBase}/center/student/course/tests.html?courseId=${encodeURIComponent(courseId)}&status=1`;
  }
}

// ---------------------------------------------------------------- 纯解析（可单测）

/** 解析课程列表 data.list（字段名来自抓包：courseId/courseName/teacherName）。 */
export function parseSmartCourses(list: unknown[]): PlatformCourse[] {
  const out: PlatformCourse[] = [];
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = r.courseId;
    const name = r.courseName;
    if (id === undefined || !name) continue;
    out.push({
      platformCourseId: String(id),
      name: String(name).trim(),
      teacher: typeof r.teacherName === 'string' ? r.teacherName : undefined,
      raw: r,
    });
  }
  return out;
}

/** 解析作业条目（字段名来自抓包：test_id/test_name/stustatus/testStatus/end_time 等）。 */
export function parseSmartTests(list: unknown[], courseId: string, courseName: string): PlatformTask[] {
  const out: PlatformTask[] = [];
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const title = r.test_name;
    if (typeof title !== 'string' || !title.trim()) continue;

    // stustatus：0=未做；3=已完成（抓包观测值）。testStatus：0=进行中，1=已结束。
    // 已结束 + 未做 = 错过了 → expired。
    const stustatus = Number(r.stustatus ?? 0);
    const testStatus = Number(r.testStatus ?? 0);
    let status: TaskStatus;
    if (stustatus >= 3) status = 'submitted';
    else if (testStatus === 1) status = 'expired';
    else status = 'pending';

    // 抓包里 end_time / begin_time 都是 epoch 毫秒
    const endMs = Number(r.end_time);
    const deadline = Number.isFinite(endMs) && endMs > 0 ? new Date(endMs).toISOString() : undefined;
    const publishMs = Number(r.publish_time ?? r.begin_time);

    out.push({
      platformTaskId: r.test_id !== undefined ? String(r.test_id) : undefined,
      courseId,
      courseName,
      kind: Number(r.test_type) === 2 ? 'quiz' : 'homework',
      title: title.trim(),
      status,
      deadline,
      publishedAt: Number.isFinite(publishMs) && publishMs > 0 ? new Date(publishMs).toISOString() : undefined,
      score: toNumber(r.score),
      raw: r,
    });
  }
  return out;
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseCookieString(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 取 URL 的 host（小写）。解析失败返回空串 —— 判据宁可"不知道"，也不要抛。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
