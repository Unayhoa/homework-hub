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
