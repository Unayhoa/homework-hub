package cn.homeworkhub.app;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 原生 HTTP 桥。
 *
 * 存在的唯一理由：WebView 里的 fetch 受同源策略约束，而教学平台不会给
 * 我们页面的 origin（https://appassets.androidplatform.net）下发 CORS 头。
 * 更麻烦的是 fetch 的 CORS 失败是**静默返回空**，
 * 而空数据在本应用里等于「我作业不见了」——最糟糕的失败形态。
 *
 * 原生请求不受 CORS 约束，并且能与 WebView 共享 CookieManager：
 * 用户在 App 内的 WebView 里正常登录平台，之后原生请求自动带上那份 cookie。
 * Cookie 全程只存在于 Android 的 CookieManager 里，从不进入 JS ——
 * 这是「凭据不过手」在手机上的落地方式。
 */
public class HttpBridge {

    private static final String TAG = "HomeworkHub";

    /*
     * `cookieNames(url)` 已随 cookie 诊断一起移除（2026-10-13）。
     * 它只服务于「iSmart 到底断在哪一环」那个问题，而结论早已确定：
     * cookie 一直在本机，掉线是服务端闲置作废 + 夜里没网。
     * 留着一个只报名不报值的诊断接口，等于给自己留一条随时可能被误用的读凭据通道。
     */

    private static final int MAX_REDIRECTS = 5;
    private static final Pattern CHARSET_RE =
            Pattern.compile("charset\\s*=\\s*[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE);

    private final MainActivity activity;
    // 8 线程：适配器侧是 6 路并行拉取，池要略大于并行度才不会排队
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private final android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
    /**
     * User-Agent 必须在主线程一次性取好缓存起来。
     * 请求都跑在工作线程上，而 Android 强制要求所有 WebView 方法
     * （包括 getSettings().getUserAgentString()）只能在主线程调用 ——
     * 在工作线程里碰它直接抛 Throwable，整个请求就废了（真机已踩过）。
     */
    private final String userAgent;

    HttpBridge(MainActivity activity) {
        this.activity = activity;
        // 构造发生在 Activity.onCreate（主线程），此时取 UA 是安全的
        this.userAgent = activity.webViewUserAgent();
    }

    /** JS → 原生。立刻返回，结果通过 evaluateJavascript 回调（不阻塞 JS 线程）。 */
    @android.webkit.JavascriptInterface
    public void httpRequest(String id, String method, String url, String headersJson, String body) {
        final String ua = this.userAgent;
        pool.execute(() -> {
            try {
                String result = perform(ua, method, url, headersJson, body);
                callback("resolve", id, result);
            } catch (Throwable t) {
                Log.w(TAG, "请求失败 " + method + " " + url, t);
                callback("reject", id, jsonMessage(String.valueOf(t.getMessage())));
            }
        });
    }

    /** 在同一个 WebView 里打开平台登录页（cookie 由此进入 CookieManager）。 */
    /**
     * 只是打开一个页面看看（点作业名去平台），返回时**不**登记账号、不触发同步。
     * 与 openLogin 共用同一个 WebView 和返回条，区别只在"回来之后做什么"。
     */
    @android.webkit.JavascriptInterface
    public void openBrowse(final String url, final String referer) {
        if (url == null || url.isEmpty()) return;
        activity.runOnUiThread(() -> activity.openBrowsePage(url, referer));
    }

    /**
     * DOM 模式：离屏加载页面并按选择器抓表格。结果通过 window.HH.domResult(id, ok, payload) 回来。
     *
     * 走桥而不是让 JS 自己开窗口，是因为「创建 WebView」这件事只有原生能做，
     * 而且必须复用系统 CookieManager 里已有的登录态。
     */
    @android.webkit.JavascriptInterface
    public void domExtract(final String id, final String url, final String ruleJson) {
        activity.domExtract(id, url, ruleJson);
    }

    /**
     * 打开「采集新平台」界面：注入记录器 → 用户登录并看到作业列表 → 回传给应用内分析。
     *
     * @param mode "probe"（默认，自动认接口）或 "dom"（点选页面元素）
     * @param name 平台名，只用于界面文案
     * @param url  用户在应用里已经填过的网址 —— 传下去预填，省他再打一遍
     */
    @android.webkit.JavascriptInterface
    public void openCapture(final String mode, final String name, final String url) {
        activity.runOnUiThread(() -> activity.openCapturePage(mode, name, url));
    }

    @android.webkit.JavascriptInterface
    public void openLogin(final String url, final String platformId) {
        // 兼容旧调用：没有 accountId 时按普通「应用内登录」处理。
        openLoginWithAccount(url, platformId, null);
    }

    /**
     * 「一键重登」入口：额外带上 targetAccountId，登录返回时把会话登记到**同一个账号**
     * （保留课程勾选/改名），而不是新建一个 `platform::browser`。
     *
     * 为什么要从原生侧传：targetAccountId 若只存在 JS 全局里，切到官方登录页再回来
     * 时 WebView 可能已重载，全局丢失 → 退化成新建账号、重拉全部课程、改名全废
     * （真机 2026-11-09 就是这么坏的）。原生侧字段能跨页面存活。
     */
    @android.webkit.JavascriptInterface
    public void openLoginWithAccount(final String url, final String platformId, final String accountId) {
        Log.i(TAG, "打开平台登录页 " + platformId + " accountId=" + accountId + " -> " + url);
        activity.runOnUiThread(() -> activity.openLoginPage(url, platformId, accountId));
    }

    /**
     * 立刻弹一条系统通知。
     *
     * 注意：截止提醒**不**走这里 —— 它走 scheduleReminders 排期（到点由系统闹钟触发）。
     * 这里留给「此刻就该让用户知道」的场景。
     */
    @android.webkit.JavascriptInterface
    public void notify(String title, String body) {
        NotificationScheduler.post(activity, title, body);
    }

    /**
     * 下发「未来要弹的通知」排期（全量替换）。
     *
     * 页面负责算，原生只负责按时叫醒 —— 领域逻辑（哪些任务、提前多久、夜间顺延）
     * 全在 JS 侧，改规则不需要动原生代码。
     *
     * @param json [{key,title,body,fireAtMs,dueAtMs}, ...]
     */
    /**
     * 【诊断】返回 CookieManager 里某个 URL 可见的 cookie **名字**（不返回值）。
     *
     * 为什么需要它（真机 2026-11-10）：WebView 里明明是已登录状态（页面能打开课程），
     * 但原生请求一直 403。要么 cookie 没写进 CookieManager、要么写进了但域不匹配、
     * 要么 native 读的时候还没 flush。这三者从 JS 侧完全看不出来 ——
     * 所以直接问原生"你到底看得见哪些 cookie"，一次就能定位。
     */
    @android.webkit.JavascriptInterface
    public String cookieNames(final String url) {
        try {
            String raw = android.webkit.CookieManager.getInstance().getCookie(url);
            // 目标域取不到就退到父域（与 perform() 的跨子域回退一致）——
            // 否则诊断会显示"API 域没 cookie"，而其实 cookie 在主域上、请求也带得上。
            if (raw == null || raw.isEmpty()) {
                String parent = registrableDomain(url);
                if (parent != null) {
                    raw = android.webkit.CookieManager.getInstance().getCookie("https://" + parent + "/");
                }
            }
            if (raw == null || raw.isEmpty()) return "[]";
            org.json.JSONArray arr = new org.json.JSONArray();
            for (String part : raw.split(";")) {
                String name = part.split("=")[0].trim();
                if (!name.isEmpty()) arr.put(name);
            }
            return arr.toString();
        } catch (Throwable t) {
            return "[\"__error__:" + String.valueOf(t.getMessage()).replace("\"", "'").replace("\n", " ") + "\"]";
        }
    }

    @android.webkit.JavascriptInterface
    public void scheduleReminders(String json) {
        NotificationScheduler.syncSchedule(activity, json);
        // 有提醒要排说明用户在意这件事 —— 顺手把通知权限要一下。
        // 只问一次，被拒之后由界面上的提示引导去系统设置。
        if (json != null && !json.trim().equals("[]")) {
            activity.runOnUiThread(activity::ensureNotificationPermission);
        }
    }

    /** APK 真实版本号（界面显示，用于确认"你跑的是哪一版"）。 */
    @android.webkit.JavascriptInterface
    public String appVersion() {
        return activity.appVersion();
    }

    /** 通知权限状态：'granted' / 'denied'（界面据此显示提示）。 */
    @android.webkit.JavascriptInterface
    public String notificationPermission() {
        return activity.notificationPermissionStatus();
    }

    /** 跳到系统的「本应用通知设置」页。 */
    @android.webkit.JavascriptInterface
    public void openNotificationSettings() {
        activity.runOnUiThread(activity::openNotificationSettings);
    }

    // ---------------------------------------------------------------- 会话保活

    /**
     * 下发「探活探测」的配置（全量替换）。
     *
     * 配置由 JS 侧从适配器的 keepAliveProbe 声明里生成 —— 原生不理解任何平台，
     * 只认识「每隔多久、往哪个地址发个什么请求、响应命中什么正则算活着」。
     * 这和通知排期是同一条分工原则：**JS 负责算，原生负责按时叫醒**。
     */
    @android.webkit.JavascriptInterface
    public void scheduleKeepAlive(String json) {
        KeepAliveScheduler.applyConfig(activity, json);
    }

    @android.webkit.JavascriptInterface
    public void setKeepAliveEnabled(boolean enabled) {
        // 排期读写 SharedPreferences 与 AlarmManager，主线程更稳妥
        activity.runOnUiThread(() -> KeepAliveScheduler.setEnabled(activity, enabled));
    }

    /** 跳系统的「电池」页 —— 引导用户关掉厂商的睡眠省电开关（详见 MainActivity）。 */
    @android.webkit.JavascriptInterface
    public void openBatterySettings() {
        activity.runOnUiThread(activity::openBatterySettings);
    }

    /** 保活状态与最近若干次探测记录（诊断展示用）。 */
    @android.webkit.JavascriptInterface
    public String keepAliveState() {
        return KeepAliveScheduler.stateJson(activity);
    }

    /** 电池优化白名单状态：'granted' / 'denied' / 'unknown'。 */
    @android.webkit.JavascriptInterface
    public String batteryOptimizationStatus() {
        return activity.batteryOptimizationStatus();
    }

    /**
     * 系统 Android 版本（`androidVersion()`）已随前台服务一起移除。
     * 它当初是为「API 35 对 dataSync 型前台服务有每日时长上限」这个风险添加的，
     * 前台服务砍掉之后没有读者了 —— 诊断通道用完就撤，不留没人看的接口。
     */

    /** 请求加入电池优化白名单（系统弹窗；不加的话息屏久了后台请求会被 Doze 掐掉）。 */
    @android.webkit.JavascriptInterface
    public void requestIgnoreBatteryOptimizations() {
        activity.runOnUiThread(activity::requestIgnoreBatteryOptimizations);
    }

    /** 页面上报日志，方便真机排查（adb logcat -s HomeworkHub）。 */
    @android.webkit.JavascriptInterface
    public void log(String level, String message) {
        Log.i(TAG, "[" + level + "] " + message);
    }

    // ---------------------------------------------------------------- 键值存储

    /**
     * 引擎状态的持久化：JS 侧的 WebStorage 落到这里。
     *
     * 为什么不用 WebView 的 localStorage（真机踩过，症状非常典型）：
     * localStorage 是「先写内存、由浏览器引擎择机刷盘」。App 被从最近任务里
     * 划掉时进程直接被杀（不会有正常的 onPause 时机），**未刷盘的那部分就丢了** ——
     * 表现为「同步后都显示正常，清除后台重进就少了最后同步的那个平台」
     * （超星 84 条，正好是最后写入的一批）。
     *
     * 这里改成同步写文件 + fsync：写成功就是真的落盘了，不依赖任何时机。
     */
    private static final String KV_DIR = "hh-kv";

    /** 键名要当文件名用 —— 用 base64url 编码，既安全又可逆（不需要额外映射表）。 */
    private static String encodeKey(String key) {
        return android.util.Base64.encodeToString(
                key.getBytes(StandardCharsets.UTF_8),
                android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }

    private static String decodeKey(String fileName) {
        String bare = fileName.endsWith(".json") ? fileName.substring(0, fileName.length() - 5) : fileName;
        return new String(
                android.util.Base64.decode(bare, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP),
                StandardCharsets.UTF_8);
    }

    private java.io.File kvFile(String key) {
        java.io.File dir = new java.io.File(activity.getFilesDir(), KV_DIR);
        if (!dir.exists()) dir.mkdirs();
        return new java.io.File(dir, encodeKey(key) + ".json");
    }

    @android.webkit.JavascriptInterface
    public String kvGet(String key) {
        java.io.File f = kvFile(key);
        if (!f.exists()) return null;
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] bytes = new byte[(int) f.length()];
            int off = 0;
            while (off < bytes.length) {
                int n = in.read(bytes, off, bytes.length - off);
                if (n < 0) break;
                off += n;
            }
            return new String(bytes, 0, off, StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "kvGet 失败: " + key, e);
            return null;
        }
    }

    @android.webkit.JavascriptInterface
    public boolean kvSet(String key, String value) {
        java.io.File dst = kvFile(key);
        java.io.File tmp = new java.io.File(dst.getParentFile(), dst.getName() + ".tmp");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
            out.write(value.getBytes(StandardCharsets.UTF_8));
            out.flush();
            // 关键：强制刷到磁盘。少了这一步，进程被杀时数据可能还在页缓存里，
            // 那就又回到了 localStorage 的老问题上。
            out.getFD().sync();
        } catch (Exception e) {
            Log.w(TAG, "kvSet 失败: " + key, e);
            return false;
        }
        // 原子替换：先写临时文件再改名 —— 写一半被杀也不会毁掉旧数据
        if (tmp.renameTo(dst)) return true;
        return dst.delete() && tmp.renameTo(dst);
    }

    @android.webkit.JavascriptInterface
    public boolean kvRemove(String key) {
        java.io.File f = kvFile(key);
        return !f.exists() || f.delete();
    }

    /** 返回全部键名（换行分隔，原样，未编码）。 */
    @android.webkit.JavascriptInterface
    public String kvKeys() {
        java.io.File dir = new java.io.File(activity.getFilesDir(), KV_DIR);
        java.io.File[] files = dir.listFiles();
        if (files == null) return "";
        StringBuilder sb = new StringBuilder();
        for (java.io.File f : files) {
            String n = f.getName();
            if (!n.endsWith(".json")) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(decodeKey(n));
        }
        return sb.toString();
    }

    void shutdown() {
        pool.shutdownNow();
    }

    // ---------------------------------------------------------------- 请求实现

    /**
     * 真正的请求实现。**static** 是有意为之：后台保活探测
     * （{@link KeepAliveReceiver}，跑在 App 没打开、甚至进程刚被拉起的场景）
     * 要发的是同一类请求，必须复用同一份逻辑 —— 包括那些踩过坑的细节
     * （逐跳收集 Set-Cookie、iSmart 的 CASTGC→Bearer、雨课堂的 xtbz/x-csrftoken）。
     * 复制一份到探测里，就等于埋一个"两边行为会漂移"的雷。
     */
    static String perform(String userAgent, String method, String url, String headersJson, String body) throws Exception {
        final android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        Map<String, String> headers = parseHeaders(headersJson);
        String currentUrl = url;
        String currentMethod = method == null ? "GET" : method.toUpperCase();
        String currentBody = body;
        int status = 0;
        String contentType = null;
        Map<String, String> responseHeaders = new HashMap<>();
        byte[] payload;
        /** 【诊断】本次请求实际带上的 cookie 概况（随响应回传，见 toJson） */
        String cookieDebug = "";

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(currentUrl).openConnection();

            // 手动处理重定向：中间跳转下发的 Set-Cookie 必须收集起来，
            // 否则超星/雨课堂的「POST 登录 → 302 主页 → 主页下发会话」链路会丢会话。
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(25000);
            conn.setRequestMethod(currentMethod);
            conn.setRequestProperty("User-Agent", userAgent);

            // 关键：把 CookieManager 里属于这个域的 cookie 带上。
            //
            // 【跨子域回退，2026-11-10 真机定位】超星的登录会话 cookie（_uid/fid/UID/xxtenc…）
            // 是在 i.chaoxing.com 上种下的，而业务接口在 mooc1-api.chaoxing.com /
            // mooc1.chaoxing.com / passport2.chaoxing.com。原生按**目标 URL** 取 cookie 时，
            // 某些实现只做精确域匹配，于是"WebView 明明已登录、原生请求却 403"。
            // 浏览器能工作是因为这些 cookie 带 Domain=.chaoxing.com。
            // 这里补一层：目标域取不到就退到父域再取一次（只回退到注册域，不跨站）。
            String cookie = cookieManager.getCookie(currentUrl);
            boolean usedParentFallback = false;
            if (cookie == null || cookie.isEmpty()) {
                String parent = registrableDomain(currentUrl);
                if (parent != null) {
                    cookie = cookieManager.getCookie("https://" + parent + "/");
                    usedParentFallback = cookie != null && !cookie.isEmpty();
                }
            }
            if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            // 【诊断】记录这次请求**实际发出去的 cookie 名字**（不含值）。
            // 用局部变量随响应回传，不用 static 字段 —— 并发请求会互相覆盖，
            // 而且另开桥方法在同步期间会被 WebView 拒成 non-injected（真机连踩两次）。
            cookieDebug = describeCookies(currentUrl, cookie, usedParentFallback);

            // 雨课堂（Django 系）的 API 要求 x-csrftoken 头与会话配对，
            // 值就在它自己种的 csrftoken cookie 里 —— 网页 XHR 由框架自动带，原生请求要自己补。
            // 学堂在线系（雨课堂）的网关要求 xtbz 系统标识头，缺失直接 40000（XTBZ IS REQUIRED）
            if (currentUrl.contains("yuketang")) {
                conn.setRequestProperty("xtbz", "ykt");
                try {
                    java.net.URL u2 = new java.net.URL(currentUrl);
                    if (!headers.containsKey("Referer")) {
                        conn.setRequestProperty("Referer", u2.getProtocol() + "://" + u2.getHost() + "/");
                    }
                } catch (Exception ignored) { }
            }

            if (currentUrl.contains("yuketang") && cookie != null
                    && !headers.containsKey("x-csrftoken") && !headers.containsKey("X-csrftoken")) {
                java.util.regex.Matcher cm = java.util.regex.Pattern
                        .compile("(?:^|; )csrftoken=([^;]*)").matcher(cookie);
                if (cm.find()) conn.setRequestProperty("X-csrftoken", cm.group(1));
            }

            // iSmart：CASTGC 是 sso 下发的 JWT（domain=.ismartlearning.cn，随请求已带上）。
            // school 接口若按 Bearer 校验，这个头就是钥匙；若按 cookie 校验则此头被忽略 —— 无害。
            if (currentUrl.contains("ismartlearning.cn") && cookie != null
                    && !headers.containsKey("Authorization")) {
                java.util.regex.Matcher tm = java.util.regex.Pattern
                        .compile("(?:^|; )CASTGC=([^;]*)").matcher(cookie);
                if (tm.find()) conn.setRequestProperty("Authorization", "Bearer " + tm.group(1));
            }

            // 智慧树：网关对缺 Origin/Referer 的请求可能直接回 403「未登录」，
            // 看起来像会话失效，其实是请求形状不对（2026-11-09 排查）。这里按域补齐。
            if (currentUrl.contains("zhihuishu.com")) {
                try {
                    java.net.URL uz = new java.net.URL(currentUrl);
                    String origin = uz.getProtocol() + "://" + uz.getHost();
                    if (!headers.containsKey("Origin")) conn.setRequestProperty("Origin", origin);
                    if (!headers.containsKey("Referer")) conn.setRequestProperty("Referer", origin + "/");
                } catch (Exception ignored) { }
            }

            for (Map.Entry<String, String> e : headers.entrySet()) {
                String name = e.getKey();
                if (name.equalsIgnoreCase("cookie") || name.equalsIgnoreCase("user-agent")) continue;
                conn.setRequestProperty(name, e.getValue());
            }

            if (currentBody != null && !currentMethod.equals("GET") && !currentMethod.equals("HEAD")) {
                conn.setDoOutput(true);
                byte[] raw = currentBody.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(raw.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(raw);
                }
            }

            status = conn.getResponseCode();
            contentType = conn.getContentType();
            responseHeaders.clear();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                responseHeaders.put(e.getKey(), e.getValue().get(0));
            }
            // 收集并写回 cookie
            List<String> setCookies = conn.getHeaderFields().get("Set-Cookie");
            if (setCookies != null) {
                for (String sc : setCookies) cookieManager.setCookie(currentUrl, sc);
                cookieManager.flush();
            }

            boolean redirect = status >= 300 && status < 400;
            String location = conn.getHeaderField("Location");
            if (redirect && location != null) {
                currentUrl = new URL(new URL(currentUrl), location).toString();
                if (status == 303 || status == 302 || (status == 301 && currentMethod.equals("POST"))) {
                    currentMethod = "GET";
                    currentBody = null;
                }
                conn.disconnect();
                continue;
            }

            payload = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
            conn.disconnect();
            // 二进制响应（图片/字体等）不能按文本解码回传 —— 文本解码会破坏字节。
            // 以 base64 附带原样字节，JS 侧 bytes() 优先使用它。
            boolean isText = contentType != null && (contentType.toLowerCase().startsWith("text/")
                    || contentType.toLowerCase().contains("json")
                    || contentType.toLowerCase().contains("javascript")
                    || contentType.toLowerCase().contains("xml"));
            String binaryBase64 = isText ? null : android.util.Base64.encodeToString(payload, android.util.Base64.NO_WRAP);
            return toJson(
                    status, currentUrl, responseHeaders,
                    isText ? decode(payload, contentType) : "", binaryBase64,
                    cookieDebug);
        }
        throw new IllegalStateException("重定向次数超过 " + MAX_REDIRECTS + " 次，可能存在登录死循环");
    }

    /**
     * 响应体上限：8MB。
     *
     * 为什么需要这个上限（真机踩过）：某个请求意外打到大文件或流式端点时，
     * 响应会被全量读成字符串，几亿字符的字符串在 JS 侧直接抛
     * 「Invalid string length」——错误信息完全指不到真正的原因。
     * 业务上我们只需要 HTML/JSON（最大几 MB），8MB 绰绰有余；
     * 超限就截断并标记，让调用方看到「被截断」而不是一个莫名其妙的报错。
     */
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;

    /**
     * 回调进 WebView 的字符串上限（**这个才是 Invalid string length 的真正来源**）。
     *
     * 为什么单独设一个比响应体更小的上限：
     *   callback() 要把整个 resultJson 再 `JSONObject.quote()` 一遍（转义 + 加引号），
     *   8MB 的响应转义后字符串可能翻倍，再拼进 evaluateJavascript 的 JS 源码里，
     *   整个 JS 字符串连同 V8 内部的 rope 结构足以触碰引擎上限，在 JS 侧抛
     *   「Invalid string length」—— 而错误信息里完全看不到是哪个请求、多大。
     *
     * 所以：超过这个字节数就**在原生侧就截断为一条结构化错误**（带 url / 字节数），
     * 让 JS 收到一条正常的小 JSON，而不是一个把错误盖掉的怪异常。
     */
    private static final int MAX_CALLBACK_BYTES = 512 * 1024;

    private static boolean lastTruncated = false;

    private static byte[] readAll(InputStream in) throws Exception {
        lastTruncated = false;
        if (in == null) return new byte[0];
        try (InputStream is = in; ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = is.read(buf)) > 0) {
                if (total + n > MAX_RESPONSE_BYTES) {
                    bos.write(buf, 0, MAX_RESPONSE_BYTES - total);
                    lastTruncated = true;
                    break;
                }
                bos.write(buf, 0, n);
                total += n;
            }
            return bos.toByteArray();
        }
    }

    /**
     * 按声明的 charset 解码；没有声明时先严格试 UTF-8，失败再退 GBK。
     *
     * 为什么值得这么麻烦：国内不少教学平台仍然返回 GBK 编码的页面/接口。
     * 一律按 UTF-8 解会把中文变成乱码，而乱码会一路传到解析层，
     * 表现为「标题全是什么éƒ¨」或者 JSON.parse 直接失败。
     */
    private static String decode(byte[] bytes, String contentType) {
        String declared = null;
        if (contentType != null) {
            Matcher m = CHARSET_RE.matcher(contentType);
            if (m.find()) declared = m.group(1);
        }
        if (declared != null) {
            try {
                return new String(bytes, Charset.forName(declared));
            } catch (Exception ignored) {
                // 平台声明了一个不认识的 charset，落到下面的探测
            }
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            try {
                return new String(bytes, "GBK");
            } catch (Exception e2) {
                return new String(bytes, StandardCharsets.UTF_8);
            }
        }
    }

    private static String toJson(int status, String url, Map<String, String> headers, String text) {
        return toJson(status, url, headers, text, null, null);
    }

    private static String toJson(int status, String url, Map<String, String> headers, String text, String binaryBase64) {
        return toJson(status, url, headers, text, binaryBase64, null);
    }

    private static String toJson(
            int status, String url, Map<String, String> headers, String text,
            String binaryBase64, String cookieDebug) {
        try {
            JSONObject o = new JSONObject();
            o.put("status", status);
            o.put("url", url);
            JSONObject h = new JSONObject();
            for (Map.Entry<String, String> e : headers.entrySet()) {
                // Set-Cookie 不回传 JS：cookie 只活在 CookieManager 里
                if (e.getKey().equalsIgnoreCase("set-cookie")) continue;
                h.put(e.getKey(), e.getValue());
            }
            // 【诊断】把「这次请求实际带的 cookie 概况」作为**响应头**回传。
            //
            // 为什么用响应头而不是另开一个桥方法（真机 2026-11-10 连踩两次）：
            // 同步期间调用额外的 @JavascriptInterface 方法会被 WebView 拒成
            // "can't be invoked on a non-injected page"，诊断自己失效、什么也看不到。
            // 而响应头是**已经回到 JS 的那条数据**的一部分，永远可用，且不必改 HttpResponse 接口。
            if (cookieDebug != null && !cookieDebug.isEmpty()) h.put("x-hh-cookie-debug", cookieDebug);
            o.put("headers", h);
            o.put("text", text);
            if (binaryBase64 != null) o.put("binaryBase64", binaryBase64);
            if (lastTruncated) o.put("truncated", true);
            return o.toString();
        } catch (Exception e) {
            return "{\"status\":500,\"url\":\"\",\"text\":\"\",\"error\":\"序列化响应失败\"}";
        }
    }

    /**
     * 取 URL 的「注册域」（如 mooc1-api.chaoxing.com → chaoxing.com）。
     *
     * 用途：CookieManager 按目标 URL 取不到 cookie 时，退到父域再取一次 ——
     * 很多平台把会话 cookie 种在主域（Domain=.chaoxing.com），子域 API 依赖它。
     *
     * 只处理「最后两段」的常见形态，并对少数二级后缀（edu.cn / com.cn）多退一段，
     * 不做完整 Public Suffix List —— 这里只用于**同站回退**，退错也只会取不到，不会串站。
     */
    private static String registrableDomain(String url) {
        try {
            String host = new java.net.URL(url).getHost();
            if (host == null || host.isEmpty()) return null;
            String[] parts = host.split("\\.");
            if (parts.length < 3) return null; // 已经是裸域（chaoxing.com），无需回退
            String last2 = parts[parts.length - 2] + "." + parts[parts.length - 1];
            String last3 = parts.length >= 3
                    ? parts[parts.length - 3] + "." + last2
                    : last2;
            if (last2.equals("edu.cn") || last2.equals("com.cn") || last2.equals("org.cn")
                    || last2.equals("net.cn") || last2.equals("gov.cn")) {
                return last3;
            }
            return last2;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 描述一次请求实际带上的 cookie（只名字，不含值）。
     * 结果随 HTTP 响应体一起回传（见 toJson 的 cookieDebug 字段），
     * 不依赖额外的桥调用 —— 那个在同步期间会被 WebView 拒成 non-injected。
     */
    private static String describeCookies(String url, String cookie, boolean fallback) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(url.replaceAll("\\?.*$", ""));
            sb.append(fallback ? "（用父域回退）" : "（直接命中）");
            if (cookie == null || cookie.isEmpty()) {
                sb.append(" cookie=空");
            } else {
                java.util.List<String> names = new java.util.ArrayList<>();
                for (String part : cookie.split(";")) {
                    String n = part.split("=")[0].trim();
                    if (!n.isEmpty()) names.add(n);
                }
                sb.append(" cookie=").append(names.size()).append("个[").append(String.join(",", names)).append("]");
            }
            return sb.toString();
        } catch (Throwable t) {
            return url + " cookie解析失败";
        }
    }

    private static Map<String, String> parseHeaders(String json) {
        Map<String, String> out = new HashMap<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONObject o = new JSONObject(json);
            JSONArray names = o.names();
            if (names == null) return out;
            for (int i = 0; i < names.length(); i++) {
                String k = names.getString(i);
                out.put(k, o.optString(k));
            }
        } catch (Exception e) {
            Log.w(TAG, "解析请求头失败: " + json, e);
        }
        return out;
    }

    private static String jsonMessage(String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("message", message == null ? "未知错误" : message);
            return o.toString();
        } catch (Exception e) {
            return "{\"message\":\"未知错误\"}";
        }
    }

    /** 通过 evaluateJavascript 回调页面里的 __hhBridge（必须在 UI 线程）。 */
    private void callback(String kind, String id, String payloadJson) {
        // 【错误定位】回调体积检查。
        // 这一行是为了彻底钉死「Invalid string length」而留的：如果某个响应在
        // JSONObject.quote 之后仍然过大，说明真正的上限在这儿被突破。此时不把
        // 巨型字符串塞进 evaluateJavascript（那会在 JS 侧炸掉、错误还指不到原因），
        // 而是回一条结构化的小 JSON，明确写清 url 与字节数。
        int payloadBytes = payloadJson == null ? 0 : payloadJson.length();
        String out = payloadJson;
        if (payloadBytes > MAX_CALLBACK_BYTES) {
            Log.w(TAG, "回调体积超限 id=" + id + " kind=" + kind + " bytes=" + payloadBytes);
            out = "{\"status\":500,\"url\":\"\",\"text\":\"\",\"error\":\"响应体过大被拦截（"
                    + payloadBytes + " 字节，上限 " + MAX_CALLBACK_BYTES
                    + "）。这是 Invalid string length 的根因定位点：请求返回的不是作业 JSON，而是大文件/流式页面。\"}";
        }
        final String js = "window.__hhBridge&&window.__hhBridge." + kind + "("
                + JSONObject.quote(id) + "," + JSONObject.quote(out) + ")";
        activity.runOnUiThread(() -> activity.evaluateJs(js));
    }
}
