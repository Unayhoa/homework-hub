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
window.__hhPickStart = function () {
  if (window.__hhPicking) return 'already';
  window.__hhPicking = true;

  function clsOf(el) {
    if (!el || !el.className) return '';
    var c = String(el.className).trim().split(/\s+/)[0];
    // 过滤掉带状态/序号的动态类名（list-item-3、active、hover 之类）
    if (!c || /\d/.test(c) || /^(active|on|hover|selected|cur)$/i.test(c)) return '';
    return '.' + c;
  }

  function pickHandler(e) {
    e.preventDefault();
    e.stopPropagation();
    window.__hhPicking = false;
    document.removeEventListener('click', pickHandler, true);

    var el = e.target;
    while (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) {
      window.__hhPickResult = { ok: false, error: '没点到元素' };
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

    var titleSel = clsOf(el);
    window.__hhPickResult = {
      ok: !!rowSel,
      rowSelector: rowSel,
      titleSelector: titleSel,
      sample: String(el.innerText || '').slice(0, 60),
      error: rowSel ? '' : '没找到重复出现的作业行（这个列表可能只有一条，或者结构太特殊）',
    };
  }

  document.addEventListener('click', pickHandler, true);
  return 'ok';
};

/** 取点选结果（原生轮询用）。 */
window.__hhPickResult = null;
window.__hhTakePick = function () {
  var r = window.__hhPickResult;
  window.__hhPickResult = null;
  return r ? JSON.stringify(r) : 'null';
};
