/**
 * 解析「AI 返回的接入结果」并落库。
 *
 * 为什么这里要**同时接受两种格式**：真实测试（2026-10-23，手机端 AI）表明，
 * 模型经常不按我们给的 schema 输出 —— 我们要的是「怎么读」（接口 + 字段映射），
 * 它给的是「读到了什么」（作业数组）。
 *
 * 与其反复强化提示词赌模型听话，不如两种都认：
 *   - 数据型（有 homeworkList / tasks 数组）→ 直接导入成手动作业，**立刻能用**
 *   - 配置型（有 tasks.url + fields）→ 存成适配器草稿，等 runner 支持
 *
 * 对普通用户来说，"能看到作业"才是目的；"能自动同步"是下一步。
 * 只认配置型的话，用户粘贴回来会看到一句"格式不对"，然后就没有然后了。
 */
import type { UnifiedTask } from '#core/domain/task.ts';

export interface ImportedHomework {
  title: string;
  deadline?: string;
  desc?: string;
  status?: string;
  homeworkId?: string;
}

export interface ParsedImport {
  kind: 'homework' | 'adapter';
  /** 数据型：识别出的作业（已归一化截止时间） */
  homework?: ImportedHomework[];
  courseName?: string;
  teacherName?: string;
  platformName?: string;
  /** 配置型：原样保留的草稿 */
  adapterDraft?: unknown;
  /** 给人看的说明，界面直接显示 */
  notes: string[];
  /** 识别失败时的原因（界面据此给用户可操作的建议） */
  error?: string;
}

/**
 * 修复 AI 常见的 JSON 破损。
 *
 * 真机实例（2026-10-23）：AI 在 note 里写 `响应体业务status为"200"且...`，
 * 字符串内部的裸双引号直接把 JSON 弄坏了 —— 用户看到的是"没有找到 JSON"。
 * 这类错误 AI 每天都在犯，不该让用户去手工转义。
 *
 * 做法：走一遍字符流，判断每个 `"` 是「字符串结束」还是「内容里的引号」。
 * 判据是它后面紧跟的字符：JSON 里字符串结束后面只可能是 `,` `}` `]` `:`。
 */
export function repairJson(s: string): string {
  const src = s.replace(/[\u201c\u201d]/g, '"'); // 中文引号 → 英文
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (inStr) {
      if (c === '\\') {
        out += c + (src[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (c === '"') {
        const rest = src.slice(i + 1).replace(/^\s+/, '');
        const next = rest[0];
        if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
          inStr = false;
          out += c;
        } else {
          out += '\\"';
        }
        continue;
      }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  // 尾逗号：`,` 后面直接跟 `}` 或 `]`
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** 从 AI 回复里抠出 JSON —— 它经常裹在 ```json 里，或者前后带解释文字。 */
export function extractJson(text: string): unknown | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 1) 代码块优先
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(raw);

  // 2) 退一步：第一个 { 到最后一个 }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object') return v;
    } catch {
      // 原样解析失败 → 修一遍再试（裸引号 / 中文引号 / 尾逗号）
      try {
        const v = JSON.parse(repairJson(c)) as unknown;
        if (v && typeof v === 'object') return v;
      } catch {
        // 继续试下一个候选
      }
    }
  }
  return null;
}

/** 「2025-12-07 23:25」这类本地时间字符串 → ISO；认不出就返回 undefined（不猜）。 */
export function normalizeDeadline(v: unknown): string | undefined {
  if (typeof v === 'number') {
    // 10 位当秒、13 位当毫秒
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  // 带时区的直接交给 Date
  const iso = new Date(s);
  if (Number.isFinite(iso.getTime()) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return iso.toISOString();
  // 「2025-12-07 23:25」→ 按本地时区解释
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 23),
      Number(m[5] ?? 59),
    );
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  return Number.isFinite(iso.getTime()) ? iso.toISOString() : undefined;
}

/**
 * 判断一个接口地址是否依赖「页面现算」的签名参数。
 *
 * 这类参数（key / uuid / sign / token / nonce / timestamp / dateFormate）由前端 JS 生成，
 * 寿命往往只有几十秒。声明式配置**拿不到**它们 —— 这不是配置写错了，是原理上不可行。
 *
 * 真机案例：智慧树 ?key={uuid}&dateFormate=${dateFormate}。
 * 之前让用户点启用、同步失败、再回来诊断，绕了一大圈；在导入这一步就该拦住。
 */
export function looksLikeNeedsSignature(url: string): boolean {
  if (!url) return false;
  // 显式占位符：{uuid} / ${sign} / {dateFormate}
  if (/\$?\{[^}]*(uuid|sign|token|nonce|timestamp|dateformate)[^}]*\}/i.test(url)) return true;
  // query 里出现签名类参数名（即使有值，那个值也是短命的）
  return /[?&](key|uuid|sign|signature|token|nonce|timestamp|dateformate|secretstr)=/i.test(url);
}

/** 平台报的状态 → 这个应用里算不算"已经不用做了"。 */
export function looksDone(status: unknown): boolean {
  const s = String(status ?? '');
  if (!s) return false;
  return /(已交|待批阅|已批|已完成|已提交|已迟交|阅卷中)/.test(s);
}

/**
 * 解析一次导入。
 *
 * 只做"能不能用"的判断，不做字段猜测：认不出就如实报错，
 * 让用户重试或换一个 AI —— 比塞进一堆错数据强。
 */
export function parseImport(text: string): ParsedImport {
  const json = extractJson(text);
  if (!json) {
    return {
      kind: 'homework',
      notes: [],
      error:
        '没有从回复里找到 JSON。请确认 AI 的回复是纯 JSON（可以再点一次「复制提示词」，让它重新回答）。',
    };
  }

  const o = json as Record<string, unknown>;
  const notes: string[] = [];

  // ── 数据型：homeworkList / tasks 数组 / list 数组 ──
  const arr =
    (Array.isArray(o.homeworkList) && o.homeworkList) ||
    (Array.isArray(o.homeworks) && o.homeworks) ||
    (Array.isArray(o.tasks) && o.tasks) ||
    (Array.isArray(o.list) && o.list) ||
    (Array.isArray(o.data) && o.data) ||
    null;

  const looksLikeAdapter = typeof o.tasks === 'object' && o.tasks !== null && 'url' in (o.tasks as object);

  if (arr && arr.length > 0 && !looksLikeAdapter) {
    const homework: ImportedHomework[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const title = String(r.title ?? r.name ?? r.homeworkName ?? '').trim();
      if (!title) continue;
      homework.push({
        title,
        deadline: normalizeDeadline(r.deadline ?? r.endTime ?? r.dueAt ?? r.deadlineAt),
        desc: typeof r.desc === 'string' ? r.desc : typeof r.description === 'string' ? r.description : undefined,
        status: typeof r.status === 'string' ? r.status : undefined,
        homeworkId:
          typeof r.homeworkId === 'string' || typeof r.id === 'number' || typeof r.id === 'string'
            ? String(r.homeworkId ?? r.id)
            : undefined,
      });
    }
    if (homework.length > 0) {
      const courseName = typeof o.courseName === 'string' ? o.courseName : undefined;
      notes.push(`识别出 ${homework.length} 条作业`);
      if (courseName) notes.push(`课程：${courseName}`);
      const noDeadline = homework.filter((h) => !h.deadline).length;
      if (noDeadline > 0) notes.push(`${noDeadline} 条没有可用的截止时间，导入后需要自己补`);
      return {
        kind: 'homework',
        homework,
        courseName,
        teacherName: typeof o.teacherName === 'string' ? o.teacherName : undefined,
        platformName: typeof o.platform === 'string' ? o.platform : undefined,
        notes,
      };
    }
  }

  // ── 配置型：有 tasks.url 与 fields ──
  if (looksLikeAdapter || (o.tasks && o.fields)) {
    const tasks = o.tasks as Record<string, unknown>;
    // fields 可能整个缺失（AI 有时只给 tasks）—— 不能假设它存在
    const fields = (o.fields && typeof o.fields === 'object' ? o.fields : {}) as Record<string, unknown>;
    const url = typeof tasks.url === 'string' ? tasks.url : '';
    if (!url) {
      return {
        kind: 'adapter',
        notes,
        adapterDraft: json,
        error: '看起来是接入配置，但没给出作业列表的地址（tasks.url）。建议让 AI 重新回答一次。',
      };
    }
    const missing: string[] = [];
    for (const k of ['id', 'title']) {
      if (!fields[k]) missing.push(k);
    }
    notes.push(`作业列表接口：${url}`);
    if (missing.length > 0) notes.push(`缺少关键字段映射：${missing.join('、')}`);
    // 关键判断：接口里出现动态签名参数，API 模式**原理上**跑不通。
    // 与其让用户点启用、同步失败、再回来诊断，不如在导入这一步就说清楚。
    // 真机例（智慧树）：?key={uuid}&dateFormate=${dateFormate} —— 这两个由页面 JS 现算。
    if (looksLikeNeedsSignature(url)) {
      notes.push(
        '⚠️ 这个接口要带动态签名参数（key / uuid / sign / dateFormate 之类），它们由页面脚本现算，' +
          'App 拿不到。这类平台要走 DOM 模式（直接读页面表格），API 模式改多少轮都不会通。',
      );
    } else {
      notes.push('确认无误后点「启用为平台」，它就会和内置平台一样同步');
    }
    return {
      kind: 'adapter',
      notes,
      adapterDraft: json,
      platformName:
        typeof o.platform === 'object' && o.platform !== null
          ? String((o.platform as Record<string, unknown>).name ?? '')
          : undefined,
    };
  }

  return {
    kind: 'homework',
    notes,
    error:
      '认不出这个 JSON 结构。它既不像作业列表，也不像接入配置。可以再点一次「复制提示词」让 AI 按格式重答，或者干脆把作业手动加进去。',
  };
}

/** 把导入的作业转成手动任务的入参（不含 id 生成，交给引擎）。 */
export function toManualInput(
  h: ImportedHomework,
  courseName: string | undefined,
  platformLabel: string | undefined,
): {
  title: string;
  deadlineAt: string;
  courseName?: string;
  platformLabel?: string;
  done: boolean;
} {
  return {
    title: h.title,
    // 没截止时间就给一个"今天结束"的兜底，并在标题里留痕 —— 不能因为缺时间就丢掉这条作业
    deadlineAt: h.deadline ?? endOfTodayIso(),
    courseName,
    platformLabel: platformLabel ?? 'AI 导入',
    done: looksDone(h.status),
  };
}

function endOfTodayIso(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

/** 供 API 层使用：把已存在的手动任务判重（同标题 + 同课程不重复导入）。 */
export function isDuplicate(h: ImportedHomework, existing: UnifiedTask[]): boolean {
  const t = h.title.trim();
  return existing.some((e) => e.title.trim() === t);
}
