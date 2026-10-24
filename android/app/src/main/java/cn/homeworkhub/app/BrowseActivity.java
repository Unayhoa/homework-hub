package cn.homeworkhub.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * 独立窗口：看平台页面 / 录制「新平台接入」的证据。
 *
 * <p>为什么不复用主界面的 WebView：主界面和平台页共用一个历史栈时，
 * 用户返回应用后再侧滑会退进平台页。前两版补救（goBack、clearHistory）都失败，
 * 换成独立 Activity 后主界面历史里一条外部记录都不会有。
 *
 * <p>两种模式：
 * <ul>
 *   <li>普通：从待办点作业名进来，看一个页面；</li>
 *   <li>录制：从设置页「添加平台」进来，把页面请求记下来，导出成证据包给 AI。</li>
 * </ul>
 */
public class BrowseActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";
    /** true = 录制模式：注入记录器，多出「标记 / 导出」按钮 */
    public static final String EXTRA_RECORD = "record";
    /** 录制模式下要复制到剪贴板的提示词（由前端传入，原生不硬编码，避免两份漂移） */
    public static final String EXTRA_PROMPT = "prompt";

    private WebView webView;
    private TextView status;
    private boolean recording;
    private String prompt = "";
    /** 注入脚本只读一次，避免每次页面加载都读盘 */
    private static String RECORDER_JS;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String referer = getIntent().getStringExtra(EXTRA_REFERER);
        recording = getIntent().getBooleanExtra(EXTRA_RECORD, false);
        String p = getIntent().getStringExtra(EXTRA_PROMPT);
        if (p != null) prompt = p;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // ── 顶部条：返回 +（录制模式的）地址输入与动作 ──
        Button back = new Button(this);
        back.setText("← 返回应用");
        back.setAllCaps(false);
        back.setOnClickListener(v -> finish());
        root.addView(back, wrap());

        if (recording) {
            EditText input = new EditText(this);
            input.setHint("平台网址，例如 https://xxx.edu.cn");
            input.setText(url == null ? "" : url);
            input.setSingleLine(true);
            input.setTextSize(13f);
            input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
            root.addView(input, wrap());

            LinearLayout bar = new LinearLayout(this);
            bar.setOrientation(LinearLayout.HORIZONTAL);

            Button open = new Button(this);
            open.setText("打开");
            open.setAllCaps(false);
            open.setOnClickListener(v -> {
                String u = input.getText().toString().trim();
                if (u.isEmpty()) {
                    toast("先填网址");
                    return;
                }
                if (!u.startsWith("http")) u = "https://" + u;
                webView.loadUrl(u);
            });
            bar.addView(open, weight(1f));

            Button mark = new Button(this);
            mark.setText("点选作业行");
            mark.setAllCaps(false);
            mark.setOnClickListener(v -> pickAndTest());
            bar.addView(mark, weight(1.3f));

            Button export = new Button(this);
            export.setText("导出给 AI");
            export.setAllCaps(false);
            export.setOnClickListener(v -> exportCapture());
            bar.addView(export, weight(1.2f));

            root.addView(bar);
        }

        status = new TextView(this);
        status.setTextSize(11f);
        status.setTextColor(Color.GRAY);
        status.setPadding(24, 2, 24, 6);
        status.setText(recording
                ? "① 打开平台并登录  ② 点进「作业列表」  ③ 点「标记为列表页」  ④ 导出给 AI"
                : "");
        root.addView(status);

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String u, android.graphics.Bitmap favicon) {
                // **必须在这个时机注入**：页面脚本会立刻发请求，
                // 等到 onPageFinished 才注入就已经错过了（真机验证过）。
                if (recording) injectRecorder(view);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        if (url != null && !url.isEmpty()) {
            if (referer != null && !referer.isEmpty()) {
                java.util.Map<String, String> h = new java.util.HashMap<>();
                h.put("Referer", referer);
                webView.loadUrl(url, h);
            } else {
                webView.loadUrl(url);
            }
        }
    }

    private static LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private static LinearLayout.LayoutParams weight(float w) {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, w);
    }

    private void injectRecorder(WebView view) {
        try {
            if (RECORDER_JS == null) {
                InputStream in = getAssets().open("recorder.js");
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] tmp = new byte[8192];
                int n;
                while ((n = in.read(tmp)) > 0) buf.write(tmp, 0, n);
                in.close();
                RECORDER_JS = buf.toString(StandardCharsets.UTF_8.name());
            }
            view.evaluateJavascript(RECORDER_JS, null);
        } catch (Exception e) {
            status.setText("记录器注入失败：" + e.getMessage());
        }
    }

    /**
     * 导出证据包。
     *
     * 脱敏只做一件事：把 URL 里疑似 token 的查询参数换成 ***。
     * 记录器本身**不记请求头**（没有 Cookie / Authorization 可漏），
     * 所以真正敏感的东西从源头上就没进来。
     */
    private void exportCapture() {
        webView.evaluateJavascript(
                "window.__hhDump?window.__hhDump():'null'",
                value -> {
                    try {
                        String json = decodeJsString(value);
                        if (json == null || json.equals("null")) {
                            toast("没有记录到内容：请刷新一次页面再操作（记录器要在页面加载前注入）");
                            return;
                        }
                        share(buildMarkdown(new JSONObject(json)));
                    } catch (Exception e) {
                        toast("导出失败：" + e.getMessage());
                    }
                });
    }

    /**
     * 点选 + 当场试抓。
     *
     * 这是 DOM 模式对用户唯一「立刻能判断对错」的入口：
     * 不用等同步、不用问 AI —— 点一下就知道这个选择器能不能抓到作业。
     */
    private void pickAndTest() {
        status.setText("请在页面上点一下任意一条作业的标题");
        webView.evaluateJavascript("window.__hhPickStart&&window.__hhPickStart()", null);
        pollPick(0);
    }

    private void pollPick(int attempt) {
        webView.evaluateJavascript("window.__hhTakePick?window.__hhTakePick():'null'", v -> {
            String json = DomExtractor.decodeJsString(v);
            if (json == null || json.equals("null")) {
                if (attempt < 120) {
                    new android.os.Handler(android.os.Looper.getMainLooper())
                            .postDelayed(() -> pollPick(attempt + 1), 500);
                }
                return;
            }
            try {
                handlePick(new JSONObject(json));
            } catch (Exception e) {
                status.setText("点选结果解析失败：" + e.getMessage());
            }
        });
    }

    private void handlePick(JSONObject r) throws Exception {
        if (!r.optBoolean("ok")) {
            status.setText("没识别出来：" + r.optString("error"));
            return;
        }
        String rowSel = r.optString("rowSelector");
        String titleSel = r.optString("titleSelector");

        JSONObject fields = new JSONObject();
        JSONObject title = new JSONObject();
        if (!titleSel.isEmpty()) title.put("find", titleSel);
        fields.put("title", title);
        // 截止时间不让人再点一次：行内文本里能匹配到日期就用它。
        // 匹配不到只是这一列为空，不影响"能抓到几条"这个判断。
        JSONObject dl = new JSONObject();
        dl.put("regex", "(\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}[^\\s]*)");
        fields.put("deadline", dl);

        JSONObject rule = new JSONObject();
        rule.put("readyWhen", rowSel);
        rule.put("rows", rowSel);
        rule.put("fields", fields);
        rule.put("timeoutMs", 15000);

        status.setText("已识别：" + rowSel + "，正在试抓…");
        DomExtractor.extract(this, webView.getUrl(), rule, (ok, payload) -> {
            if (!ok) {
                status.setText("试抓失败：" + payload);
                return;
            }
            try {
                JSONArray arr = new JSONArray(payload);
                JSONObject first = arr.optJSONObject(0);
                String sample = first == null ? "" : first.optString("title");
                // 试抓成功就**直接把配置复制出来** —— 用户不用再理解选择器，
                // 回设置页粘一下就能启用。少一步操作，少一次放弃。
                String cfg = buildDomConfig(rowSel, fields);
                copyToClipboard(cfg);
                status.setText("✅ 抓到 " + arr.length() + " 条。第一条：" + sample
                        + "\n配置已复制 —— 返回应用 → 设置 → 添加平台 → 粘贴 → 启用");
            } catch (Exception e) {
                status.setText("试抓结果异常：" + e.getMessage());
            }
        });
    }

    /** 把刚验证过的选择器拼成一份 DOM 配置（和 API 模式共用同一套导入/启用流程）。 */
    private String buildDomConfig(String rowSel, JSONObject fields) {
        String url = webView.getUrl() == null ? "" : webView.getUrl();
        try {
            JSONObject platform = new JSONObject();
            // 名字用域名主体，比"未命名平台"好认；用户以后可以改
            String host = android.net.Uri.parse(url).getHost();
            String key = host == null ? "custom" : host.replaceFirst("^www\\.", "").split("\\.")[0];
            platform.put("name", key);
            platform.put("origin", "https://" + (host == null ? "" : host));

            JSONObject cfg = new JSONObject();
            cfg.put("platform", platform);
            cfg.put("mode", "dom");
            cfg.put("url", url);
            cfg.put("readyWhen", rowSel);
            cfg.put("rows", rowSel);
            cfg.put("fields", fields);
            cfg.put("timeoutMs", 20000);
            // 页面地址里通常带 courseId，存下来：同步时就不用再让用户填
            String cid = android.net.Uri.parse(url).getQueryParameter("courseId");
            if (cid != null && !cid.isEmpty()) cfg.put("defaultCourseId", cid);
            return cfg.toString(2);
        } catch (Exception e) {
            return "";
        }
    }

    private void copyToClipboard(String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("DOM 配置", text));
    }

    /** evaluateJavascript 返回的是 JSON 字符串字面量（带引号、转义），先解一层。 */
    private String decodeJsString(String raw) {
        if (raw == null || raw.equals("null")) return null;
        try {
            return (String) new org.json.JSONTokener(raw).nextValue();
        } catch (Exception e) {
            return null;
        }
    }

    private String buildMarkdown(JSONObject o) throws Exception {
        StringBuilder b = new StringBuilder();
        b.append("# 平台接入证据包\n\n");
        b.append("> 已脱敏：未记录任何请求头（无 Cookie / Authorization），URL 里的 token 参数已替换为 ***。\n\n");
        b.append("- 页面标题：").append(o.optString("title", "")).append('\n');
        b.append("- 页面地址：").append(scrub(o.optString("href", ""))).append("\n\n");

        JSONArray markers = o.optJSONArray("markers");
        if (markers != null && markers.length() > 0) {
            b.append("## 用户标记\n\n");
            for (int i = 0; i < markers.length(); i++) {
                JSONObject m = markers.getJSONObject(i);
                b.append("- ").append(m.optString("name")).append(" @ ")
                        .append(m.optString("url", "")).append('\n');
            }
            b.append('\n');
        }

        b.append("## 页面可见文本（用户看到作业列表时的屏幕内容）\n\n```text\n");
        String pageText = o.optString("pageText", "");
        b.append(trimPageNoise(pageText));
        b.append("\n```\n\n");

        b.append("## 期间发出的 JSON 请求\n\n");
        JSONArray reqs = o.optJSONArray("requests");
        // 先筛掉埋点、再按「像不像作业接口」排序 —— 真机上这份列表里 80% 是
        // appcomm-user 那类用户行为上报（URL 里还带一长串 uid），既没用又占满上下文。
        java.util.List<JSONObject> kept = new java.util.ArrayList<>();
        if (reqs != null) {
            for (int i = 0; i < reqs.length(); i++) {
                JSONObject r = reqs.optJSONObject(i);
                if (r == null) continue;
                String u = r.optString("url", "");
                if (isNoise(u)) continue;
                kept.add(r);
            }
        }
        kept.sort((x, y) -> Integer.compare(score(y.optString("url", "")), score(x.optString("url", ""))));

        if (kept.isEmpty()) {
            b.append("（没记录到任何可用的 JSON 请求。可能是页面在我注入记录器之前就加载完了 —— 请刷新一次再操作。）\n");
        } else {
            for (int i = 0; i < Math.min(kept.size(), 25); i++) {
                JSONObject r = kept.get(i);
                b.append("### ").append(r.optString("method", "GET")).append(' ')
                        .append(scrub(r.optString("url", ""))).append('\n');
                b.append("- 状态：").append(r.optInt("status", 0)).append('\n');
                String body = r.optString("body", "");
                if (!body.isEmpty()) {
                    b.append("- 响应片段：\n```json\n").append(maskBody(body)).append("\n```\n");
                }
                b.append('\n');
            }
        }
        b.append("---\n\n请按提示词里的 JSON 格式输出平台接入配置。");
        return b.toString();
    }

    /**
     * 把响应里的「内容」换成占位符，只留结构。
     *
     * 为什么必须这么做（真机实测两次）：只要证据包里能看见作业标题，
     * 手机端 AI 就会去「提取作业」而不是「写读取规则」——
     * 加多少句提示词约束都没用。看不见内容，它就只能描述怎么读。
     *
     * 日期类和短数字字符串**保留**：AI 要知道时间字段长什么样，才能填对格式。
     */
    private static Object maskValues(Object v, int depth) {
        if (depth > 6) return "<deep>";
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            JSONArray out = new JSONArray();
            if (a.length() > 0) out.put(maskValues(a.opt(0), depth + 1));
            return out;
        }
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            JSONObject out = new JSONObject();
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                try {
                    out.put(k, maskValues(o.opt(k), depth + 1));
                } catch (Exception ignored) {
                    // 单个字段出问题不该毁掉整份证据
                }
            }
            return out;
        }
        if (v instanceof String) {
            String s = (String) v;
            if (s.matches("^\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}.*")) return s;
            if (s.matches("^\\d{1,6}$")) return s;
            return "<string len=" + s.length() + ">";
        }
        return v;
    }

    private static String maskBody(String body) {
        try {
            return maskValues(new org.json.JSONTokener(body).nextValue(), 0).toString();
        } catch (Exception e) {
            return body;
        }
    }

    /** 埋点 / 用户行为上报：对定位作业接口毫无用处，只会挤占 AI 的上下文。 */
    private static boolean isNoise(String url) {
        String u = url.toLowerCase();
        return u.contains("appcomm") || u.contains("/c/has?") || u.contains("has?uid=")
                || u.contains("/track") || u.contains("/log") || u.contains("beacon")
                || u.contains("statistic") || u.contains("report");
    }

    /** 「像作业列表」的地址加分：用于把关键请求排到前面（猜不准也只会影响顺序，不影响对错）。 */
    private static int score(String url) {
        String u = url.toLowerCase();
        int s = 0;
        for (String k : new String[] { "exam", "homework", "work", "task", "assignment", "quiz" }) {
            if (u.contains(k)) s += 10;
        }
        if (u.contains("list")) s += 5;
        if (u.contains("page")) s += 2;
        return s;
    }

    /**
     * 页面可见文本去噪：真机上 innerText 里会混进大量纯粹的数字（分页器、评分控件），
     * 几十行 "0 1 2 3 4…" 对定位字段毫无帮助，却把真正的作业标题冲淡了。
     */
    private static String trimPageNoise(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder();
        int kept = 0;
        for (String line : text.split("\n")) {
            String t = line.trim();
            if (t.isEmpty()) continue;
            // 纯数字、单字符、长度 < 2 的碎片直接丢
            if (t.matches("^\\d{1,3}$") || t.length() < 2) continue;
            out.append(t).append('\n');
            kept += 1;
            if (kept >= 60) break; // 只留前 60 行有效文本
        }
        String s = out.toString();
        return s.length() > 3000 ? s.substring(0, 3000) : s;
    }

    /** 去掉 URL 里可能是凭据的查询参数值。 */
    private static String scrub(String url) {
        if (url == null) return "";
        return url.replaceAll(
                "(?i)([?&](token|auth|access_token|sign|signature|ticket|key|session|enc|uid|uuid|secretstr|uuidstr)=)[^&]*",
                "$1***");
    }

    private void share(String evidence) {
        // **提示词必须和证据拼在一起**。
        // 之前的做法是把提示词放剪贴板、证据走分享 —— 真机上用户只用了分享那一个，
        // 结果 AI 收到的是纯证据包（一个字的提示词都没有），自然乱答。
        // 两个通道 = 两个必选项，没人会记得两个都做。
        String combined = prompt.isEmpty()
                ? evidence
                : "【请严格按下面的要求处理材料，只输出 JSON，不要解释】\n\n"
                        + prompt
                        + "\n\n===== 以下是证据材料 =====\n\n"
                        + evidence;

        // 剪贴板仍然放一份：万一某个 AI 只让粘贴、不吃分享。
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("接入提示词", combined));

        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, "平台接入（提示词 + 证据）");
        send.putExtra(Intent.EXTRA_TEXT, combined);
        startActivity(Intent.createChooser(send, "发给 AI（提示词已一并附上）"));
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onBackPressed() {
        finish();
    }
}
