/**
 * 会话模型与凭证保险箱端口。
 *
 * 会话为什么不是「一个 cookie 字符串」：
 * 各平台的登录态载体不一样 —— 超星是 JSESSIONID + _uid + _d，
 * 雨课堂是 JWT + csrf，iSmart 是 token + 某个 native 生成的 ut。
 * 所以 Session 设计成 cookies + headers + extra 三段式，适配器自己决定往哪塞。
 */

/**
 * 会话来源 —— 决定了「会话失效时我们能做什么」。
 *
 * 这是本项目的核心安全边界，不是可选的元信息：
 *
 *   imported  用户自己从浏览器/客户端里复制出来的会话。
 *             我们只是旁观者，**永远不用账号密码去重新登录**。
 *             因为「重新登录」这个动作本身就会新建一个会话 ——
 *             多数平台是单点登录或者会轮换 token，那会把用户正在用的
 *             那个客户端顶下线，或者在别的设备上弹出「新设备登录」提示。
 *             会话失效时正确做法是提示用户重新粘贴，而不是替他登录。
 *
 *   derived   我们用账号密码独立登录得到的会话。
 *             只应该在用户明确选择这种方式时使用，并且要告知他
 *             可能与官方客户端互踢。
 */
export type SessionOrigin = 'imported' | 'derived';

export interface Session {
  platformId: string;
  accountId: string;
  /**
   * 会话来源。默认 'derived'（保守：把「不主动续期」的责任交回给调用方，
   * 由适配器在解析用户粘贴的凭证时显式声明 'imported'）。
   */
  origin?: SessionOrigin;
  /** Cookie 字典 */
  cookies: Record<string, string>;
  /** 需要额外带的请求头，如 Authorization */
  headers: Record<string, string>;
  /** 平台侧用户标识，部分接口需要回传 */
  userId?: string;
  issuedAt: string;
  /** 无则视为不过期，靠 probeSession 探测 */
  expiresAt?: string;
  /** 适配器自定义状态：csrf token、二维码轮询 key 等 */
  extra?: Record<string, string>;
  /** 展示用：登录到的用户昵称/学号脱敏 */
  displayName?: string;
  /**
   * 登录凭据（仅账号密码登录且用户勾选「记住密码」时存在）。
   *
   * 用途只有一个：会话失效时**自动重新登录**（一键同步）。
   * 它与会话一起存进加密保险箱（AES-256-GCM），落盘即密文；
   * 粘贴 cookie / HAR / CDP 路线永远不会产生这个字段 ——
   * 那些路线没有密码，也就不存在「替用户登录」的可能。
   */
  credentials?: Credentials;
}

/**
 * 会话是否「用户自己带来的」。
 * 不确定时按 false 处理 —— 宁可多问一次用户，不要擅自替他登录。
 */
export function isImportedSession(session: Session): boolean {
  return session.origin === 'imported';
}

/**
 * 该会话失效时允许我们做什么。
 * 这是同步引擎唯一的判断依据，避免这条规则散落在各处被绕过。
 */
export function mayReauthenticate(session: Session): boolean {
  return !isImportedSession(session);
}

export interface Credentials {
  /** 与 AuthMethod.fields 对应 */
  [key: string]: string;
}

export interface Vault {
  /** 读取某账号的会话 */
  load(accountId: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  remove(accountId: string): Promise<void>;
  list(): Promise<string[]>;
}

/** 会话是否已过期（按 expiresAt 判断，不发起网络请求）。 */
export function isSessionExpired(session: Session, now: Date): boolean {
  if (!session.expiresAt) return false;
  const at = new Date(session.expiresAt).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

/** 会话剩余有效期，过期/无期限返回 null。 */
export function sessionTtlMs(session: Session, now: Date): number | null {
  if (!session.expiresAt) return null;
  const at = new Date(session.expiresAt).getTime();
  return Number.isFinite(at) ? at - now.getTime() : null;
}
