/**
 * 超星「任务点完成度」的解析与抓取。
 *
 * 所有 HTML 片段都来自 2026-11-02 真机 HAR（`mooctest.chaoxing.com.har`），
 * 不是照着"看起来应该长这样"编的。断言同时充当字段对照表：
 * 平台改版时这里会先红。
 *
 * 重点守三条：
 *   1. 「没有这句话」≠「0/0」—— 前者可能是改版，后者是真的没有任务点。
 *      混成一样，界面会显示"已全部完成"，而用户没有任何线索怀疑。
 *   2. 缺 classId 的课不能静默跳过，要说出来（多半是旧版本写入的课程缓存）。
 *   3. 一门课失败不能拖垮整批 —— 已拿到的照常返回。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChaoxingAdapter,
  nearestUpcomingWindow,
  parseTaskPointProgress,
} from '../../adapters/chaoxing/src/index.ts';
import { createSilentLogger } from '../src/ports/logger.ts';
import { systemClock, TokenBucket, UnavailableSigner } from '../src/index.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/ports/http.ts';
import type { AdapterContext } from '../src/ports/adapter.ts';
import type { UnifiedCourse } from '../src/domain/course.ts';
import type { Session } from '../src/ports/vault.ts';

/** 真机：课程头部统计（HAR 原文，仅压缩空白）。 */
const HEAD_DONE = `<div class="fanyaChapterWhite"><div class="chapter_head clearfix"><h2 class="xs_head_name fl" tabindex="0"><i class="catalog_points_yi fl"></i> 已完成任务点: <span style="color:#00B368">0</span>/2 <div class="catalog_jindu"><div class="catalog_ressbar"><div class="catalog_ressbar_width" style="width:0%"></div></div></div></h2></div></div>`;

/** 同一门课的另一处：章节行里的待完成数（用于确认"同页面还有章节级数据"）。 */
const CHAPTER_ROW = `<div class="posCatalog_select" id="cur770666731"><span class="posCatalog_name" title="一个故事讲完 CPU 的工作原理" onclick="getTeacherAjax('216084776','152036569','770666731');"><em class="posCatalog_sbar">2.6</em> 一个故事讲完 CPU 的工作原理 </span><input type="hidden" value="1" class="jobUnfinishCount"/><span class="catalog_points_yi prevTips"><span class="prevHoverTips">1个待完成任务点<i></i></span><span class="orangeNew">1</span></span></div>`;

const session: Session = {
  platformId: 'chaoxing',
  accountId: 'chaoxing::u1',
  origin: 'imported',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

function makeCtx(htmlFor: (url: string) => string | null, calls: string[] = []): AdapterContext {
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req.url);
      const body = htmlFor(req.url);
      const text = body ?? '';
      return {
        status: body === null ? 404 : 200,
        headers: { 'content-type': 'text/html' },
        url: req.url,
        setCookies: [],
        async text() {
          return text;
        },
        async json<T>() {
          return JSON.parse(text) as T;
        },
        async bytes() {
          return new TextEncoder().encode(text);
        },
      };
    },
  };
  return {
    http,
    clock: systemClock,
    logger: createSilentLogger(),
    limiter: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }),
    signer: new UnavailableSigner(),
  };
}

function course(id: string, over: Record<string, unknown> = {}): UnifiedCourse {
  return {
    id: `chaoxing:abc:${id}`,
    platformId: 'chaoxing',
    accountId: 'chaoxing::u1',
    platformCourseId: id,
    name: `课程 ${id}`,
    lastSeenAt: new Date().toISOString(),
    raw: { classId: `cls-${id}`, cpi: '487116507', enc: `enc-${id}` },
    ...over,
  } as UnifiedCourse;
}

describe('任务点：解析「已完成任务点: X/Y」', () => {
  it('真机片段解析出 0/2', () => {
    assert.deepEqual(parseTaskPointProgress(HEAD_DONE), {
      total: 2,
      done: 0,
      windows: [],
      hasPendingChapter: false,
    });
  });

  it('没有 span 包裹时也能取到（同一个平台的另一种渲染）', () => {
    assert.deepEqual(parseTaskPointProgress('<div> 已完成任务点：12/30 </div>'), {
      total: 30,
      done: 12,
      windows: [],
      hasPendingChapter: false,
    });
  });

  it('页面上没有这句话 → null（不是 0/0）', () => {
    // 这个区分是整条链路的根：把"没找到"当成"已完成"就是在撒谎
    assert.equal(parseTaskPointProgress(CHAPTER_ROW), null);
    assert.equal(parseTaskPointProgress('<html><body>登录</body></html>'), null);
  });

  it('完成数大于总数时按总数截断，不显示 110%', () => {
    assert.deepEqual(parseTaskPointProgress('已完成任务点: 9/4'), {
      total: 4,
      done: 4,
      windows: [],
      hasPendingChapter: false,
    });
  });

  it('章节行里带着待完成数 —— 以后做章节级展示不用再发请求', () => {
    assert.match(CHAPTER_ROW, /jobUnfinishCount"\/>/);
    assert.match(CHAPTER_ROW, /id="cur770666731"/);
  });
});

describe('任务点：抓取（每门课一个请求）', () => {
  it('带 stuenc 请求课程目录页，逐门课给出 total/done', async () => {
    const adapter = new ChaoxingAdapter();
    const calls: string[] = [];
    const ctx = makeCtx(() => HEAD_DONE, calls);

    const page = await adapter.fetchCourseProgress(ctx, session, [course('216084776'), course('216084777')]);

    assert.equal(page.items.length, 2);
    for (const it of page.items) {
      assert.equal(it.total, 2);
      assert.equal(it.done, 0);
      assert.equal(it.hasOpenNow, false, '这段 HTML 里没有开放窗口');
    }
    assert.equal(calls.length, 2, '一门课一个请求，不多打');
    // stuenc 是这门课能不能拿到数据的关键（与考试列表同源）
    assert.match(calls[0]!, /stuenc=enc-216084776/);
    assert.match(calls[0]!, /courseid=216084776/);
    assert.match(calls[0]!, /clazzid=cls-216084776/);
  });

  it('页面正常但没有任务点 → total=0（不是失败）', async () => {
    const adapter = new ChaoxingAdapter();
    // 有目录骨架、没有"已完成任务点"这句
    const ctx = makeCtx(() => '<div class="fanyaChapterWhite"><div class="chapter_head"></div></div>');
    const page = await adapter.fetchCourseProgress(ctx, session, [course('1')]);

    assert.deepEqual(page.items, [{ platformCourseId: '1', total: 0, done: 0 }]);
    assert.match(page.details?.join('') ?? '', /1 门没有/);
  });

  it('拿到的不是课程目录页 → 不写入（否则会被显示成"已全部完成"）', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => '<html><body>系统提示</body></html>');
    const page = await adapter.fetchCourseProgress(ctx, session, [course('1')]);

    assert.equal(page.items.length, 0, '解析不了就不要给数字');
    assert.match(page.details?.join('') ?? '', /既没有"已完成任务点"也没有目录骨架/);
  });

  it('一门课失败不影响其他课，且失败原因进日志', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx((url) => (url.includes('courseid=bad') ? null : HEAD_DONE));
    const page = await adapter.fetchCourseProgress(ctx, session, [course('ok'), course('bad')]);

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.platformCourseId, 'ok');
    assert.match(page.details?.join('') ?? '', /失败 1 门/);
  });

  it('缺 classId 的课要说出来，而不是静默跳过', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => HEAD_DONE);
    const page = await adapter.fetchCourseProgress(ctx, session, [{ ...course('1'), raw: {} } as UnifiedCourse]);

    assert.equal(page.items.length, 0);
    assert.match(page.details?.join('') ?? '', /缺 classId/);
  });

  it('courseIds 只抓指定的那几门', async () => {
    const adapter = new ChaoxingAdapter();
    const calls: string[] = [];
    const ctx = makeCtx(() => HEAD_DONE, calls);
    const page = await adapter.fetchCourseProgress(ctx, session, [course('a'), course('b'), course('c')], {
      courseIds: ['b'],
    });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.platformCourseId, 'b');
    assert.equal(calls.length, 1);
  });
});

/**
 * 章节开放期（2026-11-02 第二份 HAR，两门「有日期」的课）。
 *
 * 页面结构上，章节名与开放窗口是**并列的兄弟节点**，中间隔了几层 div：
 *   <div class="catalog_name"><a class="clicktitle"><span class="catalog_sbar">2.1</span> 什么是真理？</a></div>
 *   <div class="catalog_task"><div class="catalog_state ... catalog_tishi273">
 *     <span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-11-08 23:00 至 2026-11-29 23:00</em></span>
 *   </div></div>
 *
 * 所以不能按 DOM 嵌套切块（真机上 chapter_item 19 个，章节只有 15 个），
 * 只能"往前找最近的章节序号"来配对。配错会把时间挂到别的章节上，而且看不出来。
 */
const ROW_2_1 =
  '<div class="catalog_name newCatalog_name" ><a class="clicktitle"><span class="catalog_sbar">2.1</span> 什么是真理？ </a></div>' +
  '<div class="catalog_task"><div class="catalog_state catalog_jindu icon-dingshi catalog_tishi273"><span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-11-08 23:00 至 2026-11-29 23:00</em><i></i></span></div></div>';

const ROW_3_1 =
  '<div class="catalog_name newCatalog_name" ><a class="clicktitle"><span class="catalog_sbar">3.1</span> 历史发展的动力是什么？ </a></div>' +
  '<div class="catalog_task"><div class="catalog_state catalog_jindu icon-dingshi catalog_tishi273"><span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-11-15 08:00 至 2026-12-20 23:00</em><i></i></span></div></div>';

/** 只有「已关闭」的章节：没有时间，不该被当成窗口。 */
const ROW_CLOSED =
  '<div class="catalog_name newCatalog_name" ><a class="clicktitle"><span class="catalog_sbar">1.1</span> 第一节 </a></div>' +
  '<div class="catalog_task"><div class="catalog_state catalog_jindu icon-bukaifang catalog_tishi56"><span class="bntHoverTips">已关闭<i></i></span></div></div>';

function pageOf(rows: string, done = 0, total = 26): string {
  return `<h2 class="xs_head_name"><i class="catalog_points_yi fl"></i> 已完成任务点: <span>${done}</span>/${total} </h2>${rows}`;
}

const NOW = new Date('2026-11-02T12:00:00+08:00');

describe('任务点：章节开放期', () => {
  it('把章节名和开放窗口配对上，时间按本地墙上时间解析', () => {
    const r = parseTaskPointProgress(pageOf(ROW_2_1), NOW)!;
    assert.equal(r.total, 26);
    assert.equal(r.windows.length, 1);
    assert.equal(r.windows[0]!.chapter, '2.1 什么是真理？');
    // 页面上写的是 23:00，解析后本地小时必须还是 23 —— 差一小时就是时区处理错了
    const opens = new Date(r.windows[0]!.opensAt);
    const closes = new Date(r.windows[0]!.closesAt);
    assert.equal(opens.getMonth() + 1, 11);
    assert.equal(opens.getDate(), 8);
    assert.equal(opens.getHours(), 23);
    assert.equal(closes.getDate(), 29);
    assert.equal(closes.getHours(), 23);
  });

  it('「已关闭」没有时间，不会被当成开放窗口', () => {
    const r = parseTaskPointProgress(pageOf(ROW_CLOSED), NOW)!;
    assert.deepEqual(r.windows, []);
  });

  it('多个窗口时挑「最快关闭」的那个，而不是页面上第一个', () => {
    // 3.1 在页面上更靠后，但它 12/20 才关；2.1 是 11/29
    const r = parseTaskPointProgress(pageOf(ROW_3_1 + ROW_2_1), NOW)!;
    assert.equal(r.windows.length, 2);
    const win = nearestUpcomingWindow(r.windows, NOW)!;
    assert.equal(win.chapter, '2.1 什么是真理？');
    assert.equal(new Date(win.closesAt).getDate(), 29);
  });

  it('全部已过期 → 没有窗口（那门课已经没有要做的事，别留个日期吓人）', () => {
    // c2 真机：两个「本章测试」的窗口是 2026-09-06 ~ 2026-10-18，早已关闭
    const expired =
      '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">1.3</span> 本章测试 </a></div>' +
      '<div class="catalog_state catalog_jindu icon-chuangguan catalog_tishi273"><span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-09-06 16:03 至 2026-10-18 23:59</em></span></div>';
    const r = parseTaskPointProgress(pageOf(expired, 4, 6), NOW)!;
    assert.equal(r.windows.length, 1, '解析得到，但已经过期');
    assert.equal(nearestUpcomingWindow(r.windows, NOW), undefined);
  });

  it('抓取结果里带上最近窗口，界面才知道「什么时候关」', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => pageOf(ROW_2_1));
    // 用固定的 now 才能断言日期：适配器内部用 ctx.clock.now()
    const fixedCtx: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixedCtx, session, [course('1')]);

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.nextWindow?.chapter, '2.1 什么是真理？');
    assert.match(page.details?.join('') ?? '', /1 门课设了章节开放时间/);
  });
});

describe('任务点：三种「做不了」必须能分开', () => {
  /**
   * 这三件事对用户的意义完全不同，而它们的形态几乎一样（都是"还差 N 个"）：
   *   ① 现在能做，X 日关  → 去刷
   *   ② 现在一章都没开     → 去也白去，只需知道哪天开
   *   ③ 窗口已经关了       → 错过了
   * 混成一样，用户就没法判断该干什么（真机 2026-11-02：形势与政策 4/6，
   * 两个窗口 10/18 就关了，界面上什么提示都没有）。
   */
  it('窗口已过期 → 给出 lastClosedAt，且没有 nextWindow / hasOpenNow=false', async () => {
    const adapter = new ChaoxingAdapter();
    const expired =
      '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">1.3</span> 本章测试 </a></div>' +
      '<div class="catalog_state catalog_jindu icon-chuangguan catalog_tishi273"><span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-09-06 16:03 至 2026-10-18 23:59</em></span></div>';
    const ctx = makeCtx(() => pageOf(expired, 4, 6));
    const fixed: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    const item = page.items[0]!;
    assert.equal(item.nextWindow, undefined, '没有未来窗口');
    assert.equal(item.hasOpenNow, false);
    assert.ok(item.lastClosedAt, '必须给出"最近关闭"的时刻，否则界面说不出"已经错过"');
    assert.equal(new Date(item.lastClosedAt!).getDate(), 18);
  });

  it('窗口还没开 → nextWindow 存在但 hasOpenNow=false（去也白去）', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => pageOf(ROW_2_1));
    const fixed: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    const item = page.items[0]!;
    assert.ok(item.nextWindow, '即将开放的窗口要留着，用来告诉用户哪天开');
    assert.equal(item.hasOpenNow, false, '11/2 时这一章还没开放');
    assert.equal(item.lastClosedAt, undefined);
  });

  it('窗口正在开放 → hasOpenNow=true', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => pageOf(ROW_2_1));
    // 放开后一周
    const inWindow = new Date('2026-11-15T12:00:00+08:00');
    const fixed: AdapterContext = { ...ctx, clock: { now: () => inWindow } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    const item = page.items[0]!;
    assert.equal(item.hasOpenNow, true);
    // 这份 HTML 只有一个窗口，它开着 → 没有"已关闭"可记
    assert.equal(item.lastClosedAt, undefined);
  });
});

describe('任务点：没设时间限制的章节也算「现在能做」', () => {
  /**
   * 真机 2026-11-03：程设基础 24/50，9 个章节测验**已经开放**，
   * 但老师没给它们设时间限制 → 它们不出现在开放窗口列表里。
   * 只看窗口就会判成"一章都没开"，界面写着"剩下的等 11/23 开放"，
   * 而用户点进去明明能做。
   *
   * 补的判据是超星自己的「N个待完成任务点」标记。
   */
  const ROW_PENDING =
    '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">5.1</span> 章节测验 </a></div>' +
    '<div class="catalog_jindu catalog_tishi120"><span class="catalog_points_yi">1</span><span class="bntHoverTips">1个待完成任务点<i></i></span></div>';

  it('有待完成标记 + 窗口全在未来 → hasOpenNow 仍为 true', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => pageOf(ROW_2_1 + ROW_PENDING));
    const fixed: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    const item = page.items[0]!;
    assert.ok(item.nextWindow, '11/8 那个窗口还在，用来提示"哪天开新章"');
    assert.equal(item.hasOpenNow, true, '有待完成标记 = 现在就能做');
  });

  it('「0个待完成任务点」不算（不能因为出现这几个字就判定可做）', async () => {
    const adapter = new ChaoxingAdapter();
    const zero =
      '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">5.1</span> 章节测验 </a></div>' +
      '<div class="catalog_jindu"><span class="catalog_points_yi">0</span><span class="bntHoverTips">0个待完成任务点<i></i></span></div>';
    const ctx = makeCtx(() => pageOf(zero));
    const fixed: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    assert.equal(page.items[0]!.hasOpenNow, false);
  });
});

describe('任务点：第二种窗口写法「定时开放：MM-DD 至 MM-DD」', () => {
  /**
   * 真机 2026-11-03 截图：程设基础的每个章节都挂着
   * `定时开放：09-14 00:00 至 12-12 23:30`（已开放的那种写法）。
   * 它和未开放章节的 `开放时间：2026-11-08 …` 是两套文案，
   * 只认后者会让整门课的窗口全部丢失。
   *
   * 另一个坑：这种格式**没有年份**，只能按当前年份补，
   * 并在"结束早于开始"时判为跨年。
   */
  const ROW_TIMED =
    '<div class="catalog_name newCatalog_name" ><a class="clicktitle"><span class="catalog_sbar">1.9</span> 章节测验 </a></div>' +
    '<div class="catalog_task"><span class="muted">定时开放： 09-14 00:00 至 11-11 23:30</span></div>';

  it('解析出无年份的窗口，按当前年份补全', () => {
    const r = parseTaskPointProgress(pageOf(ROW_TIMED, 24, 50), NOW)!;
    assert.equal(r.windows.length, 1);
    const w = r.windows[0]!;
    const opens = new Date(w.opensAt);
    const closes = new Date(w.closesAt);
    assert.equal(opens.getFullYear(), 2026);
    assert.equal(opens.getMonth() + 1, 9);
    assert.equal(opens.getDate(), 14);
    assert.equal(opens.getHours(), 0);
    assert.equal(closes.getMonth() + 1, 11);
    assert.equal(closes.getDate(), 11);
    assert.equal(closes.getHours(), 23);
    assert.equal(w.chapter, '1.9 章节测验');
  });

  it('11/2 时这个窗口已经开着 → hasOpenNow=true（这就是程设的实际情况）', async () => {
    const adapter = new ChaoxingAdapter();
    const ctx = makeCtx(() => pageOf(ROW_TIMED, 24, 50));
    const fixed: AdapterContext = { ...ctx, clock: { now: () => NOW } } as AdapterContext;
    const page = await adapter.fetchCourseProgress(fixed, session, [course('1')]);

    const item = page.items[0]!;
    assert.equal(item.hasOpenNow, true, '09-14 就开了，一直开到 11-11');
    assert.ok(item.nextWindow);
    assert.equal(new Date(item.nextWindow!.closesAt).getDate(), 11);
  });

  it('结束早于开始 → 判为跨年（12-20 至 01-10）', () => {
    const cross =
      '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">9.1</span> 复习 </a></div>' +
      '<div class="catalog_task"><span class="muted">定时开放： 12-20 00:00 至 01-10 23:30</span></div>';
    const r = parseTaskPointProgress(pageOf(cross, 0, 10), NOW)!;
    const w = r.windows[0]!;
    assert.equal(new Date(w.opensAt).getFullYear(), 2026);
    assert.equal(new Date(w.closesAt).getFullYear(), 2027, '跨年要推到下一年，不能算出负区间');
  });
});

/**
 * 「现在可做 n 个」。
 *
 * 需求原话（2026-11-05）：有些任务点还能继续做，但整门课是分阶段开放的，
 * 界面上只说"还有可做的"不够 —— 要说清"现在点进去能做几条"。
 *
 * 判据：`done/total` 是全课程的累计差，里面含着还没开放 / 已关闭的章节，
 * **不能拿它当"可做"**。只统计「待完成任务点」标记所在、且此刻开放的章节。
 */
describe('任务点：「现在可做 n 个」', () => {
  /** 跑完这个待完成标记的章节块：章节名 → 可选窗口 → 待完成 N 个。 */
  const row = (bar: string, name: string, n: number, between = '') =>
    `<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">${bar}</span> ${name} </a></div>` +
    between +
    `<div class="catalog_jindu catalog_tishi120"><span class="catalog_points_yi">${n}</span><span class="bntHoverTips">${n}个待完成任务点<i></i></span></div>`;

  it('没设时间限制的章节：待完成数就是可做数', () => {
    const r = parseTaskPointProgress(pageOf(row('5.1', '章节测验', 3) + row('5.2', '小节练习', 2), 0, 10), NOW)!;
    assert.equal(r.availableNow, 5);
    assert.equal(r.hasPendingChapter, true);
  });

  it('还没开放的章节不算「现在可做」（分阶段开放的核心）', () => {
    const future = row(
      '2.1',
      '什么是真理？',
      2,
      '<div class="catalog_task"><div class="catalog_state"><span class="bntHoverTips"><em>本章节暂未开放，不能查看。开放时间： 2026-11-08 23:00 至 2026-11-29 23:00</em></span></div></div>',
    );
    const r = parseTaskPointProgress(pageOf(row('5.1', '章节测验', 3) + future, 0, 10), NOW)!;
    assert.equal(r.availableNow, 3, '11/2 时 2.1 还没开，只算 5.1 的 3 个');
  });

  it('窗口正开着的章节，待完成数算进来', () => {
    const openWin = row(
      '1.9',
      '章节测验',
      4,
      '<div class="catalog_task"><span class="muted">定时开放： 09-14 00:00 至 11-11 23:30</span></div>',
    );
    const r = parseTaskPointProgress(pageOf(openWin, 0, 10), NOW)!;
    assert.equal(r.availableNow, 4);
  });

  it('认不出章节归属时不给数字 —— 宁可不显示，也不给错数', () => {
    const html = '<h2>已完成任务点: 0/10</h2><div>3个待完成任务点</div>';
    const r = parseTaskPointProgress(html, NOW)!;
    assert.equal('availableNow' in r, false, '没有章节名可归属 → 不写这个键');
    assert.equal(r.hasPendingChapter, true);
  });
});
