/**
 * 只读守卫。
 *
 * ─────────────────────────────────────────────────────────────
 * 这个文件的唯一目的：让「我们不会影响你正常使用这些平台」
 * 从一句宣传语，变成一条**运行时强制、可被审计、能被测试断言**的约束。
 *
 * 为什么需要它，而不是靠「适配器作者自觉」：
 *
 *   1. 「读取」和「有副作用的读取」在 HTTP 层面长得一模一样。
 *      很多接口都是 POST 查询，光看方法分不出来。
 *      更隐蔽的是：某些看起来纯查询的接口其实会打点 ——
 *      进入课程页会记录学习时长、拉取题目会写"已开始答题"、
 *      打开通知会写已读回执。这些一旦被调用，用户的学习行为数据就被污染了。
 *
 *   2. 平台在持续改版。今天安全的路径，明天可能被复用成提交接口。
 *      靠人工记忆不可能跟上。
 *
 *   3. 这个承诺是要写给用户看的。既然是承诺，就必须有强制点，
 *      而不是散落在几十个适配器里的 if。
 *
 * 三条规则，从宽松到严格：
 *   Rule 1  方法白名单：默认只允许 GET / HEAD。
 *   Rule 2  显式放行：任何非安全方法都必须在适配器的 readOnlyPolicy.allowPost
 *           里逐条列出。这份清单本身就是可审计的 ——
 *           想知道这个 app 一共会发多少个"写请求"？读这份清单即可。
 *   Rule 3  兜底黑名单：即使有人误把提交类路径写进了白名单，
 *           也会被 forbid 模式拦下（双保险，防止一处配置失误破坏整个承诺）。
 * ─────────────────────────────────────────────────────────────
 */
import type { HttpClient, HttpRequest, HttpResponse, RequestMeta } from '../ports/http.ts';
import type { Logger } from '../ports/logger.ts';
import type { ReadOnlyGuardStats, ReadOnlyPolicy } from '../ports/read-only.ts';
import { createReadOnlyGuardStats } from '../ports/read-only.ts';
import { writeBlocked } from '../domain/errors.ts';

export type { ReadOnlyPolicy, ReadOnlyGuardStats };
export { createReadOnlyGuardStats };

/**
 * 默认黑名单：覆盖「会改变服务端状态」的常见路径特征。
 *
 * 注意这里刻意包含了一些看起来人畜无害的路径：
 *   markread / read-receipt  → 已读回执，会改变通知状态
 *   study-record / watch-log → 学习时长上报，会污染用户的学习数据
 *   这些才是最容易被忽视、又最需要避免的。
 */
export const DEFAULT_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  // 作业 / 考试：提交、保存、交卷
  /\/(submit|commit|save|answer|answers|handin|hand-in|turnin|finish|endtest)\b/i,
  // 签到 / 打卡 / 出勤
  /\/(sign-?in|signin|check-?in|checkin|qiandao|attendance|rollcall)\b/i,
  // 增删改
  /\/(delete|remove|destroy|update|edit|modify|create|add)\b/i,
  // 上传 / 导入
  /\/(upload|import)\b/i,
  // 已读回执 / 通知状态
  /(mark-?read|markread|read-?receipt|notice-?read|set-?read)\b/i,
  // 学习行为打点：这些会让平台记录"你在学"，绝不能碰
  /(study-?record|watch-?log|heartbeat|progress-?report|log-?study|play-?log)\b/i,
  // 退出登录（会把用户自己的会话也干掉）
  /\/(logout|signout|sign-?out|exit-?login)\b/i,
];

/** 动作被写进 query 的情况：?action=submit、?cmd=handin、?do=qiandao */
const DEFAULT_FORBIDDEN_QUERY =
  /[?&](action|cmd|do|op|method)=([^&]*(submit|handin|commit|save|qiandao|checkin|signin|logout|delete)[^&]*)/i;

export interface ReadOnlyGuardOptions {
  platformId: string;
  policy?: ReadOnlyPolicy;
  logger?: Logger;
  stats?: ReadOnlyGuardStats;
}

function matches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
}

function methodOf(req: HttpRequest): string {
  return (req.method ?? 'GET').toUpperCase();
}

/**
 * 包装一个 HttpClient，使其只允许通过只读策略的请求。
 *
 * 放在 HTTP 层而不是适配器里的原因：包在传输层上，
 * 适配器**没有办法绕过**。任何新增的适配器、任何未来的代码改动，
 * 都自动受这条约束管辖。
 */
export function createReadOnlyHttpClient(base: HttpClient, opts: ReadOnlyGuardOptions): HttpClient {
  const allowMethods = new Set((opts.policy?.allowMethods ?? ['GET', 'HEAD']).map((m) => m.toUpperCase()));
  const allowPost = opts.policy?.allowPost ?? [];
  const forbid = [...(opts.policy?.forbid ?? []), ...DEFAULT_FORBIDDEN_PATTERNS];
  const stats = opts.stats ?? createReadOnlyGuardStats();
  const log = opts.logger?.child({ platformId: opts.platformId, layer: 'readonly-guard' });

  return {
    async request(req: HttpRequest, meta: RequestMeta): Promise<HttpResponse> {
      stats.checked += 1;

      const method = methodOf(req);
      const url = req.url;

      // Rule 3 先执行：兜底黑名单优先级最高，防止一处白名单配置失误
      // 就破坏了整个「只读」承诺。
      for (const p of forbid) {
        if (p.test(url)) {
          stats.blocked += 1;
          const detail = `${method} ${url} (命中禁止模式 ${p})`;
          stats.blockedDetails.push(detail);
          log?.warn('拦截请求：命中只读黑名单', { method, url, pattern: String(p) });
          throw writeBlocked(opts.platformId, method, url, `命中只读保护规则 ${p}`);
        }
      }
      if (DEFAULT_FORBIDDEN_QUERY.test(url)) {
        stats.blocked += 1;
        const detail = `${method} ${url} (query 中含动作参数)`;
        stats.blockedDetails.push(detail);
        log?.warn('拦截请求：URL 参数里带了动作', { method, url });
        throw writeBlocked(opts.platformId, method, url, 'URL 参数中包含动作类字段（如 action=submit）');
      }

      // Rule 1 方法白名单
      if (!allowMethods.has(method)) {
        // Rule 2 显式放行
        const hit = allowPost.find((entry) => matches(entry.pattern, url));
        if (!hit) {
          stats.blocked += 1;
          const detail = `${method} ${url} (未在 allowPost 中声明)`;
          stats.blockedDetails.push(detail);
          log?.warn('拦截请求：非安全方法未显式放行', { method, url });
          throw writeBlocked(
            opts.platformId,
            method,
            url,
            '非安全方法未在适配器的 readOnlyPolicy.allowPost 中声明',
          );
        }
        stats.allowedNonSafe += 1;
        log?.debug('放行非安全方法', { method, url, why: hit.why });
      }

      return base.request(req, meta);
    },
  };
}

/**
 * 给适配器的默认只读策略：只放行登录接口。
 *
 * 为什么登录也算「写」需要显式放行：登录会在服务端创建会话。
 * 把它放进白名单，是为了让「我们一共会发哪些非 GET 请求」这件事
 * 在一处可见 —— 读一遍每个适配器的 allowPost，就能审计完整个 app 的写操作面。
 */
export function authOnlyPolicy(loginPattern: string | RegExp, why: string): ReadOnlyPolicy {
  return {
    allowMethods: ['GET', 'HEAD'],
    allowPost: [{ pattern: loginPattern, why }],
  };
}
