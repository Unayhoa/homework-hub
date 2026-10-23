/**
 * 只读策略契约。
 *
 * 放在 ports 层（而不是 engine）是因为它属于「契约」：
 * 适配器**声明**自己能发哪些非 GET 请求，engine **执行**这个约束。
 * 实现见 engine/read-only-guard.ts。
 *
 * 背景与设计理由见 read-only-guard.ts 顶部注释。
 */

export interface ReadOnlyPolicy {
  /**
   * 允许的 HTTP「安全方法」。默认 ['GET', 'HEAD']。
   * 一般不需要改 —— 如果你的平台连课程列表都只能用 POST，
   * 也应该用 allowPost 逐条放行，而不是在这里放开一整个方法。
   */
  allowMethods?: string[];
  /**
   * 允许的非安全方法与路径。必须逐条列出且写清用途。
   *
   * 这份清单是整个 app 的「写操作白名单」，也是给用户与审计者看的关键材料：
   * 想知道这个 app 一共会发多少个"写请求"？把各适配器的 allowPost 读一遍即可。
   */
  allowPost?: Array<{ pattern: string | RegExp; why: string }>;
  /**
   * 无条件拒绝的路径模式（兜底，双保险）。
   * 优先级高于 allowPost —— 即使有人误把提交类路径写进了白名单，也会被拦下。
   */
  forbid?: RegExp[];
}

export interface ReadOnlyGuardStats {
  /** 被检查的请求总数 */
  checked: number;
  /** 被放行的非安全方法数量（应该极小且每一条都可解释） */
  allowedNonSafe: number;
  /** 被拦截数量（正常运行时应该恒为 0） */
  blocked: number;
  /** 拦截明细，用于告警与排查 */
  blockedDetails: string[];
}

export function createReadOnlyGuardStats(): ReadOnlyGuardStats {
  return { checked: 0, allowedNonSafe: 0, blocked: 0, blockedDetails: [] };
}
