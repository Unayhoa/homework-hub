package cn.homeworkhub.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 独立的「看看平台页面」窗口。
 *
 * <p>为什么不复用主界面的 WebView（这个决定是被真机逼出来的）：
 * 在主 WebView 里 {@code loadUrl} 平台页面，会在**同一个历史栈**里留下若干条记录。
 * 用户返回应用后再侧滑，就又退进平台页了。先后试过两种补救：
 * <ul>
 *   <li>{@code goBack()} —— 只退一条，平台内部跳几次就退不干净；</li>
 *   <li>{@code clearHistory()}（在 loadUrl 之后 / onPageFinished 里各试一次）—— 仍不稳。</li>
 * </ul>
 * 根因是"两个不同性质的页面共用一个历史栈"，清理时机永远在打补丁。
 * 换成一个独立 Activity 后，主界面历史里**一条平台记录都不会有**，
 * 侧滑行为自然回到"应用自己的返回栈"。
 *
 * <p>Cookie 不需要搬运：{@link CookieManager} 是进程级单例，
 * 这里直接就是用户在应用内登录后的会话。
 */
public class BrowseActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String referer = getIntent().getStringExtra(EXTRA_REFERER);
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }

        // ── 顶部返回条 ──
        // 必须显式给一个退出入口：平台页面里没有"返回应用"这种东西，
        // 而 WebView 不给返回条时用户只能杀掉整个应用。
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        Button back = new Button(this);
        back.setText("← 返回应用");
        back.setAllCaps(false);
        back.setGravity(Gravity.CENTER_VERTICAL);
        back.setOnClickListener(v -> finish());
        root.addView(back, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText(url);
        title.setTextSize(10f);
        title.setTextColor(Color.GRAY);
        title.setSingleLine(true);
        title.setPadding(24, 0, 24, 8);
        root.addView(title);

        WebView webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 与主界面的 WebView 保持一致：平台会按 UA 决定给哪套前端
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 这个窗口里的一切导航都留在窗口内 —— 用户点"返回应用"才离开
                return false;
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        if (referer != null && !referer.isEmpty()) {
            // 超星会校验来源页；不带会被回「无权限」
            java.util.Map<String, String> h = new java.util.HashMap<>();
            h.put("Referer", referer);
            webView.loadUrl(url, h);
        } else {
            webView.loadUrl(url);
        }
    }

    @Override
    public void onBackPressed() {
        // 系统返回 = 关掉这个窗口，回到应用（而不是在平台页面里后退）
        finish();
    }

}
