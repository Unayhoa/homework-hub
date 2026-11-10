/**
 * 超星只读查询能力测试（临时工具，优化方案敲定后删除）。
 *
 * 【为什么要它】
 * 项目里长期流传「超星风控对并发/请求量很敏感」这条结论，但 2026-11-10 核查发现
 * 它**没有任何实测支撑** —— 那是推断，却被当成事实用来否决提速方案。
 * 这个模块就是为了把推断换成数据：用真实的只读请求做阶梯实验，测出到底在
 * 哪一档开始被拦。
 *
 * 【为什么单独一个文件】
 * 它是一次性实验代码，不该混进适配器的正常逻辑里。删的时候整文件删掉即可，
 * 不影响任何生产路径。
 *
 * 【安全边界】
 *   · 只发 GET（只读），只打列表页这种最便宜的接口；
 *   · 每档之间强制冷却，避免累积触发；
 *   · 任何一档失败立刻停止，不会继续加码；
 *   · 结果只回传展示，**不写入任何正式配置**。
 */

export interface LimitTestStep {
  /** 这一档的速率（每秒请求数） */
  rps: number;
  /** 并发数（同时几个在飞） */
  concurrency: number;
  /** 总请求数 */
  total: number;
}

export interface LimitTestResult {
  rps: number;
  concurrency: number;
  requests: number;
  okCount: number;
  failCount: number;
  durationMs: number;
  /** 实际达到的速率（requests / durationMs） */
  actualRps: number;
  /** 状态码分布，如 {200: 20, 403: 3} */
  statusCounts: Record<string, number>;
  /** 判定为「被拦」的样本（最多 3 条，含判据与首段） */
  blockedSamples: string[];
  /** 是否通过（无任何拦截信号） */
  passed: boolean;
}

/** 判定一次响应是否算「被平台拦住」。 */
export interface BlockVerdict {
  blocked: boolean;
  /** 命中的判据，便于用户/我判断是真拦截还是别的问题 */
  reason?: string;
}

/**
 * 判定响应是否被拦。
 *
 * 只看 403 不够 —— 超星有很多"软拒绝"形态（200 但正文是错误页）。
 * 这里把已知的几种都算进去，宁可判严一点（测试目的是找安全上限）。
 */
export function judgeResponse(status: number, body: string): BlockVerdict {
  if (status === 403) return { blocked: true, reason: 'HTTP 403' };
  if (status === 429) return { blocked: true, reason: 'HTTP 429（限流）' };
  if (status >= 500) return { blocked: true, reason: `HTTP ${status}（服务端异常）` };
  const head = body.slice(0, 2000);
  if (/无效的用户/.test(head)) return { blocked: true, reason: '正文「无效的用户」' };
  if (/验证码|captcha|滑动验证|安全验证/i.test(head)) return { blocked: true, reason: '正文含验证码' };
  if (/请重新登录|重新登录|未登录/.test(head)) return { blocked: true, reason: '正文「请重新登录」' };
  // 列表页特征：真实作业/考试列表一定含 goTask / goTest / overHidden2 之一。
  // 三者都没有 = 拿到的不是列表页（多半是错误页或空壳）。
  const looksList = /goTask|goTest|overHidden2|bottomList/i.test(head);
  if (!looksList && body.length > 0) {
    return { blocked: true, reason: `正文不含列表特征（len=${body.length}）` };
  }
  if (body.length > 0 && body.length < 2000) {
    return { blocked: true, reason: `响应过短（len=${body.length}，正常列表页 19KB+）` };
  }
  return { blocked: false };
}

/**
 * 执行一档测试。
 *
 * 用「令牌桶 + 并发池」模拟目标速率：不追求精确压满，只要能稳定打到目标 rps
 * 并观察平台反应即可 —— 测的是平台容忍度，不是压测工具的性能。
 */
export async function runLimitTestStep(
  step: LimitTestStep,
  fetchOne: () => Promise<{ status: number; body: string }>,
  opts: { cooldownMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<LimitTestResult> {
  const startedAt = Date.now();
  const statusCounts: Record<string, number> = {};
  const blockedSamples: string[] = [];
  let okCount = 0;
  let failCount = 0;
  let done = 0;
  let stopped = false;

  const intervalMs = step.rps > 0 ? 1000 / step.rps : 0;

  // 并发池：concurrency 个 worker 轮流取任务，彼此间隔 intervalMs
  const worker = async () => {
    while (!stopped && done < step.total) {
      done += 1;
      const idx = done;
      try {
        const res = await fetchOne();
        statusCounts[String(res.status)] = (statusCounts[String(res.status)] ?? 0) + 1;
        const v = judgeResponse(res.status, res.body);
        if (v.blocked) {
          failCount += 1;
          if (blockedSamples.length < 3) {
            blockedSamples.push(
              `#${idx} ${v.reason}｜首段=${res.body.replace(/\s+/g, ' ').slice(0, 90)}`,
            );
          }
          // 一旦被拦，立刻停止这一档 —— 继续加码只会让平台更警惕
          stopped = true;
          return;
        }
        okCount += 1;
      } catch (e) {
        failCount += 1;
        if (blockedSamples.length < 3) {
          blockedSamples.push(`#${idx} 请求异常：${String((e as Error).message ?? e).slice(0, 80)}`);
        }
        stopped = true;
        return;
      }
      opts.onProgress?.(done, step.total);
      if (intervalMs > 0 && done < step.total) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, step.concurrency) }, () => worker()));

  const durationMs = Math.max(1, Date.now() - startedAt);
  if (opts.cooldownMs && opts.cooldownMs > 0) {
    await new Promise((r) => setTimeout(r, opts.cooldownMs));
  }

  return {
    rps: step.rps,
    concurrency: step.concurrency,
    requests: done,
    okCount,
    failCount,
    durationMs,
    actualRps: Math.round((done / durationMs) * 1000 * 10) / 10,
    statusCounts,
    blockedSamples,
    passed: failCount === 0,
  };
}
