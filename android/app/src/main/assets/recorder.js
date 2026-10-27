/**
 * 注入到平台页面里的记录器（由 BrowseActivity 在 onPageStarted 时注入）。
 *
 * 干什么：把页面自己发出的 JSON 请求记下来，等用户点「导出」时交回去。
 *
 * 为什么不用 HAR / 不拦原生请求：
 *   页面发的请求地址是它自己拼的，我们在原生侧无法知道"哪个请求带回了作业列表"。
 *   而在 JS 层 hook fetch / XHR，能直接读到 responseText —— 这是最省事的一条路。
 *   （Android 的 shouldInterceptRequest 只能拿到请求，拿不到响应体。）
 *
 * 注入时机很重要：必须在页面脚本执行**之前**（onPageStarted）。
 * 如果打开时已经错过，让用户刷新一次页面即可 —— 刷新会重新走 onPageStarted。
 */
(function () {
  if (window.__hhRecorder) return;
  var MAX_BODY = 8000;   // 单条响应最多留 8KB，够看出结构，又不至于撑爆证据包
  var MAX_REQ = 120;     // 最多留 120 条

  var rec = {
    startedAt: Date.now(),
    requests: [],
    markers: [],
  };

  /**
   * 自动打标：翻页 / 滚到底 / 换了页面。
   *
   * 为什么要自动打：识别层需要知道「哪些请求是用户翻过页、滚过列表之后才出现的」——
   * 那才是完整数据。让用户为了这个多点一个按钮，等于把成本推给他，
   * 而他根本不知道"翻页"和"接口"之间有什么关系。
   *
   * 标记只记「发生过」，不记录任何页面内容。
   */
  function autoMark(name) {
    var m = rec.markers[rec.markers.length - 1];
    if (m && m.name === name && Date.now() - m.at < 1500) return; // 去抖：同一动作不刷屏
    rec.markers.push({ name: name, at: Date.now(), url: location.href });
  }

  // 滚动到底 → 可能触发了懒加载
  var scrollTimer = 0;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = 0;
      try {
        var doc = document.documentElement;
        var nearBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 200;
        if (nearBottom) autoMark('scroll:bottom');
      } catch (e) {}
    }, 300);
  }, { passive: true });

  // 点「下一页 / 加载更多」→ 记一笔（买不到就不记，绝不能影响页面本身）
  document.addEventListener('click', function (e) {
    try {
      var el = e.target && e.target.closest ? e.target.closest('a,button,[role="button"]') : null;
      if (!el) return;
      var txt = String(el.innerText || el.getAttribute('aria-label') || '').slice(0, 20);
      if (/下一页|下页|next|加载更多|更多|load\s*more/i.test(txt)) autoMark('page:next');
    } catch (e2) {}
  }, true);
  window.__hhRecorder = rec;

  function abs(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u); }
  }

  function push(item) {
    if (rec.requests.length >= MAX_REQ) return;
    rec.requests.push(item);
  }

  function isJson(ct) {
    return typeof ct === 'string' && ct.indexOf('json') !== -1;
  }

  // ── fetch ──
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      return origFetch.apply(this, args).then(function (res) {
        try {
          var ct = res.headers ? res.headers.get('content-type') : '';
          if (!isJson(ct)) return res;
          var req = args[0];
          var url = typeof req === 'string' ? req : (req && req.url) || '';
          var method = (args[1] && args[1].method) || (req && req.method) || 'GET';
          res.clone().text().then(function (text) {
            push({
              url: abs(url), method: String(method).toUpperCase(), status: res.status,
              mimeType: ct, body: String(text).slice(0, MAX_BODY), t: Date.now(),
              // 这条请求是在「已经发生过几个用户动作」之后出现的 —— 数字越大越靠后
              mark: rec.markers.length,
            });
          }).catch(function () {});
        } catch (e) {}
        return res;
      });
    };
  }

  // ── XMLHttpRequest ──
  var OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    var Wrapped = function () {
      var xhr = new OrigXHR();
      var m = 'GET';
      var u = '';
      var open = xhr.open;
      xhr.open = function (method, url) {
        m = method;
        u = url;
        return open.apply(this, arguments);
      };
      xhr.addEventListener('load', function () {
        try {
          var ct = xhr.getResponseHeader('content-type') || '';
          if (!isJson(ct)) return;
          var text = '';
          if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText;
          else if (xhr.responseType === 'json') text = JSON.stringify(xhr.response);
          if (!text) return;
          push({
            url: abs(u), method: String(m).toUpperCase(), status: xhr.status,
            mimeType: ct, body: String(text).slice(0, MAX_BODY), t: Date.now(),
            mark: rec.markers.length,
          });
        } catch (e) {}
      });
      return xhr;
    };
    Wrapped.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = Wrapped;
  }

  /**
   * 标记「现在这个页面就是作业列表」。
   * 不标也能用，但标了之后证据包里能明确"这些请求是在这个页面发出的"，AI 好定位。
   */
  window.__hhMark = function (name) {
    rec.markers.push({ name: String(name || 'mark'), at: Date.now(), url: location.href });
    return rec.markers.length;
  };

  /** 导出：整个记录 + 当前页面可见文本（后者用于"作业标题锚定"）。 */
  window.__hhDump = function () {
    return JSON.stringify({
      href: location.href,
      title: document.title,
      pageText: document.body ? String(document.body.innerText || '').slice(0, 20000) : '',
      startedAt: rec.startedAt,
      markers: rec.markers,
      requests: rec.requests,
    });
  };

  /** 供给 UI 显示的计数。 */
  window.__hhCount = function () { return rec.requests.length; };
})();

/**
 * 点选模式：用户点一下某个作业标题，自动推出「行选择器 + 标题选择器」。
 *
 * 为什么让用户点一下而不是让 AI 从 DOM 里猜：这是唯一**当场可验证**的路径。
 * 猜出来的选择器要等同步失败才知道错，点选出来的立刻能试抓一次。
 */
/**
 * 点选模式：用一个**全屏遮罩**接管所有指针事件。
 *
 * 为什么不能只拦 click（真机 2026-10-27 的教训）：
 * 原来是在 document 的 capture 阶段拦 click + preventDefault，看起来无懈可击，
 * 但超星的作业行点了之后**照样跳进了作业详情**。原因是它的跳转不在 click 上 ——
 * 可能在 mousedown / touchstart，也可能挂在比我们更早注册的 capture handler 上。
 * 拦一种事件类型，挡不住另一种。
 *
 * 遮罩的可靠性在于：事件**根本到不了页面**，不依赖"猜它挂在哪"。
 * 代价是滚动也被挡住了，所以这里手动转发滚动（单指拖动 = 滚动，不拖动 = 选中）。
 *
 * 目标元素用 elementsFromPoint 取（遮罩在最上层，直接 elementFromPoint 会拿到自己）；
 * 老 WebView 没有 elementsFromPoint 时，临时让遮罩不接收指针再取一次。
 */
window.__hhPickStart = function () {
  if (window.__hhPicking) return 'already';
  window.__hhPicking = true;

  var Z = 2147483647;
  var TIP_ID = '__hhPickTip';
  var MASK_ID = '__hhPickMask';
  var HL_CLASS = '__hhPickHl';

  // 清掉上一次可能残留的东西（用户中途退出会留下）
  function bye(id) {
    var n = document.getElementById(id);
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }
  bye(MASK_ID);
  bye(TIP_ID);

  var oldStyle = document.getElementById('__hhPickStyle');
  if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);

  var style = document.createElement('style');
  style.id = '__hhPickStyle';
  style.textContent =
    '.' + HL_CLASS + '{outline:2px solid #2563eb !important;outline-offset:2px !important;background:rgba(37,99,235,.08) !important}' +
    // 第三层防护：点选期间**页面所有元素都不接收点击**，只有遮罩和提示条例外。
    // 这挡住的是"页面的高 z-index 浮层盖在遮罩之上"—— 那时点击落在浮层上，
    // 既不在遮罩上、也拦不住它的内联 handler。pointer-events:none 让它直接不参与命中测试，
    // 事件只能落到遮罩上。SPA 的浮层（AI 助手球、悬浮按钮）就是这样。
    'html,body,body *{pointer-events:none !important}' +
    '#' + MASK_ID + ',#' + TIP_ID + '{pointer-events:auto !important}';
  if (document.head) document.head.appendChild(style);
  else document.documentElement.appendChild(style);

  var mask = document.createElement('div');
  mask.id = MASK_ID;
  mask.setAttribute(
    'style',
    'position:fixed;left:0;top:0;right:0;bottom:0;z-index:' + Z + ';' +
      'background:rgba(37,99,235,.10);cursor:crosshair;touch-action:none',
  );

  var tip = document.createElement('div');
  tip.id = TIP_ID;
  tip.setAttribute(
    'style',
    'position:fixed;left:8px;right:8px;top:8px;padding:8px 12px;background:#2563eb;color:#fff;' +
      'border-radius:8px;font:13px/1.4 system-ui,-apple-system,sans-serif;text-align:center;' +
      'z-index:' + Z + ';box-shadow:0 2px 10px rgba(0,0,0,.25)',
  );
  tip.textContent = '选择模式 · 点一条作业标题（上下滑动可以滚动）';

  /**
   * 全局 capture 拦截：**这是最关键的一层**。
   *
   * 只把遮罩放上去是不够的：事件落在遮罩上，然后**继续冒泡**到 document / window，
   * 而 SPA（超星就是）几乎都把点击委托绑在那上面。委托 handler 只看坐标、不看 target，
   * 于是"点在遮罩上"对它来说和"点在作业行上"没有区别 —— 照样跳转。
   * 真机 2026-10-27：遮罩看得见，但一点就穿透，就是这个原因。
   *
   * 所以要在**比页面更早的阶段**（window capture）把所有指针事件掐断，
   * 只放行落在遮罩上的那些（由遮罩自己的 handler 处理）。
   * 我们比页面脚本先注册（recorder 在 onPageStarted 注入），所以同一个节点上我们排在前面。
   */
  var STOP_TYPES = [
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'mousedown', 'mousemove', 'mouseup',
    'click', 'dblclick', 'contextmenu',
  ];
  function blocker(e) {
    if (e.target === mask || (mask.contains && mask.contains(e.target))) return; // 放行给遮罩自己处理
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  var hl = null;
  function highlight(el) {
    if (hl === el) return;
    if (hl && hl.classList) hl.classList.remove(HL_CLASS);
    hl = el;
    if (hl && hl.classList) hl.classList.add(HL_CLASS);
  }

  /**
   * 遮罩下面那个真实元素。
   *
   * **必须先临时解冻**：`pointer-events:none` 的元素不参与 hit-testing，
   * 冻结页面之后 elementsFromPoint 会跳过所有页面元素，只剩下遮罩和 body ——
   * 于是永远点不中任何东西。这个冲突必须靠"取元素时解冻、取完立刻冻结"来绕。
   * 同步执行，中间不会插入任何事件，所以没有闪烁也不会漏点击。
   */
  function elUnder(x, y) {
    var st = document.getElementById('__hhPickStyle');
    var wasDisabled = false;
    if (st) {
      wasDisabled = !!st.disabled;
      st.disabled = true; // 解冻
    }
    try {
      if (document.elementsFromPoint) {
        var list = document.elementsFromPoint(x, y) || [];
        for (var i = 0; i < list.length; i += 1) {
          var n = list[i];
          if (n === mask || n === tip) continue;
          if (n === document.body || n === document.documentElement) continue;
          return n;
        }
      }
      var el = document.elementFromPoint(x, y);
      if (el === mask || el === tip || el === document.body) return null;
      return el;
    } finally {
      if (st && !wasDisabled) st.disabled = false; // 重新冻结
    }
  }

  function clsOf(el) {
    if (!el || !el.className || typeof el.className !== 'string') return '';
    var c = String(el.className).trim().split(/\s+/)[0];
    // 过滤带状态/序号的动态类名（list-item-3、active、hover 之类）
    if (!c || /\d/.test(c) || /^(active|on|hover|selected|cur)$/i.test(c)) return '';
    return '.' + c;
  }

  function done() {
    window.__hhPicking = false;
    if (hl && hl.classList) hl.classList.remove(HL_CLASS);
    hl = null;
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    if (tip.parentNode) tip.parentNode.removeChild(tip);
    window.removeEventListener('keydown', onKey, true);
    for (var i = 0; i < STOP_TYPES.length; i += 1) {
      window.removeEventListener(STOP_TYPES[i], blocker, true);
    }
    // 必须把冻结样式一起撤掉，否则退出后整个页面点不动（比穿透更难查）
    var st = document.getElementById('__hhPickStyle');
    if (st && st.parentNode) st.parentNode.removeChild(st);
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      window.__hhPickResult = { ok: false, error: '已取消' };
      done();
    }
  }

  function select(x, y) {
    var el = elUnder(x, y);
    done();
    if (!el || el === document.body || el === document.documentElement) {
      window.__hhPickResult = { ok: false, error: '没点到具体内容，再试一次' };
      return;
    }
    // 向上找「有多个同类兄弟」的祖先 —— 那就是一行作业
    var row = el;
    var rowSel = '';
    for (var i = 0; i < 6 && row.parentElement; i += 1) {
      var p = row.parentElement;
      var c = clsOf(row);
      if (c && p.querySelectorAll(c).length > 1) {
        rowSel = c;
        break;
      }
      row = p;
    }
    window.__hhPickResult = {
      ok: !!rowSel,
      rowSelector: rowSel,
      titleSelector: clsOf(el),
      sample: String(el.innerText || '').slice(0, 60),
      error: rowSel ? '' : '没找到重复出现的作业行（这个列表可能只有一条，或者结构太特殊）',
    };
  }

  // ---- 触摸：拖动 = 滚动，轻点 = 选中 ----
  var startY = 0;
  var startX = 0;
  var moved = false;
  var lastTouchAt = 0;

  /**
   * 遮罩上的事件必须**同时**做三件事：
   *   1. stopPropagation —— 不让它冒泡到 document/window 的委托 handler（穿透的真正原因）；
   *   2. preventDefault —— 阻止链接跳转、阻止合成后续 click；
   *   3. 不使用 passive —— passive 下 preventDefault 是**空操作**，
   *      上一版就是栽在这里：看着写了 preventDefault，实际一次都没生效。
   */
  function swallow(e) {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  }

  mask.addEventListener(
    'touchstart',
    function (e) {
      swallow(e);
      // SPA 可能在我们之后又插入了更高层的浮层 —— 每次触摸把遮罩收回最上层
      if (mask.parentNode !== document.body || document.body.lastElementChild !== mask) {
        document.body.appendChild(mask);
      }
      var t = e.touches[0];
      startY = t.clientY;
      startX = t.clientX;
      moved = false;
      var el = elUnder(t.clientX, t.clientY);
      if (el) highlight(el);
    },
    { passive: false },
  );

  mask.addEventListener(
    'touchmove',
    function (e) {
      swallow(e);
      var t = e.touches[0];
      var dy = startY - t.clientY;
      if (Math.abs(dy) > 6 || Math.abs(startX - t.clientX) > 6) moved = true;
      // 手动转发滚动：遮罩把原生滚动挡住了，不转发的话长列表根本翻不动
      if (moved) {
        window.scrollBy(0, dy);
        startY = t.clientY;
        startX = t.clientX;
        highlight(null);
      } else {
        var el = elUnder(t.clientX, t.clientY);
        if (el) highlight(el);
      }
    },
    { passive: false },
  );

  mask.addEventListener('touchend', function (e) {
    swallow(e);
    lastTouchAt = Date.now();
    // touchend 里 touches 已经空了，用 changedTouches
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    if (moved) return; // 滚动结束，继续留在选择模式
    select(t.clientX, t.clientY);
  });

  mask.addEventListener('touchcancel', function (e) {
    swallow(e);
    window.__hhPicking = false;
  });

  // ---- 鼠标（桌面 WebView / 外接鼠标）：悬停高亮，点击选中 ----
  mask.addEventListener('mousemove', function (e) {
    swallow(e);
    var el = elUnder(e.clientX, e.clientY);
    if (el) highlight(el);
  });
  mask.addEventListener('mousedown', swallow);
  mask.addEventListener('mouseup', swallow);
  mask.addEventListener('click', function (e) {
    swallow(e);
    // 触摸刚结束时不重复处理（Android 会在 touchend 后补一个 click）
    if (Date.now() - lastTouchAt < 600) return;
    select(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', onKey, true);
  for (var k = 0; k < STOP_TYPES.length; k += 1) {
    window.addEventListener(STOP_TYPES[k], blocker, true);
  }
  document.body.appendChild(mask);
  document.body.appendChild(tip);
  return 'ok';
};

/** 取点选结果（原生轮询用）。 */
window.__hhPickResult = null;
window.__hhTakePick = function () {
  var r = window.__hhPickResult;
  window.__hhPickResult = null;
  return r ? JSON.stringify(r) : 'null';
};
