/* 课业中枢 · 前端逻辑（无框架，零依赖） */
'use strict';

const $ = (id) => document.getElementById(id);
const KIND = { homework: '作业', exam: '考试', quiz: '测验', 'task-point': '任务点', discussion: '讨论', other: '其他' };
const STATUS = {
  pending: '待完成',
  submitted: '已提交',
  graded: '已出分',
  expired: '已过期',
  // 「不用交」不是"我做完了"，是"这条与我无关"（小组由别人交 / 免修 / 换课）。
  // 文案上绝不能写成"已完成" —— 那是在撒谎。
  skipped: '不用交',
  unknown: '',
};
const GROUP_TITLE = {
  overdue: '已逾期',
  today: '24 小时内',
  soon: '三天内',
  later: '更晚',
  open: '不限时',
  unknown: '截止未知',
};

let token = localStorage.getItem('hh_token') ?? '';
let platforms = [];
let currentState = null;

/** 运行在 Android 应用里？（main.js 会设置这个标记） */
const IS_ANDROID = window.__HH_PLATFORM === 'android';
/** 手机端：记住用户从哪个平台去登录了，回来后自动读取。 */
let pendingPlatformId = null;

// ---------------------------------------------------------------- 基础

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/**
 * 全屏遮罩：只留给「用户主动发起、且必须等他做完」的短操作（保存账号等）。
 * 同步一律不走这里 —— 它改用底部的常驻状态条（见 showSyncBar）。
 */
function busy(on) {
  $('busy').classList.toggle('hidden', !on);
}

// ---------------------------------------------------------------- 同步状态条

let syncBarKind = 'idle'; // idle | running | done | error
let syncBarTimer;
let syncBarStartedAt = 0;
/** 本地是否正在同步（防重入） */
let syncing = false;

/**
 * 同步状态条：**所有同步入口统一用它表达状态**。
 *
 * 为什么不用全屏遮罩（真机反馈）：同步要跑十几二十秒，遮罩把整个界面锁死，
 * 用户既看不了已有的待办、也做不了别的事 —— 而他其实只需要知道「它在跑」。
 * 状态条常驻底部、不拦截点击，可以一边同步一边翻列表。
 */
function showSyncBar(text, kind = 'running', autoHideMs = 0) {
  clearTimeout(syncBarTimer);
  syncBarKind = kind;
  const el = $('syncBar');
  el.classList.remove('hidden', 'is-done', 'is-error');
  if (kind === 'done') el.classList.add('is-done');
  if (kind === 'error') el.classList.add('is-error');
  // 旋转的圆环箭头用 SVG（见 index.html 的图标精灵）：
  // 文字字形 ⟳ 旋转时绕的是"行盒中心"，而字墨不在那里 —— 圆心会跟着偏。
  const icon =
    kind === 'running'
      ? '<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-refresh"></use></svg>'
      : kind === 'error'
        ? '⚠'
        : '✓';
  el.innerHTML = `${icon} <span>${escapeHtml(text)}</span>`;
  $('syncBtn').classList.toggle('busy', kind === 'running');
  if (autoHideMs > 0) syncBarTimer = setTimeout(hideSyncBar, autoHideMs);
}

function hideSyncBar() {
  clearTimeout(syncBarTimer);
  syncBarKind = 'idle';
  $('syncBar').classList.add('hidden');
  $('syncBtn').classList.remove('busy');
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-token'] = token;
  const res = await fetch(path, { ...opts, headers });
  let body;
  try { body = await res.json(); } catch { body = { ok: false, error: `HTTP ${res.status}` }; }
  // 只在「HTTP 层错误」或「服务端显式给了 error」时抛异常。
  // /api/sync 的应答里 ok:false 只表示「有账号没同步成功」，body 本身是完整有效的结果
  // —— 之前把它当接口失败抛出，弹出了莫名其妙的「同步失败：HTTP 200」。
  if (!res.ok || (body.ok === false && body.error)) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 「截止 9/30 23:59」—— 剩余时间会随展示时刻漂移，绝对日期才是用户核对真机界面的锚点。 */
function fmtDueDate(task) {
  const d = task.deadline;
  if (!d || d.kind !== 'absolute') return '';
  const at = task.deadlineAt ? new Date(task.deadlineAt) : (d.at ? new Date(d.at) : null);
  if (!at || Number.isNaN(at.getTime())) return '';
  return `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function fmtCountdown(task) {
  const d = task.deadline;
  if (d.kind === 'open') return { text: '不限时', cls: 'normal' };
  if (d.kind === 'unknown') return { text: '截止未知', cls: 'normal' };
  const at = task.deadlineAt ? new Date(task.deadlineAt) : new Date(d.at);
  const ms = at.getTime() - Date.now();
  const abs = Math.abs(ms);
  const day = Math.floor(abs / 86400000);
  const hour = Math.floor((abs % 86400000) / 3600000);
  const min = Math.floor((abs % 3600000) / 60000);
  let span = day > 0 ? `${day} 天 ${hour} 小时` : hour > 0 ? `${hour} 小时 ${min} 分钟` : `${Math.max(min, 1)} 分钟`;
  if (ms < 0) return { text: `已逾期 ${span}`, cls: 'overdue' };
  return { text: `还剩 ${span}`, cls: ms < 86400000 ? 'today' : 'normal' };
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 待办

/** 平台短名。取不到时退回 displayName，多一个字也比空着强。 */
function platformShort(id) {
  const map = { chaoxing: '超星', yuketang: '雨课堂', 'yuketang-changjiang': '长江雨课堂', ismart: 'iSmart', manual: '手动', mock: 'Mock' };
  return map[id] ?? platforms.find((p) => p.id === id)?.displayName ?? id;
}

/**
 * 一条任务该显示的平台名。
 *
 * 手动添加的任务，用户自己填了平台名（"雨课堂"、"老师口头布置"…），优先显示它 ——
 * 来源恒为 'manual'，直接显示会变成"手动"，那等于把用户填的信息丢了。
 */
function taskPlatform(t) {
  return t.platformLabel || platformShort(t.platformId);
}

/* ────────────────────────────────────────────────────── 按课程筛选
 *
 * 为什么是「点课程标签筛选」而不是「按课程分组的第二个视图」：
 * 待办页是**作战面板**，任何常驻控件都在稀释"今天要交什么"这个核心信息
 * （那一行已经有同步按钮 + 上次同步时间了）。而课程标签本来就长在每条任务上，
 * 点它筛选是**零新增常驻控件**的做法，且天然是"看一眼就走"的临时动作。
 *
 * 顺带接手一个既有职责：标签宽度固定（58px、最多 3 行），长课程名会被截断，
 * 所以原来的点击是"弹 toast 看全名"。改成筛选后，**筛选条上显示完整课程名**，
 * 这个职责由筛选条接管 —— 不需要再多留一个交互。
 *
 * 不做持久化：筛选是临时动作，重开 App 即清除。但待办页与已完成页**各自记账**，
 * 切 tab 不互相影响（切 tab 不是"结束查看"）。
 */
const courseFilter = { todo: null, done: null }; // {id, label} | null —— 按 **id** 筛，不再按名字

/**
 * 任务卡上显示的课程名。
 *
 * 任务自己存的是平台原名（courseName），它是数据和平台比对用的；
 * 用户改过的名字在 state.courseTitles 里（只含改过名的课程，通常是个空对象）。
 * 所以"改名"不需要动任何任务记录，只影响这一行的显示。
 */
function courseNameOf(t) {
  return lastState?.courseTitles?.[t.courseId] ?? t.courseName;
}
let lastState = null;

function renderFilterBar(kind, shown) {
  const el = $(kind === 'todo' ? 'todoFilter' : 'doneFilter');
  const f = courseFilter[kind];
  if (!f) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="filter-bar">
      <span class="filter-text">仅显示 <b>${escapeHtml(f.label)}</b> · ${shown} 条</span>
      <button class="filter-clear" data-rename-filter="${kind}" title="改这门课的显示名">改名</button>
      <button class="filter-clear" data-clear-filter="${kind}">清除</button>
    </div>`;
}

/** 筛选条上的「清除」—— 两个页面共用一套委托。 */
for (const kind of ['todo', 'done']) {
  $(kind === 'todo' ? 'todoFilter' : 'doneFilter').addEventListener('click', (e) => {
    // 就在"只看这门课"的界面上改名 —— 这是用户真正会盯着课程名看的地方。
    // 课程页那个入口保留（首次配置时顺手用），但日常不该跑那儿去。
    const ren = e.target.closest('[data-rename-filter]');
    if (ren) {
      const cur = courseFilter[kind];
      if (cur) openRenameSheet(cur.id, cur.label);
      return;
    }
    if (!e.target.closest('[data-clear-filter]')) return;
    clearCourseFilter(kind);
  });
}

/** 每题状态码 → 人话。未知码原样显示（比显示"未知"有用：能直接看出来平台加了新状态）。 */
const SUBTASK_STATUS = {
  PROBLEM_ACCEPTED: '已通过',
  PROBLEM_SUBMITTED: '已交待判',
  PROBLEM_WRONG_ANSWER: '答案错误',
  PROBLEM_NO_ANSWER: '未提交',
};

/**
 * 题目级进度条。
 *
 * 为什么做成可点的按钮而不是纯色条：它回答的是"还有几题"，而用户看到这个数字的
 * 下一个动作几乎必然是"哪几题"——把这两步合成一步，省掉一次猜。
 */
function renderProgress(t) {
  const p = t.progress;
  // null = 这个平台没有「每题」这个概念（超星/iSmart/雨课堂）→ 什么都不画
  if (!p) return '';
  // total=0 = 有这个概念，但还没开考 / 拿不到题目 → 画一句明确的话，
  // 而不是留白（留白和"坏了"在用户眼里没有区别）。
  if (!p.total) {
    return `<span class="prog prog-none">还没开考 · 点作业名去平台看题</span>`;
  }
  const pct = (n) => Math.round((Math.max(0, Math.min(n, p.total)) / p.total) * 100);
  const ac = pct(p.accepted);
  const sub = Math.max(0, pct(p.submitted) - ac);
  const rest = Math.max(0, 100 - ac - sub);
  // 全交之后重点变成 AC，所以文案也跟着换：先报"都交了"，再报 AC 到几
  const label =
    p.submitted >= p.total
      ? `${p.total}/${p.total} 已交 · ${p.accepted}/${p.total} AC`
      : `已交 ${p.submitted}/${p.total}${p.accepted > 0 ? ` · AC ${p.accepted}` : ''}`;
  return `<button class="prog" data-detail-task="${escapeHtml(t.id)}" title="点开看每题">
    <span class="prog-bar"><i class="s-ac" style="width:${ac}%"></i><i class="s-sub" style="width:${sub}%"></i><i class="s-rest" style="width:${rest}%"></i></span>
    <span class="prog-txt">${escapeHtml(label)}</span>
  </button>`;
}

/** 点进度条 → 打开题目详情。 */
function openTaskDetail(taskId) {
  const all = [
    ...Object.values(lastState?.grouped ?? {}).flat(),
    ...(lastState?.completed ?? []),
  ];
  const t = all.find((x) => x.id === taskId);
  if (!t) return;
  $('detailTitle').textContent = t.title;
  const due = fmtDueDate(t);
  const p = t.progress;
  const rows = (t.subtasks ?? [])
    .map((s) => {
      const ok = s.status === 'PROBLEM_ACCEPTED';
      const idle = s.status === 'PROBLEM_NO_ANSWER';
      const cls = ok ? 'ok' : idle ? 'idle' : 'warn';
      return `<div class="subtask ${cls}">
        <span class="st-label">${escapeHtml(s.label)}</span>
        <span class="st-score">${s.score} 分</span>
        <span class="st-status">${escapeHtml(SUBTASK_STATUS[s.status] ?? s.status)}</span>
      </div>`;
    })
    .join('');
  $('detailBody').innerHTML = `
    <div class="detail-meta">${escapeHtml(t.courseName)}${due ? ` · 截止 ${due}` : ''}</div>
    ${p && p.total > 0 ? `<div class="detail-sum">共 ${p.total} 题 · 已交 <b>${p.submitted}</b> · 通过 <b>${p.accepted}</b></div>` : ''}
    <div class="subtask-list">${rows || '<div class="muted">这个平台没有提供每题明细</div>'}</div>
    ${t.url ? `<a class="detail-link" href="${escapeHtml(t.url)}">去平台做题 ↗</a>` : ''}
  `;
  openOverlay($('taskDetail'));
}

/**
 * 在「同一个 WebView」里打开平台页面，并显示返回条。
 *
 * 为什么不用 target="_blank" / window.open：WebView 里那会开一个没有返回入口的
 * 新窗口（或者什么都不发生），用户只能杀进程回来。原生侧的浏览模式与登录页共用
 * 同一条返回条，区别只有一个 —— **回来时不登记账号、不触发同步**。
 */
function openTaskExternally(url) {
  if (!url) return;
  // 超星会校验来源页：从外部直接打开作业页会回「信息提示 · 无权限！」。
  // 带上来源域名的 Referer，模拟"从作业列表点进来"。
  const referer = /chaoxing.com/.test(url) ? 'https://mooc2-ans.chaoxing.com/' : null;
  if (window.Android?.openBrowse) {
    window.Android.openBrowse(url, referer);
    return;
  }
  // 桌面/浏览器：退回普通新标签页
  window.open(url, '_blank', 'noopener');
}

function renderTodo(state) {
  lastState = state;
  const list = $('todoList');
  const grouped = state.grouped ?? {};
  const order = ['overdue', 'today', 'soon', 'later', 'open', 'unknown'];
  const f = courseFilter.todo;
  let html = '';
  let total = 0; // 未筛选的总数 —— 徽标与空状态都用它，不受筛选影响
  let shown = 0; // 筛选后实际显示的条数

  for (const key of order) {
    const all = grouped[key] ?? [];
    total += all.length;
    // 筛选只改变"显示哪些"，不改变"一共有多少"：徽标仍报总数，
    // 否则用户一筛选就以为待办变少了。
    // 按 **courseId** 筛：两门同名课各有 ID，按名字筛会把它们混成一锅。
    const tasks = f ? all.filter((t) => t.courseId === f.id) : all;
    if (tasks.length === 0) continue;
    shown += tasks.length;
    html += `<div class="group-title ${key}">${GROUP_TITLE[key]} · ${tasks.length}</div>`;
    for (const t of tasks) {
      const cd = fmtCountdown(t);
      const status = STATUS[t.status] ? ` · ${STATUS[t.status]}` : '';
      // 手动标记被「平台优先」压住时，必须说明白 ——
      // 否则用户会以为自己上次没点成功（点了没反应 = 静默失败）。
      const manualHint = t.manualCompleted
        ? `<span class="manual-hint" title="你在本机标过已完成，但平台明确显示未完成；按「平台优先」以平台为准">已标过 · 平台称未完成</span>`
        : '';
      const link = t.url
        ? `<a href="${escapeHtml(t.url)}" data-open-url="${escapeHtml(t.url)}" class="task-title" style="color:inherit;text-decoration:none">${escapeHtml(t.title)} ↗</a>`
        : `<div class="task-title">${escapeHtml(t.title)}</div>`;
      // 「已交完但没全 AC」：留在原位（人正在做这门课，不该被挪到看不见的角落），
      // 但左侧换绿条、整体降透明度，并且排在同组末尾（顺序在 core 里定）。
      const pendingAc = t.pendingAc === true;
      html += `
        <div class="task ${key === 'overdue' ? 'overdue' : key === 'today' ? 'today' : ''} ${pendingAc ? 'pending-ac' : ''}">
          <span class="course-tag" data-course-id="${escapeHtml(t.courseId)}" title="${escapeHtml(courseNameOf(t))}">${escapeHtml(courseNameOf(t))}</span>
          <div class="task-body">
            ${link}
            <div class="task-meta"><span class="kind">${KIND[t.kind] ?? t.kind}</span><span class="plat">${escapeHtml(taskPlatform(t))}</span>${status}${manualHint}</div>
            <div class="countdown ${cd.cls}">${cd.text}${fmtDueDate(t) ? ` · 截止 ${fmtDueDate(t)}` : ''}</div>
            ${renderProgress(t)}
          </div>
          ${t.revision > 1 ? `<span class="rev-dot">有变更</span>` : ''}
          <button class="done-btn menu" data-menu-task="${escapeHtml(t.id)}" aria-label="处理这条" title="完成 / 不用交 / 删除">✓</button>
        </div>`;
    }
  }

  // 筛选后为空：说"这门课没有待办"，**不复用全局空状态** ——
  // 复用会让用户以为整个库都空了，这是最容易误导的一种省略。
  if (f && shown === 0) html = '<div class="empty">这门课没有待办</div>';

  renderFilterBar('todo', shown);
  $('todoEmpty').classList.toggle('hidden', total > 0);
  list.innerHTML = html;
  // 徽标只数「还没交完」的：已交完的条目仍然在列表里（绿的），但把它算进待办
  // 会把那个数字撑虚 —— 你打开看到 21，直觉是"还有 21 件要做"。
  const pendingAcCount = state.counts?.pendingAc ?? 0;
  const badgeTotal = Math.max(0, total - pendingAcCount);
  $('badgeTodo').textContent = badgeTotal > 0 ? String(badgeTotal) : '';

  // 数据体检行：只在「需要人知道」的时候出现 ——
  // ① 落盘失败（最严重，会导致重启后丢数据）② 库里的条数多于界面上看得见的。
  // 目的：终结「数据丢了却完全没提示」的局面（真机已发生两次）。
  const d = state.diag;
  const diagEl = $('diagLine');
  const storeErr = d?.store?.lastError;
  if (storeErr) {
    diagEl.innerHTML =
      `⚠ <b>数据保存失败</b>：${escapeHtml(String(storeErr))}<br>` +
      '重启后最近同步的数据可能丢失，请把这句话截图反馈。';
    diagEl.classList.remove('hidden');
  } else if (d && d.total > d.visible) {
    const parts = [];
    if (d.hiddenUserDeleted > 0) parts.push(`${d.hiddenUserDeleted} 条被你删除`);
    if (d.hiddenSoftDeleted > 0) parts.push(`${d.hiddenSoftDeleted} 条已从平台消失`);
    if (d.hiddenUnknownDeadline > 0) parts.push(`${d.hiddenUnknownDeadline} 条无截止时间`);
    const perPlatform = Object.entries(d.byPlatform ?? {})
      .map(([pid, v]) => `${pid} ${v.visible}/${v.total}`)
      .join(' · ');
    const kb = d.store?.bytes ? ` · 存储约 ${Math.round(d.store.bytes / 1024)} KB` : '';
    diagEl.innerHTML =
      `库中 ${d.total} 条 · 当前可见 ${d.visible} 条${kb}` +
      (parts.length ? `（另有 ${parts.join('、')}）` : '') +
      (perPlatform ? `<br>${escapeHtml(perPlatform)}` : '');
    diagEl.classList.remove('hidden');
  } else {
    diagEl.classList.add('hidden');
  }

  renderNotifyLine(state);

  const reminders = state.reminders ?? [];
  $('reminderBox').classList.toggle('hidden', reminders.length === 0);
  $('reminderList').innerHTML = reminders
    .map((r) => `<div class="reminder"><b>${escapeHtml(r.title)}</b><div class="muted">${escapeHtml(r.body)}</div></div>`)
    .join('');
}

/**
 * 截止提醒的排期状态。
 *
 * 为什么必须在界面上交底：提醒是**异步发生**的（到点由系统闹钟在通知栏弹出），
 * 用户在 App 里看不到任何"它到底排上了没有"的证据。而这条链路又依赖两个他控制不了
 * 的东西（通知权限、系统闹钟），一旦没生效，症状是"什么都没有发生"——
 * 最容易让人以为自己记错了。所以把「排了几条、下一条什么时候、权限开没开」明说。
 */
function renderNotifyLine(state) {
  const el = $('notifyLine');
  const n = state.notify ?? {};
  const scheduled = n.scheduled ?? 0;
  const perm = window.Android?.notificationPermission?.() ?? 'unknown';

  // 没有原生桥（电脑上跑）→ 根本没有通知栏这回事，整条提示都不该出现
  if (perm === 'unknown') {
    el.classList.add('hidden');
    return;
  }

  if (perm === 'denied') {
    // 权限没开 → 排期再准也弹不出来，这条提示是唯一能让用户知道原因的途径
    el.className = 'diag-line warn';
    el.style.cursor = 'pointer';
    el.innerHTML =
      '⚠ 通知权限未开启，截止提醒不会弹出。<br>点这里去系统设置里打开（设置 → 通知 → 课业中枢）。';
    el.classList.remove('hidden');
    return;
  }

  if (scheduled === 0) {
    el.className = 'diag-line';
    el.style.cursor = 'default';
    el.innerHTML = '截止提醒：当前没有需要排期的任务（没有截止时间或都已逾期）。';
    el.classList.remove('hidden');
    return;
  }

  const next = n.next ? fmtLocal(n.next.fireAt) : '';
  el.className = 'diag-line';
  el.style.cursor = 'default';
  el.innerHTML =
    `截止提醒已排期 <b>${scheduled}</b> 条` +
    (next ? ` · 下一条 ${escapeHtml(next)}` : '') +
    '<br>到点由系统在通知栏弹出（App 没打开也会响）。';
  el.classList.remove('hidden');
}

function renderDone(state) {
  lastState = state;
  const all = state.completed ?? [];
  const f = courseFilter.done;
  const done = f ? all.filter((t) => t.courseId === f.id) : all;
  const rows = done
    .map((t) => {
      const due = fmtDueDate(t);
      const status = STATUS[t.status] ?? t.status;
      // 本地标的「已完成」必须标出来 —— 不能让用户以为平台也是这么显示的。
      // 而「不用交」是**另一种东西**：不是我做完了，是这条与我无关 —— 文案绝不混用。
      const origin =
        t.completionOrigin === 'skipped'
          ? `<span class="manual-tag skip" title="你标过「不用交」（小组由别人交 / 免修 / 换课）—— 这不是已完成">不用交</span>`
          : t.completionOrigin === 'manual'
            ? `<span class="manual-tag" title="这条的「已完成」是你手动标的，平台没有给出该状态">手动</span>`
            : '';
      return `
        <div class="task done">
          <span class="course-tag" data-course-id="${escapeHtml(t.courseId)}" title="${escapeHtml(courseNameOf(t))}">${escapeHtml(courseNameOf(t))}</span>
          <div class="task-body">
            ${
              t.url
                ? `<a href="${escapeHtml(t.url)}" data-open-url="${escapeHtml(t.url)}" class="task-title" style="color:inherit;text-decoration:none">${escapeHtml(t.title)} ↗</a>`
                : `<div class="task-title">${escapeHtml(t.title)}</div>`
            }
            <div class="task-meta"><span class="kind">${KIND[t.kind] ?? t.kind}</span><span class="plat">${escapeHtml(taskPlatform(t))}</span> · ${escapeHtml(status)}</div>
            ${due ? `<div class="countdown normal">截止 ${due}</div>` : ''}
            ${renderProgress(t)}
          </div>
          ${origin}
          ${t.manualCompleted ? `<button class="done-btn undo" data-undone-task="${escapeHtml(t.id)}" title="撤销手动标记（只影响本机显示）">撤销</button>` : ''}
          ${t.manualSkipped ? `<button class="done-btn undo" data-undo-skip="${escapeHtml(t.id)}" title="撤销「不用交」（它会回到待办，并重新参与提醒）">撤销</button>` : ''}
        </div>`;
    })
    .join('');
  $('doneList').innerHTML =
    f && done.length === 0 ? '<div class="empty">这门课没有已完成记录</div>' : rows;
  renderFilterBar('done', done.length);
  $('doneEmpty').classList.toggle('hidden', all.length > 0);
  $('badgeDone').textContent = all.length > 0 ? String(all.length) : '';
}

/* ──────────────────────────────────── 记录页（查看性信息都归这里）
 *
 * 三段：已完成 / 变更历史 / 同步日志。
 * 为什么放在一起（用户 2026-10-18 的判断）：**变更性操作和查看性信息是两种心智** ——
 * 同步日志待在设置页，就是"想查点东西，却要跑到改东西的地方"。
 *
 * 但**已完成必须默认可见**，不能因为"它现在是三段之一"就多一次点击：
 * 看已完成的作业是高频动作，其余两段才是偶尔回头查的。
 */
let recordSeg = 'done';

function switchRecordSeg(seg) {
  recordSeg = seg;
  for (const b of $('recordSegs').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.seg === seg);
  }
  for (const k of ['done', 'changes', 'synclog']) {
    $(`seg-${k}`).classList.toggle('hidden', k !== seg);
  }
  if (seg === 'changes') renderChanges().catch((e) => toast(e.message));
  if (seg === 'synclog') renderLog().catch((e) => toast(e.message));
}

/**
 * 变更历史 —— 待办页那条「N 条作业信息有更新」只闪一次，用户当时没看清就过去了。
 * 这里是它的可回溯版本。这正是"变更"不能只做成一次性提示的原因。
 */
async function renderChanges() {
  const host = $('changesList');
  host.innerHTML = '<div class="card muted">加载中…</div>';
  let changes = [];
  try {
    ({ changes } = await api('/api/changes?days=30'));
  } catch (e) {
    host.innerHTML = `<div class="card muted">读取失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!changes || changes.length === 0) {
    host.innerHTML =
      '<div class="card muted">最近 30 天没有变更记录。<br>新同步到的作业、老师改期或改标题，都会记在这里。</div>';
    return;
  }
  host.innerHTML = changes
    .map(
      (c) => `<div class="card${c.removed ? ' ch-removed-card' : ''}">
        <b>${escapeHtml(c.title)}</b>${c.removed ? '<span class="ch-gone">已移除</span>' : ''}
        <div class="muted">${escapeHtml(c.courseName)}</div>
        ${renderChangeRows(c.changes)}
      </div>`,
    )
    .join('');
}

$('recordSegs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-seg]');
  if (btn) switchRecordSeg(btn.dataset.seg);
});

function renderAccounts(state) {
  const accounts = state.accounts ?? [];
  if (accounts.length === 0) {
    $('accountList').innerHTML = `<div class="card muted">还没有账号。在下面添加，或用零影响路线导入。</div>`;
    return;
  }
  $('accountList').innerHTML = accounts
    .map((a) => {
      const cls = a.lastSyncStatus === 'ok' ? 'ok' : a.lastSyncStatus ? 'warn' : '';
      const last = a.lastSyncAt ? `上次同步 ${fmtLocal(a.lastSyncAt)}` : '从未同步';
      const msg = a.lastSyncMessage ? `<div class="meta">${escapeHtml(a.lastSyncMessage)}</div>` : '';
      // 「重登」入口分两种，因为它们的能力根本不同：
      //  · 有保存密码（如超星账号密码登录）→ 引擎在同步时自己会重登，
      //    这是个**说明性**徽标，告诉用户「不用管它」；
      //  · 应用内登录（iSmart / 雨课堂）→ 我们手上根本没有密码，
      //    只能跳回平台官方登录页让你登一次 → 做成**可点按钮**。
      // 以前第二种账号什么都没有，会话一失效用户只能自己摸回「添加账号」重新走一遍。
      const plat = platforms.find((x) => x.id === a.platformId);
      const loginUrl = plat?.authMethods?.find((m) => m.kind === 'in-app')?.loginUrl ?? '';
      // username === 'browser' 就是「应用内登录」登记的身份（离线登记的约定），
      // 跳转登录后回到应用也是登记到同一个账号，不会另起一个。
      const canRelogin = !a.hasCredentials && a.username === 'browser' && loginUrl;
      let cred = '';
      if (a.hasCredentials) {
        cred = `<span class="cred-badge" title="已记住密码：会话失效时同步会自动重新登录，不需要你操作">🔑 自动重登已开启</span>`;
      } else if (canRelogin) {
        cred = `<button class="cred-badge as-btn" data-relogin="${escapeHtml(a.platformId)}" data-login-url="${escapeHtml(loginUrl)}" title="打开平台官方登录页重新登录一次（会话失效时用这个）">🔑 一键重登</button>`;
      }
      // 本机会话 cookie 名单**已移除**（2026-10-13）：它是为「iSmart 到底断在哪一环」
      // 做的定位工具，而结论早就拿到了（cookie 一直在本机，掉线是服务端闲置作废 +
      // 夜里无网）。诊断工具用完就该撤，留着只是给正常使用添噪音。
      return `
        <div class="account">
          <div>
            <div class="name"><span class="dot ${cls}"></span>${escapeHtml(a.label)} ${cred}</div>
            <div class="meta">${escapeHtml(a.platformId)} · ${last}</div>
            ${msg}
          </div>
          <button class="mini" data-remove="${escapeHtml(a.id)}">移除</button>
        </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- 账号表单

/**
 * 课程页：列出每个账号下的课程，勾选 = 参与同步。
 *
 * 取消勾选只是**停止请求平台**，已有作业记录完整保留 ——
 * 这是它与「删整课」的关键区别，也是它取代删整课的原因：
 * 用户想表达的是「别再查它」，而不是「把记录删掉」。
 * 往期课程取消勾选即可，同步会明显变快。
 */
async function renderCourses() {
  const box = $('courseList');
  box.innerHTML = '<div class="card muted">加载中…</div>';
  try {
    const r = await api('/api/courses');
    const groups = r.groups ?? [];
    if (groups.length === 0) {
      box.innerHTML = '<div class="card muted">还没有账号，先去「账号」页添加。</div>';
      return;
    }
    box.innerHTML = groups
      .map(
        (g) => `
      <div class="card">
        <h3>${escapeHtml(g.label)} <span class="muted" style="font-weight:400">· ${g.courses.length} 门</span></h3>
        ${
          g.courses.length === 0
            ? '<div class="muted">这个账号下还没有课程（先同步一次）</div>'
            : g.courses
                .map(
                  (c) => `
          <div class="course-row">
            <label class="course-row-pick">
              <input type="checkbox" data-mute-course="${escapeHtml(c.id)}" data-mute-account="${escapeHtml(g.accountId)}"${c.muted ? '' : ' checked'}>
              <span class="course-row-name">${escapeHtml(c.displayName || c.name)}${c.displayName ? '<i class="renamed-tag">已改名</i>' : ''}</span>
            </label>
            <span class="course-row-count">${c.taskCount} 条</span>
            <button class="course-mini" data-rename-course="${escapeHtml(c.id)}" data-rename-cur="${escapeHtml(c.displayName || c.name)}" title="改显示名">✎</button>
          </div>`,
                )
                .join('')
        }
      </div>`,
      )
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="card muted">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

/** 当前正在改的课程。warned 用来"第二次点保存"放行重名 —— 只提示一次，不阻塞。 */
let renameTarget = null;

function openRenameSheet(courseId, current) {
  renameTarget = { courseId, warned: false };
  $('renameInput').value = current;
  $('renameHint').textContent = '只改显示，不影响同步。留空保存即恢复原名。';
  openOverlay($('renameSheet'));
  $('renameInput').focus();
}

async function saveRename() {
  if (!renameTarget) return;
  const name = $('renameInput').value.trim();
  try {
    const r = await api('/api/course/rename', {
      method: 'POST',
      body: JSON.stringify({ courseId: renameTarget.courseId, name }),
    });
    // 重名不拒绝，但要让用户知道：第一遍只提示，第二遍才真正写。
    if (r.conflict && !renameTarget.warned) {
      renameTarget.warned = true;
      $('renameHint').innerHTML =
        `已有同名课程《${escapeHtml(r.conflict.title)}》。再点一次「保存」仍可改名 —— `
        + '两门课各自独立，点课程名筛选也互不影响；也可以用「⇄」把同名的手动作业归到一起。';
      return;
    }
    closeOverlay($('renameSheet'));
    renameTarget = null;
    toast(name ? '已改显示名' : '已恢复平台原名');
    await refresh();
    await renderCourses();
  } catch (e) {
    toast(`改名失败：${e.message}`, 5000);
  }
}


function renderPlatformOptions() {
  const options = platforms
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}${p.experimental ? '（实验性）' : ''}</option>`)
    .join('');
  for (const id of ['platformSelect', 'harPlatform', 'attachPlatform']) {
    $(id).innerHTML = options;
  }

  // 手机端没有「CDP 附着」这个概念（依赖本机浏览器调试端口）
  if (IS_ANDROID) {
    $('cdpBlock').classList.add('hidden');
  }

  renderMethods();
}

/** 手机端登录：切到平台官网，回来后由原生侧调 HH.returnedFromLogin 自动读取。 */
function openPlatformLogin(platformId, url) {
  pendingPlatformId = platformId;
  if (window.Android?.openLogin) {
    window.Android.openLogin(url, platformId);
  } else {
    // 桌面端浏览器里跑时，退化成新开标签页
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * 从平台登录页回到应用后调用（原生侧触发）。
 * 第二个参数是平台网页 localStorage 的快照（JSON 串）——
 * 雨课堂等平台的 API token 存在那里而不是 cookie，必须带回注入会话。
 */
async function returnedFromLogin(platformId, storageJson) {
  const id = platformId || pendingPlatformId;
  pendingPlatformId = null;
  if (!id) return;
  const pname = platforms.find((p) => p.id === id)?.displayName ?? id;
  // 与手动/自动同步一致：不锁界面，只在底部状态条上表达进度
  showSyncBar(`正在读取${pname}…`);
  let step = '登记账号';
  try {
    const body = {
      platformId: id,
      method: 'browser',
      username: 'browser',
      storage: storageJson ?? null,
    };
    const reg = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    // 这个账号此前被用户移除过 → 不静默重建，问一次。
    // （真机踩过：移除后只要再点一次「登录平台」，账号就悄无声息地回来了）
    if (reg.removed) {
      const yes = confirm(`${pname}：这个账号此前已被你移除。\n\n是否重新添加？（会话需要仍然有效才能抓到数据）`);
      if (!yes) {
        toast(`${pname}：保持移除状态，未添加账号`, 5000);
        return;
      }
      await api('/api/login', { method: 'POST', body: JSON.stringify({ ...body, explicit: true }) });
    }
    step = '同步抓取';
    showSyncBar(`正在抓取${pname}…`);
    const r = await api('/api/sync', { method: 'POST', body: '{}' });
    step = '汇总结果';
    // 精确反馈刚登录的这个平台能不能抓 —— 而不是混在所有账号里看不出来
    const acc = (r.accounts ?? []).find((x) => x.platformId === id);
    if (acc && acc.status === 'ok') {
      showSyncBar(`${acc.label}：抓取成功，拉到 ${acc.fetched} 条（新增 ${acc.created}）`, 'done', 4000);
    } else if (acc) {
      showSyncBar(`${acc.label}：抓取失败 —— ${String(acc.message ?? '原因未知').slice(0, 300)}`, 'error', 9000);
    } else {
      showSyncBar(`读取完成：新增 ${r.totals?.created ?? 0} · 更新 ${r.totals?.updated ?? 0}`, 'done', 4000);
    }
  } catch (e) {
    // 带上「哪一步 + 错误类型 + 代码位置」：
    // 光看 message 定位不到（真机踩过：只有 Invalid string length，
    // 既不知道是登记还是同步，也不知道是哪行代码）
    const name = e && e.name ? `${e.name}: ` : '';
    const where = String(e?.stack ?? '').split('\n')[1]?.trim() ?? '';
    showSyncBar(`读取失败（${step}）：${name}${String(e?.message ?? e).slice(0, 200)}${where ? ' @ ' + where.slice(0, 90) : ''}`, 'error', 10000);
  } finally {
    await refresh();
    switchTab('todo');
  }
}

function renderMethods() {
  const p = platforms.find((x) => x.id === $('platformSelect').value);
  const sel = $('methodSelect');
  if (!p) { sel.innerHTML = ''; return; }
  sel.innerHTML = p.authMethods.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
  renderFields();
}

function renderFields() {
  const p = platforms.find((x) => x.id === $('platformSelect').value);
  const m = p?.authMethods.find((x) => x.id === $('methodSelect').value);
  $('methodHint').textContent = m?.hint ?? '';
  $('fieldArea').innerHTML = (m?.fields ?? [])
    .map((f) => `<label>${escapeHtml(f.label)}<input data-field="${escapeHtml(f.key)}" type="${f.secret ? 'password' : 'text'}" autocomplete="off"></label>`)
    .join('');
  // 「记住密码」只对账号密码登录有意义；验证码行同步隐藏（需要时由登录流程唤起）
  $('saveCredRow').classList.toggle('hidden', m?.kind !== 'password');
  if (m?.kind !== 'password') {
    $('captchaRow').classList.add('hidden');
    $('captchaInput').value = '';
  }
  // 「应用内登录」没有需要填的字段 —— 按钮直接改成它实际要做的事，
  // 避免用户点「保存」却不知道会跳走
  $('accountSave').textContent = m?.kind === 'in-app' ? '打开平台登录页' : '保存';
}

async function saveAccount() {
  const platformId = $('platformSelect').value;
  const methodId = $('methodSelect').value;
  const method = platforms.find((x) => x.id === platformId)?.authMethods.find((m) => m.id === methodId);

  // 「应用内登录」：不走表单提交，直接切到平台官方登录页。
  // 登录完成后由原生侧调 HH.returnedFromLogin 自动登记账号并抓取一次。
  // （把登录入口和添加账号合成一个动作 —— 用户只需要决定「用哪个平台、怎么登」）
  if (method?.kind === 'in-app') {
    const url = method.loginUrl;
    if (!url) {
      toast('这个平台没有配置登录页地址，请反馈', 5000);
      return;
    }
    if (window.Android?.openLogin) {
      openPlatformLogin(platformId, url);
    } else {
      // 电脑上跑时没有原生登录页 —— 说明清楚，别让它看起来没反应
      toast('「应用内登录」只在手机端可用；电脑上请在浏览器登录后用别的方式接入', 6000);
    }
    return;
  }

  const fields = {};
  document.querySelectorAll('#fieldArea input').forEach((el) => {
    if (el.value.trim()) fields[el.dataset.field] = el.value.trim();
  });

  busy(true);
  try {
    // 粘贴凭证走离线登记（不发任何网络请求）
    const isCookie = method?.kind === 'cookie-import';
    const captcha = $('captchaInput').value.trim();
    const body = isCookie
      ? { platformId, method: 'cookie-import', username: fields.username ?? 'imported', cookie: fields.cookie ?? '' }
      : {
          platformId,
          method: 'password',
          username: fields.username ?? '',
          password: fields.password ?? '',
          saveCredentials: $('saveCred').checked,
        };
    if (!isCookie && captcha) body.captcha = captcha;
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });

    // SSO 要求图形验证码：展示图片，等用户填完再点一次「保存」
    if (r.needCaptcha) {
      $('captchaRow').classList.remove('hidden');
      if (r.captchaImage) $('captchaImg').src = r.captchaImage;
      $('captchaInput').value = '';
      toast(r.error ?? '需要输入图形验证码', 5200);
      return;
    }

    $('captchaRow').classList.add('hidden');
    $('captchaInput').value = '';
    toast(r.note ?? `已添加 ${r.account.label}`);
    await refresh();
    switchTab('todo');
  } catch (e) {
    toast(`失败：${e.message}`, 4200);
  } finally {
    busy(false);
  }
}

// 点验证码图 = 换一张（重发一次不带验证码的登录即可取新图）
$('captchaImg').addEventListener('click', () => {
  $('captchaInput').value = '';
  saveAccount();
});

// ---------------------------------------------------------------- 零影响路线

async function importHar(file) {
  const platformId = $('harPlatform').value;
  const text = await file.text();
  busy(true);
  try {
    const r = await api('/api/import-har', { method: 'POST', body: JSON.stringify({ platformId, har: text }) });
    const s = r.accounts?.[0];
    toast(s ? `解析出 ${s.fetched} 条（新增 ${s.created}）` : '完成', 3600);
    await refresh();
    switchTab('todo');
  } catch (e) {
    toast(`失败：${e.message}`, 5200);
  } finally {
    busy(false);
  }
}

async function attach() {
  const platformId = $('attachPlatform').value;
  const port = Number($('attachPort').value ?? 9222);
  const match = $('attachMatch').value.trim();
  busy(true);
  try {
    const r = await api('/api/attach', { method: 'POST', body: JSON.stringify({ platformId, port, match }) });
    const s = r.accounts?.[0];
    toast(s ? `解析出 ${s.fetched} 条（新增 ${s.created}）` : '完成', 3600);
    await refresh();
    switchTab('todo');
  } catch (e) {
    toast(`失败：${e.message}`, 5200);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------- 变更 / 日志

// ---------------------------------------------------------------- 变更提示

/** 变更字段的中文名（给用户看的，不是内部字段名） */
const CHANGE_FIELD = {
  // 「新增」不是字段名，是事件名 —— 见 core 里 ChangeField 的注释
  created: '新增',
  title: '标题',
  deadline: '截止时间',
  status: '状态',
  score: '成绩',
  course: '课程',
  kind: '类型',
};

/** 「用户上次查看变更」的时间戳；点开提示条即视为已读。 */
const CHANGES_SEEN_KEY = 'hh.changesSeenAt';

/**
 * 把一条变更渲染成一行「字段：旧 → 新」。
 *
 * 值必须翻译成人话：用户看到 `2026-10-09T15:59:32.200Z` 是读不懂的
 * （真机反馈：「不知道时间里的字母是干嘛的」），
 * `submitted` 这种内部状态名同理。所以按字段类型分别格式化。
 */
function renderChangeValue(field, v) {
  if (v === null || v === undefined || v === '') return '（空）';
  if (field === 'deadline') {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : fmtLocal(String(v));
  }
  if (field === 'status') return STATUS[String(v)] || String(v);
  if (field === 'kind') return KIND[String(v)] || String(v);
  if (field === 'course') {
    // 「课程」存的是 `id|name`，用户只需要看名字
    const name = String(v).split('|')[1];
    return name || String(v);
  }
  return String(v).slice(0, 60);
}

function renderChangeRows(changes) {
  return changes
    .map((ch) => {
      // 时间戳是这一页的判断依据：没有它，用户看不出「哪条是新的」，
      // 于是明明更新了也会觉得"这页没变"。
      const atMs = new Date(ch.at).getTime();
      const at = Number.isFinite(atMs) ? `<span class="ch-time">${fmtLocal(ch.at)}</span>` : '';
      // 新增没有「旧值 → 新值」，它只有一件事：这条作业出现了
      if (ch.field === 'created') {
        return `<div class="change-field ch-new">新增「${escapeHtml(String(ch.to ?? '').slice(0, 60))}」${at}</div>`;
      }
      const label = CHANGE_FIELD[ch.field] ?? ch.field;
      const from = renderChangeValue(ch.field, ch.from);
      const to = renderChangeValue(ch.field, ch.to);
      return `<div class="change-field"><b>${escapeHtml(label)}</b>：${escapeHtml(from)} → ${escapeHtml(to)}${at}</div>`;
    })
    .join('');
}

/**
 * 作业信息变更提示。
 *
 * 为什么放在待办页最上面：截止时间被老师改了，如果用户没注意到，
 * 就会按旧时间安排 —— 这是错过作业最典型的方式。所以变更必须**主动说出来**，
 * 而不是藏在一个需要专门点进去看的页面里（「变更」页因此被改造成了课程管理）。
 *
 * 只提示「上次查看之后产生的」变更；点开查看即视为已读。
 */
async function renderChangeNotice() {
  const el = $('changeNotice');
  let changes = [];
  try {
    ({ changes } = await api('/api/changes?days=7'));
  } catch {
    el.classList.add('hidden');
    return;
  }
  const seenAt = Number(localStorage.getItem(CHANGES_SEEN_KEY) ?? 0);
  // 「新增」不进这条提示：新作业本来就会出现在待办里，它不需要被"提醒一次"。
  // 这条提示的全部价值是告诉用户「你已知的某条作业被改了」——
  // 把新增也算进来，会让每次同步到一批新作业都弹一次"信息有更新"，
  // 真正值钱的改期反而被稀释。变更历史里仍然能看到新增。
  const fresh = (changes ?? [])
    .map((c) => ({ ...c, changes: (c.changes ?? []).filter((ch) => ch.field !== 'created') }))
    .filter((c) => c.changes.some((ch) => new Date(ch.at).getTime() > seenAt));
  if (fresh.length === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.dataset.count = String(fresh.length);
  $('changeNoticeHead').innerHTML =
    `⚠ <b>${fresh.length} 条作业信息有更新</b>（截止时间 / 标题等）· 点这里展开`;
  $('changeNoticeBody').innerHTML = fresh
    .map(
      (c) => `<div class="change-item"><b>${escapeHtml(c.title)}</b>
        <div class="muted">${escapeHtml(c.courseName)}</div>${renderChangeRows(c.changes)}</div>`,
    )
    .join('');
  $('changeNoticeBody').classList.add('hidden');
}

// ---------------------------------------------------------------- 会话保活

/**
 * 「会话保活」卡片（只挂在日志页）。
 *
 * 为什么要把一个后台机制摆在用户面前：它会在 App **没打开**的时候定时发请求 ——
 * 一个用户看不见却真在发生的行为，必须能被看见、也必须能被关掉，
 * 否则它就成了"偷偷在后台跑的东西"。
 *
 * 顺带它也是这个问题（登录到底能维持多久）的证据面板：
 * 每次探测的时刻与结果都列在这里，几条之后就能看出该平台凭据的寿命区间。
 */
/**
 * 后台保活卡片（在「账号」页）。
 *
 * 为什么放账号页而不是日志页：它是一件「我需要为自己的账号做的事」——
 * 和「一键重登」同一个心智模型（我在维持这个账号能不能用）；
 * 而日志页的心智是"出过什么事"，一张常驻配置卡混在时间流水里是异物。
 *
 * 为什么它还要带一段说明：保活只在**系统放行后台联网**时才有意义。
 * 真机定位了四天，最后是 realme UI 的设备级「睡眠待机优化」在夜里掐网
 * （它不在 Doze 体系里，电池优化白名单与前台服务都管不到它）；关掉之后
 * 夜里那段 5.5 小时的黑洞立刻消失（未测成从 11 次降到 1 次，会话 22.8 小时没掉）。
 * 所以这里要告诉用户去哪里放行 —— 而且**只在真出问题时才大声说**。
 *
 * 时间轴条与两个判决数（会话断在这里 / 最长连续不可达）已按预案删除：
 * 结论已经拿到，它们只剩噪音。保留的「最近 5 条」是保活在跑的凭证，属于保活功能本身。
 */
async function renderKeepAlive() {
  const host = $('keepAliveCard');
  if (!host) return;
  const bridge = window.Android;
  if (!bridge?.keepAliveState) {
    host.innerHTML = '';
    return;
  }
  let st = null;
  try {
    st = JSON.parse(bridge.keepAliveState());
  } catch {
    st = null;
  }
  if (!st) {
    host.innerHTML = '';
    return;
  }

  const log = Array.isArray(st.log) ? st.log : [];
  const probes = Number(st.probeCount ?? 0);
  // 三类结果必须分得开（真机踩过：17 次 DNS 解析失败被显示成「会话失效 17 次」）。
  // 兼容只有 ok 字段的旧记录。
  const kindOf = (e) => (e && typeof e.kind === 'string' ? e.kind : e && e.ok !== false ? 'ok' : 'auth');
  const sessionFailures = Number(st.sessionFailures ?? log.filter((e) => kindOf(e) === 'auth').length);
  const unreachable = Number(st.unreachable ?? log.filter((e) => kindOf(e) === 'unreachable').length);
  const intervalMin = Math.max(1, Math.round(Number(st.intervalMs ?? 0) / 60000));
  const nextAt = Number(st.nextAtMs ?? 0);
  const tOf = (ms) => fmtLocal(new Date(Number(ms)).toISOString());

  // 一级行的摘要：**只说这里能设置的东西**。
  // 这三行的蓝字是并列的"当前值"：提醒密度=标准 / 每日汇总=每天 08:00 / 保活=已开启。
  // 所以这里不能写"每 30 分钟一次" —— 频率不可调，写上去会被读成一个可设置的选项。
  // （频率仍然在卡片内部显示，那是说明，不是设置。）
  const kaSum = $('kaSummary');
  if (kaSum) {
    kaSum.textContent = st.enabled === false ? '已关闭' : probes === 0 ? '不适用' : '已开启';
  }

  const stat =
    probes === 0
      ? '当前没有需要保活的平台（只对 iSmart 这类服务端会话的平台启用）。'
      : `已探测 ${log.length} 次 · 会话失效 ${sessionFailures} 次` +
        (unreachable > 0 ? ` · 未测成 ${unreachable} 次` : '') +
        ` · 每 ${intervalMin} 分钟一次` +
        (nextAt > Date.now() ? ` · 下次 ${tOf(nextAt)}` : '');

  // 电池优化白名单：它和应用级的「自启动 / 允许后台运行 / 不优化耗电」是**两套机制**
  // （真机上那几个开关全部放行，夜里请求仍然发不出去）。
  let batteryRow = '';
  try {
    const exempt = bridge.batteryOptimizationStatus?.() ?? 'unknown';
    if (exempt === 'denied') {
      batteryRow = `<div class="ka-action">
        <span class="ka-bad">尚未豁免电池优化</span>
        <button class="ka-btn" id="kaBattery">加入白名单</button>
      </div>
      <div class="ka-hint">为什么需要它：息屏久了系统会限制后台网络，那段空档里一个请求都发不出去，会话就会闲置过期 —— 这不是账号问题。</div>`;
    } else if (exempt === 'granted') {
      batteryRow = `<div class="ka-action"><span class="ka-ok">已豁免电池优化</span></div>`;
    }
  } catch {
    // 问不到就不显示 —— 不猜
  }

  // 只在真的出事时才亮出「去哪里放行」的长说明；平时一句小字带过，避免卡片变成公告栏。
  const naRecent = log.slice(-12).filter((e) => kindOf(e) === 'unreachable').length;
  const tip =
    naRecent >= 3
      ? `<div class="ka-tip warn">
          <b>最近 12 次探测里有 ${naRecent} 次「未测成」—— 手机可能在你不用它时掐了本应用的网络。</b>
          保活要生效，需要系统放行后台联网：关掉「睡眠待机优化 / 息屏断网」这类开关
          （realme / OPPO 在 设置 → 电池 → 省电设置 → 其他设置），并确认已加入电池优化白名单。
        </div>`
      : `<div class="ka-tip">它只在系统放行后台联网时才有效。真出现「未测成」时，这里会提示去哪里放行。</div>`;

  const rows = log
    .slice(-5)
    .reverse()
    .map((e) => {
      const t = e && e.t ? tOf(Number(e.t)) : '';
      const kind = kindOf(e);
      const label = kind === 'ok' ? '会话正常' : kind === 'auth' ? '会话失效' : '未测成：网络不通';
      const cls = kind === 'ok' ? 'ka-ok' : kind === 'auth' ? 'ka-bad' : 'ka-warn';
      const detail =
        kind === 'ok'
          ? ''
          : [e?.status ? `HTTP ${e.status}` : '', e?.note ?? ''].filter(Boolean).join(' · ');
      return `<div class="ka-row">
        <span>${escapeHtml(t)}</span>
        <span class="${cls}">${escapeHtml(label)}</span>
        <span class="muted">${escapeHtml(detail)}</span>
      </div>`;
    })
    .join('');

  host.innerHTML = `<div class="card ka-card">
    <div class="ka-head">
      <label class="ka-switch">
        <input type="checkbox" id="kaToggle" ${st.enabled ? 'checked' : ''}>
        <span>${st.enabled ? '已开启' : '已关闭'}</span>
      </label>
    </div>
    <div class="muted">每 ${intervalMin} 分钟发 1 个只读探活请求，
      让 iSmart 的登录不会因为长时间没有请求而失效。关掉后不再有任何后台请求。</div>
    <div class="ka-stat">${escapeHtml(stat)}</div>
    ${batteryRow}
    <div class="ka-action"><button class="ka-btn" id="kaSysSettings">打开电池设置</button></div>
    ${tip}
    ${rows}
  </div>`;

  $('kaBattery')?.addEventListener('click', () => {
    try {
      bridge.requestIgnoreBatteryOptimizations?.();
    } catch (e) {
      toast(`打不开系统设置：${e.message}`);
    }
  });

  $('kaSysSettings')?.addEventListener('click', () => {
    try {
      bridge.openBatterySettings?.();
    } catch (e) {
      toast(`打不开系统设置：${e.message}`);
    }
  });

  const toggle = $('kaToggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      try {
        bridge.setKeepAliveEnabled?.(toggle.checked);
        toast(toggle.checked ? '已开启后台保活' : '已关闭后台保活，不再有后台请求');
      } catch (e) {
        toast(`设置失败：${e.message}`);
      }
      renderKeepAlive().catch(() => {});
    });
  }
}

/* ────────────────────────────────────────── 设置（功能开关为一级目录）
 *
 * 一级 = **功能清单**：每行一个功能名 + 它当前的值。
 * 这样用户扫一眼就知道这个 App 有哪些能力、现在各是什么状态；
 * 而"默认全部展开"会把设置页变成一堵墙，反而看不出有哪些功能。
 * 二级 = 展开后的具体选项 + 为什么这么设计（就地解释，比一份说明书有用）。
 *
 * 展开状态记在内存里：改一项设置会重渲染整页，不记住的话
 * 刚展开的那一栏会立刻自己合上 —— 用户会以为"点了没反应"。
 */
const setOpen = new Set();

/** 小时数 → 人话：能整除 24 就说天（72 小时 → 3 天）。预设与摘要共用。 */
function fmtHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return '?';
  return n >= 24 && n % 24 === 0 ? `${n / 24} 天` : `${n} 小时`;
}

/**
 * 「数字 + 单位」输入组。存的一律是**小时**，显示时自动挑更合适的单位 ——
 * 用户输入 1 天，下次打开看到的还是 1 天，而不是 24 小时。
 */
function numUnit(id, hours) {
  const n = Number(hours);
  const useDay = n >= 24 && n % 24 === 0;
  const val = useDay ? n / 24 : n;
  return `<input type="number" id="${id}" min="1" max="720" value="${val}">
    <select id="${id}Unit">
      <option value="h"${useDay ? '' : ' selected'}>小时</option>
      <option value="d"${useDay ? ' selected' : ''}>天</option>
    </select>`;
}

/** 读一个「数字 + 单位」组合，统一换成小时。 */
function readHours(id) {
  const n = Number($(id)?.value);
  const u = $(id + 'Unit')?.value ?? 'h';
  return Math.max(1, (Number.isFinite(n) ? Math.round(n) : 1) * (u === 'd' ? 24 : 1));
}

/** 预设的缓存（由 renderSettings 填入）——预设定义只在后端有一份。 */
let presetCache = {};

/**
 * 点预设：把两类的区间一次性填好。
 * 它**只是预填**，填完仍然可以改 —— 预设的价值是"这组频率是合理的"，
 * 不是"你只能从这三档里选"。
 */
function applyPreset(level) {
  const p = presetCache[level];
  if (!p) return;
  saveSettings({ level, task: p.task, exam: p.exam });
}

/** 读输入框 → 两份 spec。「最后提醒」和「次数」两类共用。 */
function saveSpec() {
  const firstTask = readHours('specTaskFirst');
  const firstExam = readHours('specExamFirst');
  const last = readHours('specLast');
  const times = Math.max(1, Math.min(3, Number($('specTimes')?.value) || 1));
  saveSettings({
    task: { firstHours: firstTask, lastHours: last, times },
    exam: { firstHours: firstExam, lastHours: last, times },
  });
}

async function renderSettings() {
  const host = $('settingsList');
  let data;
  try {
    data = await api('/api/settings');
  } catch (e) {
    host.innerHTML = `<div class="card muted">读取设置失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  const s = data.settings ?? {};
  const presets = data.presets ?? {};
  const labels = data.levelLabels ?? {};
  const minGap = Number(data.minGapHours ?? 1);
  const opened = (k) => (setOpen.has(k) ? ' open' : '');
  const dailyOn = s.daily !== false;
  presetCache = presets;

  const task = s.task ?? { firstHours: 24, lastHours: 12, times: 2 };
  const exam = s.exam ?? { firstHours: 72, lastHours: 24, times: 2 };
  // 「最后提醒」和「提醒次数」是两类**共用**的（否则就是 6 个输入框），
  // 所以护栏上限取两边更紧的那个 —— 不然会出现"作业能 3 次、考试只能 2 次"的歧义。
  const maxTask = Math.floor((task.firstHours - task.lastHours) / minGap) + 1;
  const maxExam = Math.floor((exam.firstHours - exam.lastHours) / minGap) + 1;
  const maxTimes = Math.max(1, Math.min(maxTask, maxExam));
  const softWarn =
    maxTimes <= task.times && task.times >= 3
      ? '<b class="spec-warn">区间偏窄：这个跨度里 3 次提醒效果有限，把「首次提醒」提前一些更合理。</b>'
      : '';

  host.innerHTML = `
    <details class="set-item" data-set="level"${opened('level')}>
      <summary>
        <span class="set-name">提醒密度</span>
        <span class="set-now">作业 ${fmtHours(task.firstHours)}起 · ${task.times} 次</span>
      </summary>
      <div class="set-body">
        <p class="muted">从什么时候开始提醒、到什么时候结束，中间提醒几次。改完立刻重新排期。</p>

        <div class="seg">
          ${Object.keys(presets)
            .map(
              (k) => `<button class="seg-btn" data-preset="${escapeHtml(k)}">
                <b>${escapeHtml(labels[k] ?? k)}</b>
                <span>作业 ${fmtHours(presets[k].task.firstHours)}起 · ${presets[k].task.times} 次</span>
                <span>考试 ${fmtHours(presets[k].exam.firstHours)}起 · ${presets[k].exam.times} 次</span>
              </button>`,
            )
            .join('')}
        </div>

        <div class="spec-row">
          <span class="spec-label">首次提醒 · 作业</span>
          <span class="num-unit">${numUnit('specTaskFirst', task.firstHours)}</span>
        </div>
        <div class="spec-row">
          <span class="spec-label">首次提醒 · 考试</span>
          <span class="num-unit">${numUnit('specExamFirst', exam.firstHours)}</span>
        </div>
        <div class="spec-row">
          <span class="spec-label">最后提醒</span>
          <span class="num-unit">${numUnit('specLast', task.lastHours)}</span>
        </div>
        <div class="spec-row">
          <span class="spec-label">提醒次数</span>
          <span class="num-unit">
            <input type="number" id="specTimes" min="1" max="${maxTimes}" value="${task.times}"> 次
          </span>
        </div>

        <p class="muted">
          按当前区间：作业最多 ${maxTask} 次、考试最多 ${maxExam} 次（相邻至少隔 ${minGap} 小时）。
          ${softWarn}
        </p>
        <p class="muted">上限 3 次不是为了省电 —— 手机系统会按"你多久打开一次 App"限制提醒次数
          （最严时每天只允许 1 条）。给一个系统做不到的密度等于给一个假承诺。</p>
      </div>
    </details>

    <details class="set-item" data-set="daily"${opened('daily')}>
      <summary>
        <span class="set-name">每日汇总</span>
        <span class="set-now">${dailyOn ? `每天 ${String(s.dailyHour).padStart(2, '0')}:00` : '已关闭'}</span>
      </summary>
      <div class="set-body">
        <p class="muted">每天一条，说清你手上还有多少作业、数据是哪天的。
          <b>它是最可能送达的那条</b>：一天只占一个配额，所以即使系统限制到最严也能到。</p>
        <label class="set-row">
          <input type="checkbox" id="setDailyOn"${dailyOn ? ' checked' : ''}>
          <span>开启每日汇总</span>
        </label>
        <label class="set-row">发送时间
          <input type="number" id="setDailyHour" min="0" max="23" value="${Number(s.dailyHour)}"> 点
        </label>
        <label class="set-row">覆盖天数
          <input type="number" id="setDailyDays" min="1" max="14" value="${Number(s.dailyDays)}"> 天
        </label>
        <p class="muted">排期只在**同步那一刻**算一次。所以越靠后的那几条数据越旧 ——
          它们会自己标明"数据截至 X 日"并提示你去同步，不会假装自己是最新的。</p>
      </div>
    </details>

    <details class="set-item" data-set="keepalive"${opened('keepalive')}>
      <summary>
        <span class="set-name">后台保活</span>
        <span class="set-now" id="kaSummary"></span>
      </summary>
      <div class="set-body" id="keepAliveCard"></div>
    </details>`;

  // toggle 事件**不冒泡**，所以只能逐个绑定（委托接不到）
  host.querySelectorAll('details[data-set]').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) setOpen.add(d.dataset.set);
      else setOpen.delete(d.dataset.set);
    });
  });

  await renderKeepAlive().catch(() => {});
}

/** 保存设置。后端返回归一化之后的值，重渲染时以它为准。 */
async function saveSettings(patch) {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    await renderSettings();
    toast('已保存，提醒已重新排期');
  } catch (e) {
    toast(`保存失败：${e.message}`, 5000);
  }
}

// 添加平台（实验）：把提示词交给原生，原生负责注入记录器并导出证据包。
// 提示词由后端提供（单一真源），不在这里硬编码 —— 两份必然漂移。
$('startCapture').addEventListener('click', async () => {
  if (!window.Android?.openCapture) {
    toast('这个功能目前只在 Android 应用里可用', 5000);
    return;
  }
  try {
    const r = await api('/api/adapter/prompt');
    window.Android.openCapture(r.prompt || '');
  } catch (e) {
    toast(`取提示词失败：${e.message}`, 5000);
  }
});

// 把 AI 的回复粘回来 → 导入成作业。
// 为什么这里不"校验格式后拒绝"：真实测试里手机端 AI 给的是**作业数据**而不是接入配置，
// 直接拒绝会让用户卡死。两种都收：数据能导入就导入，配置先认下来并说明还不能用。
$('doImport').addEventListener('click', async () => {
  const text = $('importBox').value.trim();
  if (!text) {
    toast('先粘贴 AI 的回复');
    return;
  }
  busy(true);
  try {
    const r = await api('/api/adapter/import', { method: 'POST', body: JSON.stringify({ text }) });
    if (r.ok) {
      const bits = [`已导入 ${r.created} 条作业`];
      if (r.done) bits.push(`其中 ${r.done} 条标为已完成`);
      if (r.skipped) bits.push(`跳过 ${r.skipped} 条重复`);
      $('importResult').textContent = bits.join('，');
      $('importBox').value = '';
      await refresh();
    } else {
      $('importResult').textContent = r.error || '没能识别这段回复';
    }
  } catch (e) {
    $('importResult').textContent = `导入失败：${e.message}`;
  } finally {
    busy(false);
  }
});

$('settingsList').addEventListener('click', (e) => {
  const presetBtn = e.target.closest('[data-preset]');
  if (presetBtn) applyPreset(presetBtn.dataset.preset);
});
$('settingsList').addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'setDailyOn') saveSettings({ daily: e.target.checked });
  else if (id === 'setDailyHour') saveSettings({ dailyHour: Number(e.target.value) });
  else if (id === 'setDailyDays') saveSettings({ dailyDays: Number(e.target.value) });
  // 区间输入（含单位下拉，id 都以 spec 开头）
  else if (id.startsWith('spec')) saveSpec();
});

async function renderLog() {
  const { log } = await api('/api/log');
  if (log.length === 0) {
    $('logList').innerHTML = `<div class="card muted">还没有同步记录。</div>`;
    return;
  }
  $('logList').innerHTML = log
    .map((e) => {
      const status = e.status ?? 'unknown';
      const secs = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '';
      const stats = [
        e.requests !== undefined ? `请求 ${e.requests}` : '',
        e.retries > 0 ? `重试 ${e.retries}` : '',
        secs ? `耗时 ${secs}` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="log-item">
        <div class="head"><span>${fmtLocal(e.finishedAt)}</span><span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span></div>
        <div>${escapeHtml(e.platformId)} · 拉取 ${e.fetched} · 新增 ${e.created} · 更新 ${e.updated} · 删除 ${e.removed}</div>
        ${stats ? `<div class="muted">${stats}</div>` : ''}
        ${e.message ? `<div class="muted">${escapeHtml(e.message)}</div>` : ''}
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- 主流程

async function refresh() {
  const state = await api('/api/state');
  currentState = state;
  platforms = state.platforms ?? [];

  const counts = state.counts ?? {};
  const syncing = state.syncing === true;
  // 刻意不在 refresh 里弹全屏遮罩 —— 后台同步（自动触发 / 原生返回触发）
  // 不该打断用户，他照常看列表就行。遮罩只由「用户主动点同步」负责显示。
  // 同步状态改在标题栏用一行小字表达。
  // 副标题里的「待办 N」只数还没交完的；已交完的单独报一个数，
  // 否则两个人群看到的是同一个会撒谎的数字。
  const pendingAcN = counts.pendingAc ?? 0;
  const todoN = Math.max(0, (counts.total ?? 0) - pendingAcN);
  const countSuffix = pendingAcN > 0 ? ` · 待办 ${todoN} · 已交 ${pendingAcN}` : ` · 待办 ${todoN}`;
  $('subtitle').textContent = syncing
    ? '正在更新…'
    : state.lastSyncAt
      ? `上次同步 ${fmtLocal(state.lastSyncAt)}${countSuffix}`
      : '尚未同步 · 先添加账号';

  renderTodo(state);
  renderDone(state);
  renderAccounts(state);
  renderPlatformOptions();

  // 与后端状态对齐：别处触发的同步（例如原生侧调 syncNow）也要能看到进度；
  // 它结束了就把状态条收起来。本地同步进行中时不动它（由 doSync 负责收尾）。
  if (!syncing) {
    if (state.syncing === true && syncBarKind === 'idle') showSyncBar('正在同步…');
    else if (state.syncing !== true && syncBarKind === 'running') hideSyncBar();
  }

  // 变更提示与具体的 tab 无关（它挂在待办页顶部），每次刷新都重新算一次
  await renderChangeNotice();

  // 设置页里那两块（保活 / 日志）不会随 refresh() 自己更新（它们按需渲染）。
  // 于是会出现：同步已经跑完、标题的"上次同步"都变了，日志列表还停在旧数据上 ——
  // 真机踩过，我据此误判成"App 内探测没在跑"，白查了一轮。
  // 停在设置页时，刷新就顺手把它们一起重渲染。
  if (activeTab() === 'settings') await renderKeepAlive().catch(() => {});
  // 记录页的三段都是按需渲染的，停在那一页时刷新也顺手更新
  if (activeTab() === 'done') {
    if (recordSeg === 'changes') await renderChanges().catch(() => {});
    if (recordSeg === 'synclog') await renderLog().catch(() => {});
  }
}

/** 当前停在哪个 tab（决定同步/刷新结束后要不要把该 tab 的内容也重渲染）。 */
function activeTab() {
  const active = document.querySelector('.tab-panel.active');
  return active ? active.id.replace(/^tab-/, '') : '';
}

/**
 * 同步。
 *
 * **所有入口（手动点按钮、自动限频、账号重登后）都走这里，行为完全一致**：
 * 不弹全屏遮罩，只在底部常驻状态条上表达进度与结果。
 * 以前手动同步会锁住整个界面、自动同步不会 —— 同一个动作两种体验，
 * 用户只能靠「这次有没有被挡住」来猜是谁在同步。
 */
async function doSync() {
  if (syncing) return;
  syncing = true;
  syncBarStartedAt = Date.now();
  showSyncBar('正在同步…');
  // 计时：同步可能十几二十秒，让用户看得出它确实在跑，而不是卡住了
  const tick = setInterval(() => {
    if (syncBarKind === 'running') {
      showSyncBar(`正在同步… ${Math.round((Date.now() - syncBarStartedAt) / 1000)} 秒`);
    }
  }, 1000);
  try {
    const r = await api('/api/sync', { method: 'POST', body: '{}' });
    const all = r.totals?.accounts ?? 0;
    const okN = r.totals?.ok ?? 0;
    const bad = (r.accounts ?? []).filter((a) => a.status !== 'ok');
    if (all === 0) {
      showSyncBar('没有可同步的账号，先去「账号」页添加', 'error', 6000);
    } else if (bad.length > 0) {
      // 同步可以安静地成功，但绝不安静地失败
      const names = bad.map((b) => b.label).join('、');
      showSyncBar(`同步 ${all} 个账号：${okN} 成功 · ${bad.length} 失败（${names}）—— 详情见日志`, 'error', 9000);
    } else {
      showSyncBar(
        `同步完成 · ${all} 个账号 · 新增 ${r.totals.created} · 更新 ${r.totals.updated}`,
        'done',
        3500,
      );
    }
    // 变更比「同步成功」重要得多：同步成功了但漏看一次改期，照样会错过作业。
    // 所以只要还有未读变更，就再明确说一次（提示条在待办页，用户可能停在别的 tab）。
    if (all > 0) {
      const notice = $('changeNotice');
      if (notice && !notice.classList.contains('hidden')) {
        toast(`${notice.dataset.count ?? ''} 条作业信息有更新（截止时间/标题等）—— 待办页顶部可展开`, 9000);
      }
    }
  } catch (e) {
    showSyncBar(`同步失败：${e.message}`, 'error', 9000);
  } finally {
    clearInterval(tick);
    syncing = false;
    await refresh();
  }
}

// ---------------------------------------------------------------- 自动同步

/**
 * 自动同步的限频间隔。
 *
 * 30 分钟：老师发的随堂测验可能只开几小时，间隔太长会错过；
 * 而这个频率的实际请求量（约 3800 个只读请求/天，平均 22 秒一个）
 * 远低于会触发风控的量级 —— 平台风控主要盯登录与提交类操作。
 */
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** 距上次同步是否已经超过限频间隔。 */
function autoSyncDue() {
  const last = currentState?.lastSyncAt ? new Date(currentState.lastSyncAt).getTime() : 0;
  if (!last) return true; // 从没同步过 → 立刻同步一次
  return Date.now() - last >= AUTO_SYNC_INTERVAL_MS;
}

/**
 * 打开 App / 切回前台时调用：到点了就静默同步一次。
 *
 * 只在手机端自动（桌面端跑的是开发环境，不该自动刷平台接口）。
 * 手动点同步按钮不受这里限制 —— 那是用户的明确意图。
 */
function maybeAutoSync() {
  if (window.__HH_PLATFORM !== 'android') return;
  if (syncing || currentState?.syncing === true) return;
  if (!autoSyncDue()) return;
  doSync();
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  // 「添加待办」只属于待办页 —— 它浮在所有内容之上，留在别的页面会挡住东西
  $('addTaskEntry').classList.toggle('hidden', name !== 'todo');
  if (name === 'courses') renderCourses().catch((e) => toast(e.message));
  if (name === 'done') switchRecordSeg(recordSeg);
  if (name === 'settings') {
    // 保活是**全局配置**，所以它归设置页（先前在账号页）——
    // 一个账号都没有时它也必须可见（"后台有没有在发请求"不能因为列表空就被藏起来）
    renderSettings().catch((e) => toast(e.message));
    renderLog().catch((e) => toast(e.message));
  }
}

// ---------------------------------------------------------------- 事件

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});
/**
 * 二次点按确认的删除。
 * 不用 confirm()：WebView 里它默认不弹（真机踩过——按钮点了没反应），
 * 而且两步点按在手机上比弹窗更顺手。第一次点变红显示「确认？」，4 秒内再点执行。
 */
function tapToDelete(btn, armedText, onConfirm) {
  if (btn.dataset.armed === '1') {
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.orig;
    delete btn.dataset.armed;
    onConfirm();
    return;
  }
  // 先解除其它处于待确认状态的按钮
  document.querySelectorAll('.del-btn.armed').forEach((b) => {
    if (b !== btn) {
      b.classList.remove('armed');
      b.textContent = b.dataset.orig;
      delete b.dataset.armed;
    }
  });
  btn.dataset.orig = btn.textContent;
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = armedText;
  setTimeout(() => {
    if (btn.dataset.armed === '1') {
      btn.classList.remove('armed');
      btn.textContent = btn.dataset.orig;
      delete btn.dataset.armed;
    }
  }, 4000);
}

/* ───────────────────────────────────────────── 单条任务的处理菜单
 *
 * 为什么把「删除」从任务条上撤掉、并把三个动作收进一个菜单（用户 2026-10-18 的方案）：
 *   1. 逐条删除和「课程栏取消勾选整门课」是重复的 —— 后者更省事，前者留着只会被误点
 *   2. 「不用交」以前根本没有入口：平台说 pending 时手动完成被压制，
 *      用户唯一能做的是删掉，而删掉之后记录里就查不到了（典型：小组作业由组长交）
 *   3. 三个动作本来就是一回事（"对这条作业，我打算怎么处理"），收在一处符合直觉
 *
 * 代价是"标记完成"从一键变成两步 —— 接受：标完成本来就是个确认动作
 * （确认自己真的交了），多一步反而少误标。
 */
let menuTaskId = null;

/** 从当前数据里找一条任务（两栏都要查：待办 / 记录）。 */
function findTaskById(id) {
  const g = lastState?.grouped ?? {};
  for (const k of Object.keys(g)) {
    const hit = (g[k] ?? []).find((t) => t.id === id);
    if (hit) return hit;
  }
  return (lastState?.completed ?? []).find((t) => t.id === id) ?? null;
}

function openTaskMenu(taskId) {
  const t = findTaskById(taskId);
  if (!t) return;
  menuTaskId = taskId;
  $('taskMenuTitle').textContent = `${t.courseName} · ${t.title}`;

  // 「已完成」可能不可用（平台明确说未完成）。**置灰但仍然显示** ——
  // 藏起来会让用户以为"这 App 没这个功能"；显示 + 说明才能让他懂为什么，
  // 而且顺手把他引到「不用交」这条正确的路上。
  const btn = $('menuComplete');
  const ok = Boolean(t.canManualComplete);
  btn.disabled = !ok;
  $('menuCompleteHint').textContent = ok
    ? '只改本机记录，不会向平台提交任何东西'
    : '平台显示未完成 —— 按「平台优先」以平台为准。如果你只是不用交这条，选下面的「不用交」';
  $('taskMenu').classList.remove('hidden');
}

function closeTaskMenu() {
  $('taskMenu').classList.add('hidden');
  menuTaskId = null;
}

async function markSkipped(taskId, skipped) {
  busy(true);
  try {
    await api('/api/task/skip', { method: 'POST', body: JSON.stringify({ taskId, skipped }) });
    toast(skipped ? '已标为「不用交」，它不会再提醒你' : '已撤销');
    await refresh();
  } catch (err) {
    toast(`操作失败：${err.message}`, 5000);
  } finally {
    busy(false);
  }
}

async function doDeleteTask(taskId) {
  busy(true);
  try {
    await api('/api/task/delete', { method: 'POST', body: JSON.stringify({ taskId }) });
    toast('已删除');
    await refresh();
  } catch (err) {
    toast(`删除失败：${err.message}`, 5000);
  } finally {
    busy(false);
  }
}

$('taskMenu').addEventListener('click', (e) => {
  if (e.target.closest('[data-menu-close]')) {
    closeTaskMenu();
    return;
  }
  const act = e.target.closest('[data-menu-act]')?.dataset.menuAct;
  const id = menuTaskId;
  if (!act || !id) return;
  // 先把菜单关掉再动手：动作失败时 toast 才有地方显示（菜单盖着屏幕底部）
  closeTaskMenu();
  if (act === 'complete') markCompleted(id, true);
  else if (act === 'skip') markSkipped(id, true);
  else if (act === 'delete') doDeleteTask(id);
});

$('todoList').addEventListener('click', async (e) => {
  // 作业名 → 去平台看。放在最前面拦截：不然 WebView 会按 <a> 的默认行为处理，
  // 而那个行为在 WebView 里要么开新窗口、要么什么都不做。
  const openLink = e.target.closest('a[data-open-url]');
  if (openLink) {
    e.preventDefault();
    openTaskExternally(openLink.dataset.openUrl);
    return;
  }
  const tag = e.target.closest('.course-tag');
  if (tag) {
    // 点课程名 = 只看这门课。完整课程名改由**筛选条**显示，
    // 所以这里不再另外弹 toast —— 两个反馈同时出现会互相打断。
    const id = tag.dataset.courseId;
    if (!id) return;
    // 再点一次 = 取消。判定用 id：同名的两门课互不影响。
    const next = courseFilter.todo?.id === id ? null : { id, label: tag.textContent.trim() };
    if (next) applyCourseFilter('todo', next);
    else clearCourseFilter('todo');
    return;
  }
  const menuBtn = e.target.closest('button[data-menu-task]');
  if (menuBtn) {
    openTaskMenu(menuBtn.dataset.menuTask);
    return;
  }
  const detailBtn = e.target.closest('button[data-detail-task]');
  if (detailBtn) {
    openTaskDetail(detailBtn.dataset.detailTask);
    return;
  }
});
$('doneList').addEventListener('click', (e) => {
  const openLink = e.target.closest('a[data-open-url]');
  if (openLink) {
    e.preventDefault();
    openTaskExternally(openLink.dataset.openUrl);
    return;
  }
  const tag = e.target.closest('.course-tag');
  if (tag) {
    // 与待办页同一套交互：点课程名 = 只看这门课（两边各自记账，互不影响）。
    // 完整课程名由筛选条显示，所以这里不再弹 toast。
    const id = tag.dataset.courseId;
    if (!id) return;
    const next = courseFilter.done?.id === id ? null : { id, label: tag.textContent.trim() };
    if (next) applyCourseFilter('done', next);
    else clearCourseFilter('done');
    return;
  }
  // 已完成里的进度条同样可点开看每题（全 AC 之后仍然会想知道"哪几题拿了多少分"）
  const detailBtn = e.target.closest('button[data-detail-task]');
  if (detailBtn) {
    openTaskDetail(detailBtn.dataset.detailTask);
    return;
  }
  const undoSkip = e.target.closest('button[data-undo-skip]');  if (undoSkip) {
    markSkipped(undoSkip.dataset.undoSkip, false);
    return;
  }
  const undo = e.target.closest('button[data-undone-task]');
  if (undo) markCompleted(undo.dataset.undoneTask, false);
});

/**
 * 手动标记 / 撤销「已完成」。
 *
 * 它只改本机记录，**不给平台发任何东西**（这个应用始终只读）。
 * 平台明确说"未完成"时，按「平台优先」不会生效 —— 那时必须把原因说出来，
 * 而不是让按钮看起来没反应。
 */
async function markCompleted(taskId, completed) {
  busy(true);
  try {
    const r = await api('/api/task/complete', {
      method: 'POST',
      body: JSON.stringify({ taskId, completed }),
    });
    if (completed && r && r.applied === false) {
      toast('已在 待办 里保留平台状态：平台明确显示这条「未完成」，按「平台优先」以平台为准', 5200);
    } else {
      toast(completed ? '已标记完成（仅本机）' : '已撤销标记');
    }
    await refresh();
  } catch (err) {
    toast(`${completed ? '标记' : '撤销'}失败：${err.message}`, 5000);
  } finally {
    busy(false);
  }
}
$('syncBtn').addEventListener('click', () => doSync());
$('platformSelect').addEventListener('change', renderMethods);
$('methodSelect').addEventListener('change', renderFields);
$('accountSave').addEventListener('click', saveAccount);
$('harImport').addEventListener('click', () => {
  const f = $('harFile').files?.[0];
  if (!f) return toast('先选择 HAR 文件');
  importHar(f);
});
$('attachGo').addEventListener('click', attach);
$('changeNoticeHead').addEventListener('click', () => {
  const body = $('changeNoticeBody');
  const opening = body.classList.contains('hidden');
  body.classList.toggle('hidden', !opening);
  // 展开即视为「已查看」—— 同一批变更不再重复提醒
  if (opening) localStorage.setItem(CHANGES_SEEN_KEY, String(Date.now()));
});
// 课程行的两个小按钮：改名 / 把同名手工任务归并进来。
// 放在 change 事件之前用 click 拦，避免和勾选（label）冲突。
$('courseList').addEventListener('click', (e) => {
  const ren = e.target.closest('button[data-rename-course]');
  if (ren) {
    e.preventDefault();
    openRenameSheet(ren.dataset.renameCourse, ren.dataset.renameCur || '');
    return;
  }
});

$('renameCancel').addEventListener('click', () => {
  renameTarget = null;
  closeOverlay($('renameSheet'));
});
$('renameSave').addEventListener('click', saveRename);
// 恢复平台原名：不用让用户"清空输入框再保存"去猜 —— 给一个明确的按钮。
$('renameReset').addEventListener('click', async () => {
  if (!renameTarget) return;
  try {
    await api('/api/course/rename', {
      method: 'POST',
      body: JSON.stringify({ courseId: renameTarget.courseId, name: '' }),
    });
    closeOverlay($('renameSheet'));
    renameTarget = null;
    toast('已恢复平台原名');
    await refresh();
    await renderCourses();
  } catch (e) {
    toast(`恢复失败：${e.message}`, 5000);
  }
});

$('courseList').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-mute-course]');
  if (!cb) return;
  const muted = !cb.checked;
  busy(true);
  try {
    await api('/api/course/mute', {
      method: 'POST',
      body: JSON.stringify({
        accountId: cb.dataset.muteAccount,
        courseId: cb.dataset.muteCourse,
        muted,
      }),
    });
    toast(muted ? '已跳过这门课程（已有记录保留）' : '已恢复同步这门课程');
  } catch (err) {
    cb.checked = !cb.checked; // 失败回滚，别让界面说谎
    toast(`设置失败：${err.message}`, 4200);
  } finally {
    busy(false);
  }
});
$('accountList').addEventListener('click', async (e) => {
  // 「一键重登」：直接切到该平台的官方登录页。
  // 走的是和应用内登录完全相同的那条路（同一个 WebView / 同一份 CookieManager），
  // 所以平台上记住的账号密码、验证码偏好都会自己带出来 —— 通常只要输一次验证码。
  const relogin = e.target.closest('button[data-relogin]');
  if (relogin) {
    const pid = relogin.dataset.relogin;
    const pname = platforms.find((p) => p.id === pid)?.displayName ?? pid;
    if (!window.Android?.openLogin) {
      toast('「一键重登」只在手机端可用；电脑上请在浏览器登录后用别的方式接入', 6000);
      return;
    }
    showSyncBar(`正在打开${pname}登录页…`, 'running', 3000);
    openPlatformLogin(pid, relogin.dataset.loginUrl);
    return;
  }

  const btn = e.target.closest('button[data-remove]');
  if (!btn) return;
  if (!confirm('移除该账号？\n\n会话与本平台的记录会一并删除。之后即使再从平台页返回，也不会自动把它加回来（要重新添加时会先问你一次）。')) return;
  busy(true);
  try {
    await api('/api/account/remove', { method: 'POST', body: JSON.stringify({ accountId: btn.dataset.remove }) });
    await refresh();
    toast('已移除');
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
});
// ---------------------------------------------------------------- 手动添加待办

/** 表单默认值：下一个 23:59（多数作业的截止形态就是当天 23:59）。 */
function defaultDeadlineValue() {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  // 已经过点了就顺到明天 —— 默认值填一个已经逾期的时刻很怪
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 打开/关闭添加待办层。
 *
 * 为什么是独立的层而不是在列表里展开表单：
 * 待办列表是这一页的主体，在它上方（或下方）展开表单会把列表整体推走 ——
 * 用户填完回来时，原来看到的位置已经不在屏幕上了。独立层不改变列表的布局与
 * 滚动位置，填完关掉就回到原处；填写时也不用担心键盘把列表挤变形。
 *
 * 没做成第 6 个 tab：底部已经有 5 个，再加一个会让每个都变窄，
 * 而"添加"是个一次性的动作、不是常驻的去处。
 */
/* ─────────────────────────────────────────────────────────── 覆盖层的返回键
 *
 * 【真机 bug】点开「添加待办」后侧滑，会**直接退出 App**，只能点左上角「取消」回来。
 *
 * 根因：这一层是 `position:fixed; inset:0` 的纯 CSS 覆盖层，**不进浏览器历史**。
 * 于是 Android 的 `onBackPressed` 看到 `webView.canGoBack() === false`，
 * 落到最后那条分支 `super.onBackPressed()` → Activity finish（退出）。
 * 也就是说：在系统眼里"当前页"和"上一页"是同一个页面，返回无处可去。
 *
 * 修法：打开时压一条历史，`popstate` 时关层。整条链路变成：
 *   侧滑 → onBackPressed → webView.canGoBack() 为真 → webView.goBack()
 *        → popstate → 关掉还开着的覆盖层
 * **不需要改原生**，而且桌面/浏览器版的返回按钮自动走同一条路。
 *
 * 为什么用计数器而不是读 `history.state`：`history.back()` 之后 state 已经变成
 * 上一条，靠它判断会漏掉"我自己关的"这一种，计数则两种路径都收敛到 0。
 */
let overlayDepth = 0;

function openOverlay(el) {
  el.classList.remove('hidden');
  overlayDepth += 1;
  history.pushState({ hhOverlay: overlayDepth }, '');
}

/**
 * @param fromPop 由 popstate 触发时传 true —— 那时历史已经回退过了，不能再 back()。
 */
function closeOverlay(el) {
  if (el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  // 深度**不在这里减**：交给 popstate 统一递减。
  // 原来的写法是"先减再 back()"，于是 popstate 里 overlayDepth 已经是 0，
  // 会被误判成"这次返回是退筛选" —— 点完标记完成，筛选被顺手清掉了。
  // 现在只有一条路径，开/关各一次，深度永远对得上。
  history.back();
}

// 侧滑 / 返回键：WebView 退了一条历史，把还开着的覆盖层关掉。
/**
 * 课程筛选也要进历史 —— 否则侧滑会直接退出 App。
 *
 * 和覆盖层是同一套思路：**筛选是一个"可以退出的状态"**，而 WebView 只看历史条目。
 * 没这条时，用户点课程名进了「只看这门课」，侧滑时 canGoBack() 为 false，
 * onBackPressed 落到最后一个分支直接 finish() —— 表现就是"退回主页还顺手杀了应用"。
 */
let filterDepth = 0;

/** 进入 / 切换筛选。从「无筛选」进入时压一条历史；筛选之间切换不重复压。 */
function applyCourseFilter(kind, next) {
  const had = Boolean(courseFilter[kind]);
  courseFilter[kind] = next;
  if (next && !had) {
    filterDepth += 1;
    history.pushState({ hhFilter: filterDepth }, '');
  }
  if (lastState) (kind === 'todo' ? renderTodo : renderDone)(lastState);
}

/** 用户主动清除（点「清除」或再点一次课程名）：退掉自己压的那条，由 popstate 统一收尾。 */
function clearCourseFilter(kind) {
  if (filterDepth > 0) {
    history.back();
    return;
  }
  courseFilter[kind] = null;
  if (lastState) (kind === 'todo' ? renderTodo : renderDone)(lastState);
}

window.addEventListener('popstate', () => {
  // 覆盖层优先：它是压在筛选之上的临时界面，先关它
  if (overlayDepth > 0) {
    overlayDepth -= 1;
    for (const el of document.querySelectorAll('.sheet')) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
    }
    return;
  }
  // 再退筛选：回到「全部课程」的初始待办页
  if (filterDepth > 0) {
    filterDepth -= 1;
    courseFilter.todo = null;
    courseFilter.done = null;
    if (lastState) {
      renderTodo(lastState);
      renderDone(lastState);
    }
  }
});

/**
 * 课程名缓存 —— 只在「添加待办」里用，用来发现重名。
 *
 * 为什么要在**输入时**就问：这是用户唯一盯着这个课程名看、并且意图明确的时刻。
 * 事后让他去课程页按「归并」是不可能的 —— 没人记得哪些课重名、哪些还没归。
 */
let courseCache = null;
let courseCacheAt = 0;

async function loadCourseCache(force = false) {
  if (!force && courseCache && Date.now() - courseCacheAt < 60_000) return;
  try {
    const r = await api('/api/courses');
    const list = [];
    for (const g of r.groups ?? []) {
      for (const c of g.courses ?? []) {
        list.push({ id: c.id, title: c.displayName || c.name, platformId: g.platformId });
      }
    }
    courseCache = list;
    courseCacheAt = Date.now();
    refreshCourseMatch();
  } catch {
    // 课程列表取不到就退化成"不提示重名"，不要因此挡住添加
    courseCache = null;
  }
}

/** 输入框里的名字和已有课程撞上了 → 当场问归过去还是单独一组。 */
function refreshCourseMatch() {
  const box = $('courseMatch');
  if (!box) return;
  const name = $('mCourse').value.trim();
  const hits = name && courseCache ? courseCache.filter((c) => c.title === name) : [];
  if (hits.length === 0) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML =
    '<div class="cm-hint">已有同名课程 —— 归过去，还是单独一组？</div>' +
    hits
      .map(
        (h, i) =>
          `<label class="cm-item"><input type="radio" name="cmPick" value="${escapeHtml(h.id)}"${i === 0 ? ' checked' : ''}> ${escapeHtml(h.title)} <span class="cm-plat">${escapeHtml(h.platformId)}</span></label>`,
      )
      .join('') +
    '<label class="cm-item"><input type="radio" name="cmPick" value="__new"> 新建独立分组</label>';
}

function openAddSheet() {
  const sheet = $('addTaskSheet');
  if (!$('mDeadline').value) $('mDeadline').value = defaultDeadlineValue();
  $('courseMatch').classList.add('hidden');
  $('courseMatch').innerHTML = '';
  openOverlay(sheet);
  $('mTitle').focus();
  // 后台拉一次课程名（失败也不影响添加）
  loadCourseCache().catch(() => {});
}

function closeAddSheet() {
  closeOverlay($('addTaskSheet'));
}

$('addTaskEntry').addEventListener('click', openAddSheet);
$('addTaskCancel').addEventListener('click', closeAddSheet);
$('detailClose').addEventListener('click', () => closeOverlay($('taskDetail')));

async function saveManualTask() {
  const title = $('mTitle').value.trim();
  const raw = $('mDeadline').value; // datetime-local 的值是**本地**墙上时间，无时区
  if (!title) {
    toast('作业名称不能为空');
    return;
  }
  if (!raw) {
    toast('请选择截止时间');
    return;
  }
  // new Date('2026-10-09T23:59') 按本地时区解析 → 再转 ISO 带时区，语义不会丢
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) {
    toast('截止时间格式不对');
    return;
  }

  busy(true);
  try {
    await api('/api/task/manual', {
      method: 'POST',
      body: JSON.stringify({
        title,
        deadlineAt: d.toISOString(),
        courseName: $('mCourse').value.trim(),
        platformLabel: $('mPlatform').value.trim(),
        // 同名选择（只在 refreshCourseMatch 渲染过时才存在）：
        // 选了某门课 → courseId；选了「新建独立」→ courseMode:'new'（明确不要自动归并）。
        ...(() => {
          const picked = document.querySelector('input[name="cmPick"]:checked');
          if (!picked) return {};
          return picked.value === '__new' ? { courseMode: 'new' } : { courseId: picked.value };
        })(),
      }),
    });
    // 清空字段并关掉层：用户回到列表就能看到刚加的那条
    $('mTitle').value = '';
    $('mCourse').value = '';
    $('mPlatform').value = '';
    $('mDeadline').value = defaultDeadlineValue();
    closeAddSheet();
    toast('已加入待办，并按截止时间排好提醒');
    await refresh();
  } catch (e) {
    toast(`保存失败：${e.message}`, 5000);
  } finally {
    busy(false);
  }
}

$('mCourse').addEventListener('input', () => refreshCourseMatch());
$('manualSave').addEventListener('click', saveManualTask);
// 在输入框里直接回车也能保存（手机上少点一次）
$('addTaskSheet').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveManualTask();
});

$('notifyLine').addEventListener('click', () => {
  if (window.Android?.openNotificationSettings) window.Android.openNotificationSettings();
});

$('tokenSave').addEventListener('click', () => {
  token = $('tokenInput').value.trim();
  localStorage.setItem('hh_token', token);
  location.reload();
});

// ---------------------------------------------------------------- 启动

// 手机端：原生侧从平台登录页回到应用时会调这个
window.HH = window.HH || {};
window.HH.returnedFromLogin = returnedFromLogin;

// 切回前台时：先刷新（立刻显示已有数据），再视情况静默同步一次。
// 顺序很重要 —— 先让用户看到东西，再让数据在背后变新。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refresh()
    .then(() => maybeAutoSync())
    .catch(() => {});
});

/**
 * 显示 APK 真实版本号。
 *
 * 排障时第一个要确定的问题永远是"你跑的是哪一版"。这个项目已经因此绕了两回弯路
 * （构建脚本版本号静默失配、构建失败后旧包被复制成新版本号），所以把它摆在标题旁，
 * 一眼可见 —— 而不是每次靠"某个功能在不在"去反推。
 */
function renderAppVersion() {
  const el = $('appVer');
  const v = window.Android?.appVersion?.();
  el.textContent = v ? `v${v}` : '';
}

(async () => {
  try {
    renderAppVersion();
    await refresh();
    if (token) localStorage.setItem('hh_token', token);
    // 打开就顺手更新一次（30 分钟内同步过则跳过）——
    // 用户不需要为了看到最新数据去按任何按钮
    maybeAutoSync();
  } catch (e) {
    if (/令牌|401/i.test(e.message)) {
      $('tokenGate').classList.remove('hidden');
    } else {
      $('subtitle').textContent = '连接失败';
      toast(e.message, 5000);
    }
  }
})();
