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
 * 独立窗口：看平台页面 / 采集「新平台接入」需要的样本。
 *
 * <p>为什么不复用主界面的 WebView：主界面和平台页共用一个历史栈时，
 * 用户返回应用后再侧滑会退进平台页。前两版补救（goBack、clearHistory）都失败，
 * 换成独立 Activity 后主界面历史里一条外部记录都不会有。
 *
 * <p>两种模式：
 * <ul>
 *   <li>普通：从待办点作业名进来，看一个页面；</li>
 *   <li>采集：从账号页「＋ 添加自定义平台」进来，把页面请求记下来**回传给应用内分析**。</li>
 * </ul>
 *
 * <p>采集模式的两个子模式（v0.2.7）：
 * <ul>
 *   <li>probe（默认）：用户登录 + 打开作业列表页 → 点一下「我看到了作业，回应用」→
 *       应用内自动认出接口并当场试抓。**用户只做两次点击**（登录、回应用）。</li>
 *   <li>dom：接口带签名参数、原理上只能读页面时，由应用内引导进来点选作业行。</li>
 * </ul>
 *
 * <p>为什么把结果**回传**而不是像以前那样"导出成 markdown 分享给外部 AI"：
 * 分享出去就断了 —— 用户得自己把 AI 的回答复制回来，而识别本来可以完全在应用内完成。
 * 回传之后，"能不能读出来"当场就知道；只有失败时，才需要那一次复制粘贴。
 */
public class BrowseActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";
    /** true = 采集模式：注入记录器，多出「回应用 / 点选」按钮 */
    public static final String EXTRA_RECORD = "record";
    /** 采集子模式：probe（默认，自动认接口）/ dom（点选页面元素） */
    public static final String EXTRA_MODE = "mode";
    /** 平台名（用户填的或前端兜底的），只用于界面文案 */
    public static final String EXTRA_NAME = "name";

    /** 回传给主界面的三个键（kind + 载荷 + 可有可无的错误原文） */
    public static final String EXTRA_RESULT_KIND = "r_kind";
    public static final String EXTRA_RESULT_JSON = "r_json";
    public static final String EXTRA_RESULT_ERROR = "r_error";

    private WebView webView;
    private TextView status;
    /** 录制模式的地址栏。点选发现"内容在别的网站"时，会把那个地址填进来复用。 */
    private EditText urlInput;
    private boolean recording;
    /** "probe" | "dom" */
    private String mode = "probe";
    private String platformName = "";
    /** 注入脚本只读一次，避免每次页面加载都读盘 */
    private static String RECORDER_JS;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String referer = getIntent().getStringExtra(EXTRA_REFERER);
        recording = getIntent().getBooleanExtra(EXTRA_RECORD, false);
        String m = getIntent().getStringExtra(EXTRA_MODE);
        if (m != null && !m.isEmpty()) mode = m;
        String n = getIntent().getStringExtra(EXTRA_NAME);
        if (n != null) platformName = n;

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
            urlInput = input; // 记下来：跨站内容页的地址要填回这里
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

            if ("dom".equals(mode)) {
                // 页面模式只有这一个动作：点选作业行，当场试抓，成功就带着配置回应用
                Button mark = new Button(this);
                mark.setText("点选作业行");
                mark.setAllCaps(false);
                mark.setOnClickListener(v -> pickAndTest());
                bar.addView(mark, weight(1.4f));
            } else {
                // 主流程：一个按钮。用户不需要选、不需要填、不需要看懂任何东西。
                Button done = new Button(this);
                done.setText("我看到了作业 · 回应用");
                done.setAllCaps(false);
                done.setOnClickListener(v -> returnCapture());
                bar.addView(done, weight(1.6f));
            }

            root.addView(bar);
        }

        status = new TextView(this);
        status.setTextSize(11f);
        status.setTextColor(Color.GRAY);
        status.setPadding(24, 2, 24, 6);
        // 提示语按模式分开：这一步是用户唯一会读的字，不能写成两种模式共用的一句。
        status.setText(recording
                ? ("dom".equals(mode)
                        ? "① 打开并登录  ② 点进「作业列表」  ③ 点「点选作业行」，再点一条作业标题"
                        : "① 打开并登录  ② 点进「作业列表」，确认能看到作业  ③ 点上面那个大按钮")
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
     * 把采集到的样本回传给应用内去分析，然后关掉这个页面。
     *
     * 为什么是"回传"而不是"分享出去"：分享出去就断了 —— 用户得自己把 AI 的回答
     * 再复制回来，而识别这件事本来可以完全在应用内完成（probe.ts）。
     * 回传之后，"能不能读出来"当场就知道；只有失败时，才需要那一次复制粘贴。
     *
     * pageText 不往回传：应用侧只用响应结构判断接口；把整页文本搬过桥既占内存，
     * 又没有任何用途（它是给"外部 AI 看页面"那条老路准备的材料）。
     */
    private void returnCapture() {
        webView.evaluateJavascript("window.__hhDump?window.__hhDump():'null'", value -> {
            try {
                String json = decodeJsString(value);
                if (json == null || json.equals("null")) {
                    toast("还没记录到内容：请先刷新一次页面（记录要在页面加载前注入）");
                    return;
                }
                JSONObject o = new JSONObject(json);
                o.remove("pageText");
                finishWith("probe", o.toString());
            } catch (Exception e) {
                toast("回传失败：" + e.getMessage());
            }
        });
    }

    /**
     * 带着结果关窗。**所有采集路径都从这里出去** ——
     * 否则又会出现"有的结果回传、有的只 toast 一下"的漂移（本项目踩过多次）。
     */
    private void finishWith(String kind, String json) {
        Intent out = new Intent();
        out.putExtra(EXTRA_RESULT_KIND, kind);
        out.putExtra(EXTRA_RESULT_JSON, json);
        setResult(RESULT_OK, out);
        finish();
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
            // 跨网站的内容（超星把课程页嵌在另一个域里）读不到结构。
            // 但它自己的地址是有可能直接打开的 —— 一旦它成了顶层页面，就不跨源了。
            // 所以这里把地址填回输入框，用户点「打开」再点选即可，不用自己抄地址。
            String frameSrc = r.optString("frameSrc", "");
            if (!frameSrc.isEmpty() && urlInput != null) {
                urlInput.setText(frameSrc);
                status.setText(
                        "这块内容在另一个网站里，读不到它的结构。已把它自己的地址填到上面 —— "
                                + "点「打开」进去，再点一次「点选作业行」");
                return;
            }
            // 停在这个页面让人直接再点一次，比"退回应用 → 重新进入"便宜得多
            status.setText("没识别出来：" + r.optString("error") + "。再点一次「点选作业行」，或返回应用改用自动识别");
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
                // 试抓成功 = 这份选择器**当场证明能用**，直接带着配置回应用，
                // 不再让用户"复制 → 返回 → 粘贴"（那是三步，每步都可能放弃）。
                JSONObject result = new JSONObject();
                result.put("config", new JSONObject(buildDomConfig(rowSel, fields)));
                result.put("count", arr.length());
                result.put("sample", sample);
                status.setText("✅ 抓到 " + arr.length() + " 条，正在回应用…");
                finishWith("dom", result.toString());
            } catch (Exception e) {
                status.setText("试抓结果异常：" + e.getMessage() + "。再点一次，或返回应用改用自动识别");
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
            // 取域名主体（wenda.zhihuishu.com → zhihuishu）。
            // 第一段往往只是子域（wenda），拿它当平台名认不出来。
            String[] parts = host == null ? new String[0] : host.split("\\.");
            String key = parts.length >= 2 ? parts[parts.length - 2] : (parts.length == 1 ? parts[0] : "custom");
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

    /** evaluateJavascript 返回的是 JSON 字符串字面量（带引号、转义），先解一层。 */
    private String decodeJsString(String raw) {
        if (raw == null || raw.equals("null")) return null;
        try {
            return (String) new org.json.JSONTokener(raw).nextValue();
        } catch (Exception e) {
            return null;
        }
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onBackPressed() {
        finish();
    }
}
