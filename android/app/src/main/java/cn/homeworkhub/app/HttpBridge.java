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

    /** 打开「录制新平台」界面：注入记录器 → 用户操作 → 导出证据包给 AI。 */
    @android.webkit.JavascriptInterface
    public void openCapture(final String prompt) {
        activity.runOnUiThread(() -> activity.openCapturePage(prompt));
    }

    @android.webkit.JavascriptInterface
    public void openLogin(final String url, final String platformId) {
        Log.i(TAG, "打开平台登录页 " + platformId + " -> " + url);
        activity.runOnUiThread(() -> activity.openLoginPage(url, platformId));
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
            String cookie = cookieManager.getCookie(currentUrl);
            if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);

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
            return toJson(status, currentUrl, responseHeaders, isText ? decode(payload, contentType) : "", binaryBase64);
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
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
        return toJson(status, url, headers, text, null);
    }

    private static String toJson(int status, String url, Map<String, String> headers, String text, String binaryBase64) {
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
            o.put("headers", h);
            o.put("text", text);
            if (binaryBase64 != null) o.put("binaryBase64", binaryBase64);
            if (lastTruncated) o.put("truncated", true);
            return o.toString();
        } catch (Exception e) {
            return "{\"status\":500,\"url\":\"\",\"text\":\"\",\"error\":\"序列化响应失败\"}";
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
        final String js = "window.__hhBridge&&window.__hhBridge." + kind + "("
                + JSONObject.quote(id) + "," + JSONObject.quote(payloadJson) + ")";
        activity.runOnUiThread(() -> activity.evaluateJs(js));
    }
}
