package cn.homeworkhub.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;

/**
 * 应用外壳：一个 WebView + 一个原生小工具条。
 *
 * ── 整体结构 ──
 *   页面（我们的引擎，跑在 WebView 里）
 *     └── fetch('/api/...')  → main.js 拦截 → 引擎 → HttpBridge（原生网络）→ 平台
 *
 * 页面资源从 https://appassets.androidplatform.net 提供（WebViewAssetLoader）。
 * 用这个虚拟 https 域而不是 file:// 的原因：file:// 下 ES Module
 * 会被 CORS 拦掉（模块加载必须同源），整个前端会白屏。
 *
 * ── 登录流程（这是「不影响你正常用平台」的关键）──
 * 点「登录平台」→ 本 WebView 直接打开平台官网 → 你在官方页面上正常登录 →
 * cookie 进入 Android 的 CookieManager → 引擎的原生请求自动带上它。
 * 我们不接触密码，也拿不到 cookie（JS 侧看不到 HttpOnly cookie）。
 */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";

    /** 采集平台配置的请求码（BrowseActivity 回传结果用）。 */
    private static final int REQ_CAPTURE = 1001;

    /** 当前 WebView 里显示的是哪个平台（null = 应用自身的界面）。 */
    private String activePlatformId;
    /**
     * 「只是去看看」模式：从待办点进平台页面。
     *
     * 与 activePlatformId 的区别只有一个 —— 返回应用时**不**当成一次登录：
     * 不登记账号、不触发同步。用户只是去看一眼题目，任何副作用都是打扰。
     */
    // 说明：平台页面的"只是看看"模式已改为独立 Activity（BrowseActivity），
    // 不再占用主 WebView 的历史栈。这里不再需要 browsing 标记。

    WebView webView;
    /**
     * 登录期间的原生返回条。
     *
     * 只在「用户正在平台登录页」时出现，而且只有一个「返回应用」按钮 ——
     * 登录入口统一放在账号页的「添加账号」里（同一个功能两个入口只会让人困惑）。
     * 默认整条隐藏，不占界面。
     */
    private LinearLayout toolbar;
    private Button btnBack;
    private HttpBridge bridge;
    private WebViewAssetLoader assetLoader;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#FFFFFF"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        // 键盘弹出时不要顶掉整个界面
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        // 通知渠道必须在弹第一条通知之前建好（Android 8+ 没有渠道的通知会被直接丢弃）。
        // 建渠道不需要任何权限，所以放在 onCreate 里一次就好。
        NotificationScheduler.ensureChannel(this);

        // ---- WebView ----
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        // localStorage：我们的持久化存储层（PersistentStore）依赖它
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        // Cookie：必须在加载任何页面之前设置
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        bridge = new HttpBridge(this);
        webView.addJavascriptInterface(bridge, "Android");

        // 会话保活：探测请求要与 App 内请求共用同一个 UA（平台可能按 UA 判定客户端），
        // 而 UA 只在主线程取得到 —— 所以在这里落一份存起来，之后后台闹钟直接用。
        // 另外把已有配置的闹钟恢复上（进程重启后内存里的排期会丢）。
        KeepAliveScheduler.setUserAgent(this, webViewUserAgent());
        // 让「前台服务 + 闹钟」与当前开关一致：进程重启/被清理之后，
        // 常驻服务不会自己回来，而"夜里也有网"正是靠它 —— 每次打开 App 都补一次。
        KeepAliveScheduler.ensureScheduled(this);

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WwwPathHandler())
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // 只接管我们自己的资源；平台页面走网络
                if (request.getUrl().toString().startsWith(APP_ORIGIN)) {
                    WebResourceResponse r = assetLoader.shouldInterceptRequest(request.getUrl());
                    if (r != null) return r;
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // 自己的页面照常走
                if (url.startsWith(APP_ORIGIN)) return false;
                // 登录流程内的跳转全部放行（SSO 会有多次重定向，中途接管会打断登录）
                if (activePlatformId != null) return false;
                // 已经在浏览某个平台页面了 → 页面内跳转放行，别再套一层

                // 其余外部链接：用「浏览模式」打开 —— 有返回条，返回时不登记账号、不触发同步。
                //
                // 为什么在导航层接、而不是只靠 JS 桥：<a target="_blank"> 在 WebView 里
                // 走的是"新窗口"回调，而本应用没有 setSupportMultipleWindows ——
                // 结果是**点了完全没反应**（既不导航也不报错）。导航层拦截不挑链接写法，
                // 普通 <a href> 也能接住，是更可靠的一层。
                openBrowsePage(url, null);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url.startsWith(APP_ORIGIN)) {
                    // 从平台登录页回到了应用界面
                    final String justLoggedIn = activePlatformId;
                    activePlatformId = null;
                    updateBar();
                    // 应用是单页，WebView 历史对它没有意义；但平台浏览留下的条目会让
                    // "回到应用后再侧滑"退进平台页。
                    // 这里清而不是在 loadUrl 之后立刻清：loadUrl 是异步的，
                    // 紧接着 clearHistory 时新条目可能还没入栈，清不干净（真机复现过）。
                    view.clearHistory();

                    if (justLoggedIn != null) {
                        // 用户刚在官方页面上登录完 → 立刻登记账号并读取一次。
                        // cookie 已经在 CookieManager 里了，原生请求会自动带上。
                        // 但雨课堂等平台的 API token 存在 localStorage（不在 cookie）——
                        // 所以返回前先把 localStorage 快照读出来，一起传给登记流程。
                        final WebView v = view;
                        // 只取 token 形态的键，且限制单项长度 ——
                        // 全量 localStorage 快照可能几 MB（平台会存大量缓存），
                        // 那是个既没必要又危险的负载（真机上表现为 Invalid string length）。
                        // 我们只需要 token，最小化搬运。
                        final String readStorage = justLoggedIn.contains("yuketang")
                                ? "(function(){try{var o={};for(var i=0;i<localStorage.length;i++){"
                                        + "var k=localStorage.key(i);"
                                        + "if(/auth|token/i.test(k)){var v=localStorage.getItem(k)||'';"
                                        + "if(v.length<=8000)o[k]=v;}}"
                                        + "return JSON.stringify(o);}catch(e){return null;}})()"
                                : "null";
                        v.evaluateJavascript(readStorage, storageJson -> {
                            String storage = storageJson;
                            // 硬上限：任何情况下都不把巨型字符串拼进 JS 源码
                            if (storage != null && storage.length() > 200_000) storage = null;
                            if (storage != null && storage.length() >= 2 && storage.startsWith("\"")) {
                                // evaluateJavascript 返回的是 JSON 字符串字面量，解一层引号
                                try {
                                    storage = (String) new org.json.JSONTokener(storage).nextValue();
                                } catch (Exception ignored) { }
                            } else if ("null".equals(storage)) {
                                storage = null;
                            }
                            final String storageArg = storage;
                            final String js =
                                    "window.HH&&window.HH.returnedFromLogin&&window.HH.returnedFromLogin("
                                            + org.json.JSONObject.quote(justLoggedIn) + ","
                                            + (storageArg == null ? "null" : org.json.JSONObject.quote(storageArg)) + ")";
                            final android.os.Handler h = new android.os.Handler();
                            final int[] tries = {0};
                            final Runnable[] fire = new Runnable[1];
                            fire[0] = () -> {
                                tries[0] += 1;
                                v.evaluateJavascript(js, result -> {
                                    // HH 未就绪时表达式求值结果是 undefined
                                    if ((result == null || "undefined".equals(result) || "null".equals(result))
                                            && tries[0] < 5) {
                                        h.postDelayed(fire[0], 400);
                                    } else if (result == null || "undefined".equals(result) || "null".equals(result)) {
                                        android.widget.Toast.makeText(
                                                MainActivity.this,
                                                "页面脚本未就绪，读取未自动开始 —— 请手动点一次同步",
                                                android.widget.Toast.LENGTH_LONG).show();
                                    }
                                });
                            };
                            fire[0].run();
                        });
                    } else {
                        view.evaluateJavascript("window.HH&&window.HH.refresh&&window.HH.refresh()", null);
                    }
                }
            }
        });

        // WebView 默认不响应 alert()/confirm() —— 必须挂 WebChromeClient，
        // 否则页面里的确认对话框会静默失败（真机踩过：删除按钮点了没反应）。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });

        setContentView(buildLayout());
        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        // ---- 原生返回条（默认隐藏，只在平台登录页期间出现）----
        // 这里曾经放过「课业中枢」标题和「登录平台」按钮，都去掉了：
        // 标题不是操作、登录入口应该唯一（账号页 → 添加账号）。
        toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(6), dp(10), dp(6));
        toolbar.setBackgroundColor(Color.parseColor("#F7F8FA"));
        toolbar.setVisibility(View.GONE);

        TextView barHint = new TextView(this);
        barHint.setText("在平台页面完成登录后，点右侧返回");
        barHint.setTextSize(12.5f);
        barHint.setTextColor(Color.parseColor("#5C6068"));
        toolbar.addView(
                barHint,
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        btnBack = new Button(this);
        btnBack.setText("返回应用");
        btnBack.setTextSize(12.5f);
        btnBack.setOnClickListener(v -> webView.loadUrl(APP_ORIGIN + "/index.html"));
        toolbar.addView(btnBack);

        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    // 这里曾有 showLoginPicker()（原生弹窗选平台）—— 已删除。
    // 它硬编码了一份平台清单与登录地址，而账号页的「添加账号」已经能给出一份
    // 由适配器声明、永远最新的清单（含各平台真实的登录页地址）。
    // 两份清单并存必然会漂移，所以保留后者、去掉前者。

    /**
     * 申请通知权限（Android 13+）。
     *
     * 只问一次：用户拒过之后再弹系统框是打扰（而且第二次拒绝后系统也不会再弹），
     * 之后由界面上的提示引导他去系统设置里开。所以这里用持久化的「问过没」标记，
     * 而不是每次排期都问。
     */
    void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (NotificationScheduler.hasPermission(this)) return;
        if (NotificationScheduler.askedBefore(this)) return;
        NotificationScheduler.markAsked(this);
        requestPermissions(
                new String[]{"android.permission.POST_NOTIFICATIONS"},
                REQUEST_NOTIFICATION_PERMISSION);
    }

    /** 跳系统里的「本应用通知设置」页 —— 被拒过之后唯一的补救路径。 */
    void openNotificationSettings() {
        try {
            android.content.Intent it = new android.content.Intent(
                    android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            it.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(it);
        } catch (Exception e) {
            Toast.makeText(this, "打不开通知设置，请手动到系统设置里找本应用", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * APK 的**真实**版本号（从 PackageManager 读，不是写死的常量）。
     *
     * 为什么要露出来：这个项目出过两次"以为装了新版、其实还是旧版"的事故
     * （一次是构建脚本的版本号替换静默失配，一次是构建失败后把旧包复制成了新版本号）。
     * 排障时第一件要确定的事就是"你跑的是哪一版"—— 让它在界面上直接可见，
     * 比每次靠行为反推靠谱得多。
     */
    String appVersion() {
        try {
            android.content.pm.PackageInfo info =
                    getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "?" : info.versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** 供页面显示提示：通知权限到底有没有。 */
    String notificationPermissionStatus() {
        return NotificationScheduler.hasPermission(this) ? "granted" : "denied";
    }

    /**
     * 本应用是否已被系统放进「电池优化白名单」。
     *
     * 为什么这件事值得露在界面上：应用级的「允许后台运行 / 自启动 / 不优化耗电」
     * 与 Doze 是**两套机制** —— 真机上那几个开关全部放行，夜里请求仍然 DNS 不可达。
     * 不把这个状态显示出来，用户只能靠反复试错去猜，而每一次试错代价是一整晚。
     */
    String batteryOptimizationStatus() {
        try {
            android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
            if (pm == null) return "unknown";
            return pm.isIgnoringBatteryOptimizations(getPackageName()) ? "granted" : "denied";
        } catch (Exception e) {
            return "unknown";
        }
    }

    /**
     * 请求把本应用加入「电池优化白名单」（系统弹窗）。
     *
     * 这是 Android 官方给的、唯一能豁免 Doze 网络限制的通道。某些 ROM 把这个入口
     * 关了，所以失败时退回到「电池优化」列表页，让用户自己找 —— 两条路都不通才提示手动。
     */
    void requestIgnoreBatteryOptimizations() {
        try {
            android.content.Intent it = new android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            it.setData(android.net.Uri.parse("package:" + getPackageName()));
            startActivity(it);
        } catch (Exception e) {
            try {
                startActivity(new android.content.Intent(
                        android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception e2) {
                Toast.makeText(this, "打不开电池优化设置，请手动到系统设置里找本应用", Toast.LENGTH_LONG).show();
            }
        }
    }

    /**
     * 跳系统的「电池」页。
     *
     * 为什么需要它（2026-10-13 定案）：真机排查了四天，最终定位到 realme UI 的
     * 「睡眠待机优化」—— 一个**设备级**开关，它不在 Doze 体系里，
     * 所以电池优化白名单和前台服务都管不到它；关掉它之后，夜里 5.5 小时
     * 「请求发不出去」的黑洞立刻消失（探针从 11 次未测成降到 1 次，会话 22.8 小时没掉）。
     *
     * 问题是**没有标准 Intent 能直接打开厂商那一页**（各 ROM 的自定义 Activity 名不可猜，
     * 猜错就是一次静默失败）。所以退一步：打开系统的电池页，用户从那里走
     * 「省电设置 → 其他设置 → 睡眠待机优化」。ACTION_POWER_USAGE_SUMMARY 是标准 action，
     * 但个别 ROM 也会拦，所以失败时还要再退一层到应用详情页。
     */
    void openBatterySettings() {
        try {
            startActivity(new android.content.Intent(
                    android.content.Intent.ACTION_POWER_USAGE_SUMMARY));
        } catch (Exception e) {
            try {
                android.content.Intent it = new android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                it.setData(android.net.Uri.parse("package:" + getPackageName()));
                startActivity(it);
            } catch (Exception e2) {
                Toast.makeText(this, "打不开电池设置，请手动到系统设置里找「电池 / 省电」", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATION_PERMISSION) return;
        // 授权结果只影响「界面上的提示文案」，不需要重排闹钟 ——
        // 闹钟的注册本来就不需要通知权限，只有显示通知时才检查权限。
        if (webView != null) {
            webView.evaluateJavascript("window.HH&&window.HH.refresh&&window.HH.refresh()", null);
        }
    }

    private static final int REQUEST_NOTIFICATION_PERMISSION = 1002;

    /** 由 HttpBridge 调用：在同一个 WebView 里打开平台登录页。 */
    /**
     * 只是打开一个页面看看（点作业名去平台）。
     * 不设置 activePlatformId —— 所以返回时不会走"疑似登录完成"那条路。
     * 仍然显示顶部返回条：否则用户会困在平台页面里只能杀进程。
     */
    /**
     * @param referer 部分平台（超星）会校验来源页，从外部直接打开会回「无权限」；
     *                传空表示不设置（绝大多数平台不需要）。
     */
    /**
     * 打开平台页面给用户看（点作业名）。
     *
     * 用**独立 Activity**，不碰主 WebView 的历史栈 —— 主界面因此永远不会
     * 出现"侧滑退回平台页"的问题（那正是前两版 goBack / clearHistory 没能解决的）。
     *
     * @param referer 超星等平台会校验来源，不带给会回「无权限」
     */
    void openBrowsePage(String url, String referer) {
        if (url == null || url.isEmpty()) return;
        if ((referer == null || referer.isEmpty()) && url.contains("chaoxing.com")) {
            referer = "https://i.chaoxing.com";
        }
        android.content.Intent i = new android.content.Intent(this, BrowseActivity.class);
        i.putExtra(BrowseActivity.EXTRA_URL, url);
        i.putExtra(BrowseActivity.EXTRA_REFERER, referer);
        startActivity(i);
    }

    /**
     * DOM 模式入口：交给 DomExtractor 在后台跑一个页面，结果回给网页层。
     *
     * 回调统一走 window.HH.domResult —— 和 httpRequest 的 resolve/reject 是同一套思路：
     * **所有原生异步都给"成功/失败 + 数据"两态**，绝不静默。
     */
    void domExtract(String id, String url, String ruleJson) {
        final String prefix =
                "window.HH&&window.HH.domResult&&window.HH.domResult(" + org.json.JSONObject.quote(id) + ",";
        try {
            org.json.JSONObject rule = new org.json.JSONObject(ruleJson);
            DomExtractor.extract(this, url, rule, (ok, payload) ->
                    webView.evaluateJavascript(
                            prefix + ok + "," + org.json.JSONObject.quote(payload) + ")", null));
        } catch (Exception e) {
            webView.evaluateJavascript(
                    prefix + "false," + org.json.JSONObject.quote("提取规则格式不对：" + e.getMessage()) + ")",
                    null);
        }
    }

    /**
     * 打开「采集新平台」窗口。
     *
     * 用 startActivityForResult 而不是 startActivity：采集结果必须**回到应用内**去分析。
     * 以前这里是"导出证据包 → 分享给外部 AI"，数据出去了就断了 ——
     * 用户得自己把 AI 的回答复制回来，而这件事本来可以完全在应用内做完（probe.ts）。
     */
    void openCapturePage(String mode, String name, String url) {
        android.content.Intent i = new android.content.Intent(this, BrowseActivity.class);
        i.putExtra(BrowseActivity.EXTRA_RECORD, true);
        i.putExtra(BrowseActivity.EXTRA_MODE, mode == null || mode.isEmpty() ? "probe" : mode);
        i.putExtra(BrowseActivity.EXTRA_NAME, name);
        // 用户在应用里填的网址直接预填并打开 —— 让他再手打一遍纯属浪费
        i.putExtra(BrowseActivity.EXTRA_URL, url);
        startActivityForResult(i, REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_CAPTURE) return;
        // 用户直接按返回 = 放弃，什么都没发生。不要弹任何提示（他刚才就是在取消）。
        if (resultCode != RESULT_OK || data == null) return;
        String kind = data.getStringExtra(BrowseActivity.EXTRA_RESULT_KIND);
        String json = data.getStringExtra(BrowseActivity.EXTRA_RESULT_JSON);
        if (json == null) return;
        // 统一走 window.HH.captured —— 与 returnedFromLogin 同一套"原生异步两态"约定：
        // 有结果就一条明确的回调，绝不把数据留在原生侧等网页来猜。
        String js = "window.HH&&window.HH.captured&&window.HH.captured("
                + org.json.JSONObject.quote(kind == null ? "probe" : kind) + ","
                + org.json.JSONObject.quote(json) + ")";
        webView.evaluateJavascript(js, null);
    }

    void openLoginPage(String url, String platformId) {
        activePlatformId = platformId;
        updateBar();
        webView.loadUrl(url);
    }

    private void updateBar() {
        // 整条返回条只在平台登录页期间出现 —— 其余时候它只是一个「课业中枢」标题，
        // 白占一行屏幕（用户反馈过）。
        boolean onPlatform = activePlatformId != null; // 只有登录流程需要返回条
        toolbar.setVisibility(onPlatform ? View.VISIBLE : View.GONE);
        btnBack.setVisibility(onPlatform ? View.VISIBLE : View.GONE);
    }

    void evaluateJs(String js) {
        if (webView != null) webView.evaluateJavascript(js, null);
    }

    String webViewUserAgent() {
        String ua = webView.getSettings().getUserAgentString();
        return ua == null || ua.isEmpty() ? "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36" : ua;
    }

    @Override
    public void onBackPressed() {
        if (activePlatformId != null) {
            // 必须 loadUrl + clearHistory，不能只 goBack()：
            // 浏览平台时会在历史里留下若干条（平台页面内部还会跳几次）。
            // goBack 只退一条，用户回到待办页后再侧滑，就又退进平台页面了 ——
            // 真机反馈的"返回应用后侧滑又回到平台"就是这个。
            // 清空历史后，应用页是唯一一条记录，再侧滑就是正常退出 App。
            webView.loadUrl(APP_ORIGIN + "/index.html");
            webView.clearHistory();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // canGoBack 为 false，但网页层可能还有筛选 / 弹层 —— 先问一句再决定退不退。
        // 真机反馈：筛选中按返回直接退出 App，因为 pushState 的层级没有反映到 canGoBack。
        webView.evaluateJavascript(
                "window.HH&&window.HH.backDepth?window.HH.backDepth():0",
                depth -> {
                    if (depth != null && !depth.equals("0") && !depth.equals("null")) {
                        webView.evaluateJavascript("window.HH&&window.HH.back&&window.HH.back()", null);
                    } else {
                        finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 立刻落盘，避免丢掉最后一批写入（存储层是去抖写的）
        webView.evaluateJavascript("window.HH&&window.HH.flush&&window.HH.flush()", null);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.evaluateJavascript("window.HH&&window.HH.refresh&&window.HH.refresh()", null);
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /**
     * 把 assets/www 下的文件当作 WebView 的资源提供。
     *
     * 不直接用 AssetsPathHandler 是因为它的路径是 assets/<path>，
     * 而我们的产物在 assets/www/ 下（保持和桌面端一致的目录结构）。
     */
    private class WwwPathHandler implements WebViewAssetLoader.PathHandler {
        @Override
        public WebResourceResponse handle(String path) {
            String clean = path.startsWith("/") ? path.substring(1) : path;
            if (clean.isEmpty()) clean = "index.html";
            // 简单的目录穿越防护：编译产物不该出现 ../
            if (clean.contains("..")) return notFound();
            try {
                InputStream is = getAssets().open("www/" + clean);
                return new WebResourceResponse(guessMime(clean), "utf-8", is);
            } catch (IOException e) {
                return notFound();
            }
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<>(), null);
        }
    }

    /** ES Module 必须拿到正确的 MIME，否则 WebView 会拒绝执行。 */
    private static String guessMime(String path) {
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @SuppressWarnings("unused")
    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
