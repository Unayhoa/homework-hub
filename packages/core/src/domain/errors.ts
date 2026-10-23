/**
 * 错误分类。
 *
 * 这里的关键设计：同步引擎必须能区分「要我重新登录」和「平台挂了」。
 * 前者要弹登录框打断用户，后者应该静默重试、不打扰。
 * 如果只有一个 Error 类型，UI 层就只能显示「同步失败」，体验会非常糟。
 */

export type ErrorCode =
  | 'AUTH_REQUIRED' // 会话失效，必须用户重新登录
  | 'AUTH_FAILED' // 用户名密码/验证码错误
  | 'CAPTCHA_REQUIRED' // 触发验证码/滑块，需要人工介入
  | 'RATE_LIMITED' // 被限流/风控，应该退避
  | 'NETWORK' // 网络层错误，可重试
  | 'UPSTREAM' // 平台返回 5xx 或结构异常
  | 'SCHEMA_DRIFT' // 平台改版，解析器读不到预期字段（最危险的一种）
  | 'SIGNER_UNAVAILABLE' // 依赖 native 签名能力但不可用
  | 'WRITE_BLOCKED' // 只读守卫拦截了一个可能改变服务端状态的请求
  | 'CAPTURE_MISS' // 回放文件里没有这条请求（需要用户重新录制）
  | 'NOT_SUPPORTED'
  | 'UNKNOWN';

export class HubError extends Error {
  readonly code: ErrorCode;
  readonly platformId?: string;
  /** 是否值得重试（幂等且非用户侧问题） */
  readonly retryable: boolean;
  /** 是否必须打断用户 */
  readonly requiresUserAction: boolean;
  readonly cause?: unknown;
  /** 自由扩展位：如 CAPTCHA_REQUIRED 携带的验证码图片（data URL） */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      platformId?: string;
      retryable?: boolean;
      requiresUserAction?: boolean;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.platformId = opts.platformId;
    this.retryable = opts.retryable ?? false;
    this.requiresUserAction = opts.requiresUserAction ?? false;
    this.cause = opts.cause;
    this.details = opts.details;
  }
}

export const authRequired = (platformId: string, detail = '会话已失效') =>
  new HubError('AUTH_REQUIRED', `${platformId} 需要重新登录：${detail}`, {
    platformId,
    requiresUserAction: true,
  });

export const rateLimited = (platformId: string, retryAfterMs?: number) => {
  const err = new HubError('RATE_LIMITED', `${platformId} 触发限流`, {
    platformId,
    retryable: true,
  });
  return Object.assign(err, { retryAfterMs });
};

export const netError = (platformId: string, cause: unknown) =>
  new HubError('NETWORK', `${platformId} 网络请求失败：${describe(cause)}`, {
    platformId,
    retryable: true,
    cause,
  });

export const upstreamError = (platformId: string, detail: string, cause?: unknown) =>
  new HubError('UPSTREAM', `${platformId} 上游异常：${detail}`, {
    platformId,
    retryable: true,
    cause,
  });

/**
 * Schema drift 是本项目最需要防守的一类失败。
 * 平台的 HTML/JSON 一改版，解析器就可能「成功地」返回 0 条记录 ——
 * 从代码角度没报错，从用户角度是「我作业不见了」。
 * 所以适配器返回空结果但上游声明有数据时，必须显式抛这个错。
 */
export const schemaDrift = (platformId: string, detail: string) =>
  new HubError('SCHEMA_DRIFT', `${platformId} 页面/接口结构可能已改版：${detail}`, {
    platformId,
    requiresUserAction: true,
  });

export const signerUnavailable = (platformId: string, detail: string) =>
  new HubError('SIGNER_UNAVAILABLE', `${platformId} 缺少签名组件：${detail}`, {
    platformId,
    requiresUserAction: true,
  });

/**
 * 只读守卫拦截。
 *
 * 这个错误不是「出了故障」，而是「守卫按设计拦下了一个不该发生的请求」。
 * 所以它必须响亮：说明是哪个方法/路径被拦，否则适配器作者会以为是网络问题。
 */
export const writeBlocked = (platformId: string, method: string, url: string, reason: string) =>
  new HubError(
    'WRITE_BLOCKED',
    `${platformId} 只读守卫拦截了 ${method} ${url}：${reason}。` +
      '若这是查询类请求，请在适配器的 readOnlyPolicy.allowPost 中显式声明。',
    { platformId, requiresUserAction: true },
  );

export function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function toHubError(e: unknown, platformId: string): HubError {
  if (e instanceof HubError) return e;
  return new HubError('UNKNOWN', `${platformId} 未知错误：${describe(e)}`, {
    platformId,
    cause: e,
  });
}
