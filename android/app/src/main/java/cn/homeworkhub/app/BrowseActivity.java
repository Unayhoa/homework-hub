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
            mark.setText("标记为列表页");
            mark.setAllCaps(false);
            mark.setOnClickListener(v -> webView.evaluateJavascript(
                    "window.__hhMark&&window.__hhMark('list_view')", null));
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
        b.append(pageText.length() > 4000 ? pageText.substring(0, 4000) : pageText);
        b.append("\n```\n\n");

        b.append("## 期间发出的 JSON 请求\n\n");
        JSONArray reqs = o.optJSONArray("requests");
        if (reqs == null || reqs.length() == 0) {
            b.append("（没记录到任何 JSON 请求。可能是页面在我注入记录器之前就加载完了 —— 请刷新一次再操作。）\n");
        } else {
            for (int i = 0; i < Math.min(reqs.length(), 40); i++) {
                JSONObject r = reqs.getJSONObject(i);
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

    /** 去掉 URL 里可能是凭据的查询参数值。 */
    private static String scrub(String url) {
        if (url == null) return "";
        return url.replaceAll(
                "(?i)([?&](token|auth|access_token|sign|signature|ticket|key|session|enc)=)[^&]*",
                "$1***");
    }

    private void share(String text) {
        // 提示词放剪贴板，文件内容走系统分享。
        // 不尝试"自动粘贴到另一个 App" —— Android/iOS 都不允许，硬做只能靠无障碍服务，
        // 那既脆弱又有隐私风险。
        if (!prompt.isEmpty()) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("接入提示词", prompt));
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, "平台接入证据包");
        send.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(send, "发给 AI（提示词已复制到剪贴板）"));
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onBackPressed() {
        finish();
    }
}
