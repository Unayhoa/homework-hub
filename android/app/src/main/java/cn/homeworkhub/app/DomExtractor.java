package cn.homeworkhub.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * DOM 模式：离屏加载一个页面，等它渲染好，按选择器把表格抓成结构化数据。
 *
 * <p>为什么需要它：有些平台（真机例：智慧树）的作业数据不是纯 JSON 接口，
 * 而是页面脚本渲染出来的 —— 接口还带服务端现算的签名参数（key/uuid/dateFormate）。
 * 这类平台用 API 模式改多少轮都不可能通，只能真的把页面跑起来读 DOM。
 *
 * <p>为什么用离屏 WebView 而不是让用户看着它加载：
 * 同步是后台行为，每个平台都弹一个页面出来既打断人、也没必要。
 * 不 addView 的 WebView 照样能执行 JS 和读 DOM。
 *
 * <p>三层兜底（缺一层都会变成"看起来正常但其实没数据"）：
 * <ol>
 *   <li>readyWhen 选择器在超时内没出现 → 页面没加载好 / 登录失效</li>
 *   <li>rows 抓到 0 条 → 选择器失效（平台改版）</li>
 *   <li>字段抽出来是空的 → 同上，但要指出是哪一列</li>
 * </ol>
 */
final class DomExtractor {

    interface Callback {
        /** @param ok true 时 payload 是数组的 JSON 文本；false 时是错误说明 */
        void onResult(boolean ok, String payload);
    }

    private DomExtractor() {}

    /** 在 UI 线程上跑整个流程（WebView 必须在有 Looper 的线程创建）。 */
    static void extract(Activity act, String url, JSONObject rule, Callback cb) {
        act.runOnUiThread(() -> run(act, url, rule, cb));
    }

    private static void run(Activity act, String url, JSONObject rule, Callback cb) {
        final int timeoutMs = rule.optInt("timeoutMs", 20000);
        final int pollMs = 500;
        final Handler handler = new Handler(Looper.getMainLooper());

        WebView wv;
        try {
            wv = new WebView(act);
        } catch (Throwable t) {
            cb.onResult(false, "无法创建后台页面：" + t.getMessage());
            return;
        }

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 与主界面共用 cookie：用户在应用内登录过，这里才能看到登录后的页面
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);
        wv.setWebChromeClient(new WebChromeClient());

        final boolean[] finished = {false};
        final long deadline = System.currentTimeMillis() + timeoutMs;

        Runnable giveUp = () -> {
            if (finished[0]) return;
            finished[0] = true;
            handler.removeCallbacksAndMessages(null);
            cb.onResult(false,
                    "页面在 " + (timeoutMs / 1000) + " 秒内没有出现预期的列表元素"
                            + "（可能是登录失效，或者页面结构变了）");
            destroy(wv);
        };
        handler.postDelayed(giveUp, timeoutMs + 500);

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                waitForReady(view, rule, deadline, handler, pollMs, () -> {
                    if (finished[0]) return;
                    extractRows(view, rule, (ok, payload) -> {
                        if (finished[0]) return;
                        finished[0] = true;
                        handler.removeCallbacksAndMessages(null);
                        cb.onResult(ok, payload);
                        destroy(view);
                    });
                });
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest req,
                                        android.webkit.WebResourceError err) {
                if (req.isForMainFrame() && !finished[0]) {
                    finished[0] = true;
                    handler.removeCallbacksAndMessages(null);
                    cb.onResult(false, "页面打不开（网络或登录问题）");
                    destroy(view);
                }
            }
        });

        wv.loadUrl(url);
    }

    /** 轮询 readyWhen：SPA 的 onPageFinished 往往早于数据渲染完成。 */
    private static void waitForReady(WebView wv, JSONObject rule, long deadline,
                                     Handler handler, int pollMs, Runnable onReady) {
        String sel = rule.optString("readyWhen", "");
        if (sel.isEmpty()) {
            onReady.run();
            return;
        }
        // readyWhen 也要能看 iframe 内：超星的作业列表就在 iframe 里，
        // 只查顶层 document 会一直等不到，最后报"页面加载超时"（看起来像网络问题，方向全错）。
        String selQ = JSONObject.quote(sel);
        String js = "(function(){function qa(d,s,dep){try{if(d.querySelector(s))return true;"
                + "if(dep>4)return false;var f=d.querySelectorAll('iframe,frame');"
                + "for(var i=0;i<f.length;i++){var dd=null;try{dd=f[i].contentDocument;}catch(e){}"
                + "if(dd&&qa(dd,s,dep+1))return true;}return false;}catch(e){return false;}}"
                + "return qa(document," + selQ + ",0);})()";
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (System.currentTimeMillis() > deadline) return; // 交给超时分支
                try {
                    wv.evaluateJavascript(js, v -> {
                        if ("true".equals(v)) onReady.run();
                        else handler.postDelayed(this, pollMs);
                    });
                } catch (Throwable t) {
                    // WebView 被销毁等异常：直接放弃，由超时兜底
                }
            }
        };
        handler.post(tick);
    }

    /** 在页面里按选择器抓行与字段。规则来自配置，不执行任何上传来的代码。 */
    private static void extractRows(WebView wv, JSONObject rule, Callback cb) {
        StringBuilder js = new StringBuilder();
        js.append("(function(){var rule=").append(rule.toString()).append(';');
        js.append("function pick(el,f){try{");
        js.append("var n=f.find?el.querySelector(f.find):el;if(!n)return '';");
        js.append("var v=f.attr?(n.getAttribute(f.attr)||''):(n.innerText||'');");
        js.append("if(f.regex){var m=new RegExp(f.regex).exec(v);return m?(m[1]!==undefined?m[1]:m[0]):'';}");
        js.append("return String(v||'').replace(/\\s+/g,' ').trim();");
        js.append("}catch(e){return '';}}");
        // 递归进同源 iframe 找行 —— 超星的作业列表在 iframe 内。
        // 只查顶层 document 会得到 0 条，然后报"选择器已失效"，
        // 把人引去重新点选（而点选出来的选择器其实是对的，只是查错了文档）。
        js.append("function docs(root){var out=[root];(function walk(d,dep){if(dep>4)return;");
        js.append("var f;try{f=d.querySelectorAll('iframe,frame');}catch(e){return;}");
        js.append("for(var i=0;i<f.length;i++){var dd=null;try{dd=f[i].contentDocument;}catch(e){dd=null;}");
        js.append("if(dd){out.push(dd);walk(dd,dep+1);}}})(root,0);return out;}");
        js.append("var rows=[];(function(){var ds=docs(document);");
        js.append("for(var i=0;i<ds.length;i++){try{");
        js.append("var l=ds[i].querySelectorAll(rule.rows||'');");
        js.append("for(var j=0;j<l.length;j++)rows.push(l[j]);}catch(e){}}})();");
        js.append("var out=rows.map(function(el){var o={};");
        js.append("for(var k in (rule.fields||{})){o[k]=pick(el,rule.fields[k]);}return o;});");
        js.append("return JSON.stringify(out);})()");

        try {
            wv.evaluateJavascript(js.toString(), v -> {
                String text = decodeJsString(v);
                if (text == null) {
                    cb.onResult(false, "页面里没能执行提取脚本（可能被跨域限制或脚本报错挡了）");
                    return;
                }
                try {
                    org.json.JSONArray arr = new org.json.JSONArray(text);
                    if (arr.length() == 0) {
                        // 这一条最关键：0 条不是"没作业"，是"选择器对不上"。
                        cb.onResult(false,
                                "页面上没有匹配到任何一条作业（选择器 rows 可能已失效，建议重新录一次）");
                        return;
                    }
                    cb.onResult(true, text);
                } catch (Exception e) {
                    cb.onResult(false, "提取结果不是数组：" + e.getMessage());
                }
            });
        } catch (Throwable t) {
            cb.onResult(false, "提取失败：" + t.getMessage());
        }
    }

    /** evaluateJavascript 返回的是 JSON 字符串字面量（带引号、转义），解一层。 */
    static String decodeJsString(String raw) {
        if (raw == null || raw.equals("null")) return null;
        try {
            return (String) new org.json.JSONTokener(raw).nextValue();
        } catch (Exception e) {
            return null;
        }
    }

    private static void destroy(WebView wv) {
        try {
            wv.stopLoading();
            wv.loadUrl("about:blank");
            wv.destroy();
        } catch (Throwable ignored) {
            // 销毁失败不影响结果
        }
    }
}
