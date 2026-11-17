package cn.homeworkhub.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * 「会话保活探测」的定时排期与结果记录。
 *
 * ── 为什么需要它（两个目的，缺一个都不该做）──
 * 1. **测量**：有些平台（iSmart）的会话是服务端会话，闲置一段时间就作废。
 *    「到底能活多久」这个问题没法靠用户盯着表回答，只能由代码定时打点 +
 *    记录「时刻 / 距上次官方登录多久 / 结果」。攒几条就能定出寿命区间。
 * 2. **减少掉线**：如果失效确实是闲置超时，那么定时发一个最便宜的只读请求
 *    本身就能把闲置计时续上 —— 掉线率随之下降。
 *
 * ── 为什么用闹钟而不是 WebView 里的定时器 ──
 * 探测的价值恰恰在「App 没打开」的时候。JS 定时器在切后台后被节流，
 * App 被划掉后更是连进程都没了；只有系统闹钟能在那一刻把我们叫醒
 * （与截止提醒是同一个理由，见 {@link NotificationScheduler}）。
 *
 * ── 为什么不做成前台服务 / 常驻通知 ──
 * 前台服务确实更可靠（不受 Doze 推迟），但代价是通知栏常驻一个图标，
 * 而且 Android 14+ 对 dataSync 类前台服务还有每日时长上限 —— 长期反而更不可靠。
 * 间隔 30 分钟、会话闲置阈值约 2 小时，留给 Doze 推迟的余量是够的。
 *
 * ── 请求量 ──
 * 每次探测只发 **1 个** 只读请求（平台自己的探活接口），30 分钟一次 = 一天 48 个，
 * 比用户自己刷两下网页还轻。绝不能为了探活去拉业务数据。
 */
final class KeepAliveScheduler {

    private static final String TAG = "HomeworkHub";
    private static final String PREFS = "hh_keepalive";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_CONFIG = "config";
    private static final String KEY_LOG = "log";
    private static final String KEY_UA = "ua";
    private static final String KEY_NEXT = "nextAt";
    /**
     * 【快速重试】网络抖一下不该让会话白死一整个周期。
     *
     * 真机 2026-11-14：13:53 探活成功 → 14:13 DNS 解析失败（手机没网）→ 14:27 同步时
     * 智慧树已失效。中间只有一次失败，但下一次闹钟要等到 14:33 —— **整整 20 分钟的
     * 空档，足够服务端把会话判成闲置作废**。
     * 所以在「未测成」之后不按常规间隔排期，而是 2 分钟后重试（最多 3 次），
     * 网络恢复后能立刻续上，不用等下一个周期。
     */
    private static final String KEY_RETRY_AT = "retryAt";
    private static final String KEY_RETRY_N = "retryN";
    private static final long RETRY_DELAY_MS = 2 * 60 * 1000L;
    private static final int RETRY_MAX = 3;

    static final String ACTION_PROBE = "cn.homeworkhub.app.KEEPALIVE";

    /**
     * 探测间隔下限 15 分钟。
     * 端口声明里写着「间隔不得短于 15 分钟」，这里做最后一道闸 ——
     * 配置算错就变成高频轮询，那正是用户明确要求避免的事。
     */
    private static final long MIN_INTERVAL_MS = 15 * 60 * 1000L;
    private static final long DEFAULT_INTERVAL_MS = 30 * 60 * 1000L;
    /** 保留最近多少条探测记录（滚动窗口） */
    /**
     * 保留最近多少条探测记录（滚动窗口）。
     *
     * 2026-11-10 从 40 提到 400：40 条 × 20 分钟 ÷ 2 个平台 ≈ **6.7 小时**，
     * 而用户要判断的是「智慧树能不能连续活过 9–10 小时」——
     * 窗口比观测期还短，等于无法自证（结论只能是"最近 6.7 小时内没掉"）。
     * 400 条 ≈ 66 小时（2.7 天），足以覆盖一整夜的掉线判断。
     *
     * 2026-11-14 再提到 600：智慧树探活间隔从 20 分钟缩到 15 分钟，
     * 400 条只能覆盖 50 小时了（400÷2×15min）。600 条回到 75 小时，
     * 保住"能看清一整段连续存活"这个用途。每条只有几个小字段，体积可忽略。
     */
    private static final int KEEP_LOG = 600;

    /**
     * 记录格式版本。v3 修正了 v2 迁移的一个错：v2 只用 status 判断类别，
     * 忘了 ok=true 本身就是"成功探测"，于是把 8 条成功记录标成了「会话失效」。
     * 迁移逻辑本身是幂等的（有 kind 也用 ok 复核一遍），所以直接抬版本号再跑一次。
     */
    private static final String LOG_SCHEMA = "3";
    private static final String KEY_SCHEMA = "schema";

    /** 探测结果的三种类别 —— 分得开才谈得上"下结论"。 */
    static final String KIND_OK = "ok";
    /** 拿到了应答，但它不像一个有效会话（会话真的失效了） */
    static final String KIND_AUTH = "auth";
    /** 请求没测成（网络不可达 / 对端 5xx）—— **不能**据此判断会话如何 */
    static final String KIND_UNREACHABLE = "unreachable";

    private KeepAliveScheduler() {}

    // ---------------------------------------------------------------- 配置

    /**
     * 全量替换探测配置。JS 侧从适配器声明里取来（只有适配器知道自家探活接口）。
     *
     * @param json {intervalMs, probes:[{platformId,url,method,body,alivePattern}]}
     */
    static void applyConfig(Context ctx, String json) {
        String clean = json == null ? "" : json.trim();
        String prev = prefs(ctx).getString(KEY_CONFIG, "");
        if (!clean.equals(prev)) {
            prefs(ctx).edit().putString(KEY_CONFIG, clean).apply();
            Log.i(TAG, "保活探测配置已更新，长度 " + clean.length());
        }
        // 配置没变**也不要重排闹钟**：JS 每次打开 App 都会下发一遍配置，
        // 每次都重排就等于把下一次探测无限往后推 ——「每 30 分钟一次」永远不会发生。
        // 所以这里用 ensureScheduled（幂等、不打断已有排期），**不能用 reschedule**。
        ensureScheduled(ctx);
    }

    static void setEnabled(Context ctx, boolean enabled) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply();
        Log.i(TAG, "保活探测开关 = " + enabled);
        if (enabled) {
            reschedule(ctx);
        } else {
            cancel(ctx);
        }
    }

    static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ENABLED, true);
    }

    /** UA 只在主线程取得到（WebView 的限制），所以由 Activity 落一份存起来给后台用。 */
    static void setUserAgent(Context ctx, String ua) {
        if (ua == null || ua.isEmpty()) return;
        prefs(ctx).edit().putString(KEY_UA, ua).apply();
    }

    static String userAgent(Context ctx) {
        String ua = prefs(ctx).getString(KEY_UA, "");
        return ua == null || ua.isEmpty() ? "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36" : ua;
    }

    private static JSONObject config(Context ctx) {
        String raw = prefs(ctx).getString(KEY_CONFIG, "");
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            Log.w(TAG, "保活配置损坏，已忽略: " + e.getMessage());
            return null;
        }
    }

    static long intervalMs(Context ctx) {
        JSONObject cfg = config(ctx);
        long v = cfg == null ? DEFAULT_INTERVAL_MS : cfg.optLong("intervalMs", DEFAULT_INTERVAL_MS);
        return v < MIN_INTERVAL_MS ? MIN_INTERVAL_MS : v;
    }

    private static int probeCount(Context ctx) {
        JSONObject cfg = config(ctx);
        JSONArray arr = cfg == null ? null : cfg.optJSONArray("probes");
        return arr == null ? 0 : arr.length();
    }

    // ---------------------------------------------------------------- 排期

    /**
     * 「确保有排期」：没有待触发的排期时才排一个。**幂等、且不打断已有排期**。
     *
     * 为什么不能每次都重排：App 每次切到前台都会走到这里，
     * 重排就等于把下一次探测一直往后推 —— 写的是"每 30 分钟一次"，
     * 实际效果却是"只要你在用手机就永远不探测"。
     */
    static void ensureScheduled(Context ctx) {
        if (!isEnabled(ctx) || probeCount(ctx) == 0) {
            cancel(ctx);
            return;
        }
        if (prefs(ctx).getLong(KEY_NEXT, 0L) > System.currentTimeMillis()) return;
        scheduleNext(ctx);
    }

    /** 无条件重排（开机、用户重新打开开关时用 —— 那时旧排期已经作废）。 */
    static void reschedule(Context ctx) {
        if (!isEnabled(ctx) || probeCount(ctx) == 0) {
            cancel(ctx);
            return;
        }
        scheduleNext(ctx);
    }

    /** 排下一次探测。闹钟是单次的，每次触发后由接收器再排下一次。 */
    static void scheduleNext(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        long delay = intervalMs(ctx);
        // 「未测成」后的快速重试：用更短的间隔补一次，别让网络抖动吃掉整个周期
        long retryAt = prefs(ctx).getLong(KEY_RETRY_AT, 0L);
        if (retryAt > System.currentTimeMillis()) {
            delay = Math.max(60_000L, retryAt - System.currentTimeMillis());
        }
        long at = System.currentTimeMillis() + delay;
        try {
            // 【精确闹钟，提升保活覆盖率】（2026-11-17 真机）
            //
            // 真机实测：探活覆盖率只有 **79%**（近 24h 成功 76/96 次），
            // 而智慧树会话只要空腹 ~30 分钟就作废 —— 漏一次探测就可能掉线。
            //
            // 原来用 `setAndAllowWhileIdle`：它**允许在 Doze 中触发，但时间不精确**，
            // 系统可以随意推迟（合并唤醒以省电）。这就是那 20% 缺口的来源。
            // `setExactAndAllowWhileIdle` 在 Doze 中也能按点触发。
            // Android 12+ 需要「闹钟与提醒」权限，未授予会抛 SecurityException →
            // 此时**降级回不精确版本**，绝不因此让保活停摆。
            boolean exact = false;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                try {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, probePendingIntent(ctx));
                    exact = true;
                } catch (SecurityException se) {
                    Log.w(TAG, "无精确闹钟权限，降级为不精确排期: " + se.getMessage());
                }
            }
            if (!exact) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, probePendingIntent(ctx));
            }
            prefs(ctx).edit().putLong(KEY_NEXT, at).apply();
        } catch (Exception e) {
            Log.w(TAG, "保活探测排期失败: " + e.getMessage());
        }
    }

    static void cancel(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am != null) {
            try {
                // FLAG_NO_CREATE：只找已存在的，找不到返回 null（不新建一个空闹钟）
                PendingIntent pi = PendingIntent.getBroadcast(
                        ctx, 0, probeIntent(ctx),
                        PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (pi != null) {
                    am.cancel(pi);
                    pi.cancel();
                }
            } catch (Exception ignored) {
            }
        }
        prefs(ctx).edit().remove(KEY_NEXT).apply();
    }

    private static Intent probeIntent(Context ctx) {
        Intent it = new Intent(ctx, KeepAliveReceiver.class);
        it.setAction(ACTION_PROBE);
        // data 参与 PendingIntent 匹配 —— 固定值 = 全局只有一个探测闹钟
        it.setData(Uri.parse("hhkeepalive://probe"));
        return it;
    }

    /** 全局唯一的一枚探测 PendingIntent（requestCode 与 data 都固定）。 */
    private static PendingIntent probePendingIntent(Context ctx) {
        return PendingIntent.getBroadcast(
                ctx, 0, probeIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ---------------------------------------------------------------- 执行探测

    /**
     * 跑一轮探测并记录结果。由 {@link KeepAliveReceiver} 在后台线程调用。
     *
     * 注意：这里**不接回会话**。自动接回的逻辑只在 JS 侧（适配器的 recoverSession）
     * 有一份 —— 在原生侧再实现一遍，两条实现必然会漂移，
     * 而"掉了有时候能自己好、有时候不能"正是我们最想避免的体验。
     * 探测只负责两件事：把最便宜的请求发出去（顺带续活）、把结果记下来。
     */
    static void runProbe(Context ctx) {
        JSONObject cfg = config(ctx);
        if (cfg == null) return;
        JSONArray probes = cfg.optJSONArray("probes");
        if (probes == null || probes.length() == 0) return;

        /** 本轮是否有「未测成」（网络不通）—— 决定要不要 2 分钟后快速重试 */
        boolean anyUnreachable = false;

        String ua = userAgent(ctx);
        long nowMs = System.currentTimeMillis();
        for (int i = 0; i < probes.length(); i++) {
            JSONObject p = probes.optJSONObject(i);
            if (p == null) continue;
            String url = p.optString("url", "");
            if (url.isEmpty()) continue;
            // 【占位符替换】`{now}` → 当前毫秒时间戳。
            //
            // 为什么必须在这里做（真机 2026-11-10）：智慧树的 getLoginUserInfo 要求
            // `?time=<毫秒>`，而探针地址是 JS 侧一次性下发的静态字符串，写死成
            // `time=1` 会被平台当成异常请求、直接回「未登录」——于是**好会话被误判
            // 成掉线**，用户看到"智慧树又失效了"却其实只是探针参数不对。
            // 也不能靠 JS 回调生成：原生是定时唤醒的，那时 JS 可能根本没在运行。
            if (url.contains("{now}")) {
                url = url.replace("{now}", String.valueOf(nowMs));
            }
            String method = p.optString("method", "GET");
            String body = p.optString("body", "");
            String pattern = p.optString("alivePattern", "");
            String platformId = p.optString("platformId", "");

            int status = 0;
            String note = "";
            // 结果的**类别**，而不是简单的成功/失败。
            //
            // 真机踩过（2026-10-10 夜）：一夜 27 次探测里 17 次被记成「会话失效」，
            // 实际全是 `Unable to resolve host`（DNS 解析不了，请求压根没发出去）。
            // 那根本不能说明会话怎么样 —— 是我们自己没测成。
            // 把网络故障伪装成会话失效，正是本项目最忌讳的失败形态：
            // 它会让人得出"平台策略限制、掉线不可避免"这种彻底错误的结论。
            // 引擎侧早就修过一次同类问题（网络错误不标 auth-required），保活这条链路漏了。
            String kind;
            try {
                // 用与 App 内请求完全相同的实现（同一份 cookie 逻辑、同一套平台特判头）
                String raw = HttpBridge.perform(
                        ua, method, url,
                        "POST".equalsIgnoreCase(method)
                                ? "{\"Content-Type\":\"application/x-www-form-urlencoded\"}"
                                : "{}",
                        body.isEmpty() ? null : body);
                JSONObject r = new JSONObject(raw);
                status = r.optInt("status", 0);
                String text = r.optString("text", "");
                boolean patternOk = pattern.isEmpty()
                        || Pattern.compile(pattern).matcher(text).find();
                if (status == 0 || status >= 500) {
                    // 没有应答，或对端自己的问题 —— 关于会话我们一无所知
                    kind = KIND_UNREACHABLE;
                } else if (patternOk) {
                    kind = KIND_OK;
                } else {
                    // 拿到了应答，只是它不像一个有效会话（iSmart 失效时返回 HTML 登录页）
                    kind = KIND_AUTH;
                }
            } catch (Throwable t) {
                note = String.valueOf(t.getMessage());
                if (note.length() > 120) note = note.substring(0, 120);
                kind = KIND_UNREACHABLE;
            }
            // 【决定性诊断】记录探测那一刻 CookieManager 里还有没有 cookie。
            //
            // 为什么必须分开记（2026-11-11 智慧树反复掉线，两个假设无法区分）：
            //   · cookie 不见了      → 是**浏览器侧 cookie 过期**（可延长/可刷新）
            //   · cookie 还在但 401/403 → 是**服务端会话失效**（硬 TTL 或闲置超时，
            //                            cookie 再有效也没用，只能重新登录）
            // 原来只有「会话失效 HTTP 200」这一句，两种根因长得一模一样，
            // 于是只能在"没网"和"平台策略"之间反复猜。
            int cookieCount = cookieCountFor(url);
            if (KIND_UNREACHABLE.equals(kind)) anyUnreachable = true;
            appendLog(ctx, platformId, kind, status, note, nowMs, cookieCount);
            Log.i(TAG, "保活探测 " + platformId + " kind=" + kind + " status=" + status
                    + " cookies=" + cookieCount);
        }

        // 【快速重试】本轮有「未测成」→ 2 分钟后再补一次（最多 3 次）。
        // 依据：2026-11-14 真机，13:53 成功 → 14:13 断网 → 14:27 会话已失效，
        // 而下一班闹钟在 14:33 —— 20 分钟空档足够服务端判定闲置。
        // 网络一恢复就重试，能把这段空档从 20 分钟压到 2 分钟。
        if (anyUnreachable) {
            int n = prefs(ctx).getInt(KEY_RETRY_N, 0);
            if (n < RETRY_MAX) {
                prefs(ctx).edit()
                        .putLong(KEY_RETRY_AT, System.currentTimeMillis() + RETRY_DELAY_MS)
                        .putInt(KEY_RETRY_N, n + 1)
                        .apply();
                Log.i(TAG, "本轮有未测成，2 分钟后重试（第 " + (n + 1) + "/" + RETRY_MAX + " 次）");
            }
        } else {
            // 全部成功 → 清掉重试计数
            prefs(ctx).edit().remove(KEY_RETRY_AT).remove(KEY_RETRY_N).apply();
        }
    }

    /** 探测 URL 在 CookieManager 里可见的 cookie 数量（只数个数，不读值）。 */
    private static int cookieCountFor(String url) {
        try {
            String raw = android.webkit.CookieManager.getInstance().getCookie(url);
            if (raw == null || raw.isEmpty()) return 0;
            int n = 0;
            for (String part : raw.split(";")) {
                if (!part.trim().isEmpty()) n += 1;
            }
            return n;
        } catch (Throwable t) {
            return -1; // -1 = 读不到（与"0 个"区分开）
        }
    }

    // ---------------------------------------------------------------- 记录

    private static synchronized void appendLog(
            Context ctx, String platformId, String kind, int status, String note, long atMs) {
        appendLog(ctx, platformId, kind, status, note, atMs, -2);
    }

    /**
     * @param cookieCount 探测时该域可见的 cookie 数（-1 读不到，-2 未知/旧调用）
     *
     * 另外：一次 auth 失效时，顺带算出「距上次成功多久」和「中间断网几次」。
     * 这两个数字是区分「硬 TTL」与「闲置超时」的直接证据：
     *   · 每次失效都稳定在 ~14h、且中途没有断网 → 硬 TTL（探活也续不了）
     *   · 失效前的间隔里有一串「未测成」→ 闲置超时（手机深睡没网）
     * 不记这两个数，就只能看着"又失效了"却分不出是哪一种。
     */
    private static synchronized void appendLog(
            Context ctx, String platformId, String kind, int status, String note, long atMs, int cookieCount) {
        try {
            JSONArray arr = new JSONArray(loadLog(ctx));
            JSONObject e = new JSONObject();
            e.put("t", atMs);
            e.put("platformId", platformId);
            e.put("kind", kind);
            // ok 保留：老版本界面只认这个字段，兼容一层不费事
            e.put("ok", KIND_OK.equals(kind));
            e.put("status", status);
            if (!note.isEmpty()) e.put("note", note);
            if (cookieCount != -2) e.put("cookies", cookieCount);
            if (KIND_AUTH.equals(kind)) {
                // 往回扫：找该平台最近一次 ok，并数中间有多少次"未测成"
                long sinceLastOk = -1;
                int gaps = 0;
                for (int i = arr.length() - 1; i >= 0; i--) {
                    JSONObject p = arr.optJSONObject(i);
                    if (p == null) continue;
                    if (!platformId.equals(p.optString("platformId", ""))) continue;
                    String k = p.optString("kind", "");
                    if (KIND_OK.equals(k)) {
                        long t = p.optLong("t", 0L);
                        if (t > 0 && atMs > t) sinceLastOk = atMs - t;
                        break;
                    }
                    if (KIND_UNREACHABLE.equals(k)) gaps += 1;
                }
                if (sinceLastOk > 0) e.put("sinceLastOkMs", sinceLastOk);
                e.put("gapsBefore", gaps);
            }
            arr.put(e);
            // 滚动窗口：只留最近 KEEP_LOG 条
            int drop = arr.length() - KEEP_LOG;
            JSONArray out = new JSONArray();
            for (int i = Math.max(0, drop); i < arr.length(); i++) out.put(arr.get(i));
            prefs(ctx).edit().putString(KEY_LOG, out.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "保活记录写入失败: " + e.getMessage());
        }
    }

    private static String loadLog(Context ctx) {
        ensureSchema(ctx);
        String s = prefs(ctx).getString(KEY_LOG, "[]");
        return s == null || s.isEmpty() ? "[]" : s;
    }

    /**
     * 记录格式迁移。
     *
     * v1（0.1.45 及以前）只存了 `ok`，分不出「会话失效」和「没测成」——
     * 而真机上那 17 条恰恰全是后者，于是被显示成了「会话失效 17 次」。
     *
     * 好消息是 v1 的语义可以**精确还原**，不需要清空重来：旧实现里
     * 请求抛异常时 status 保持 0 且 ok=false；只有"拿到了应答、但内容不像有效会话"
     * 才会 status>0 且 ok=false。所以：
     *   status == 0 → 请求没发出去 → 未测成
     *   status  > 0 → 拿到了应答   → 会话失效
     * 迁移而不是清空：13 小时的时间线比格式整洁值钱（这个判断本身也值得记住 ——
     * 能还原的历史不该为了省事丢掉）。
     */
    private static void ensureSchema(Context ctx) {
        if (LOG_SCHEMA.equals(prefs(ctx).getString(KEY_SCHEMA, ""))) return;
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString(KEY_LOG, "[]"));
            int fixed = 0;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.optJSONObject(i);
                if (e == null) continue;
                String kind = e.optString("kind", "");
                String want;
                if (e.optBoolean("ok", false)) {
                    // v1 里 ok=true 就是**成功探测**。v2 的迁移漏了这一支，
                    // 把 8 条成功的记录误标成了「会话失效」—— 一个把好消息说成坏消息的错
                    // （会让"会话失效"计数虚高，从而把结论推向"平台策略、掉线不可避免"）。
                    want = KIND_OK;
                } else if (kind.isEmpty()) {
                    want = e.optInt("status", 0) == 0 ? KIND_UNREACHABLE : KIND_AUTH;
                } else {
                    want = kind;
                }
                if (!want.equals(kind)) {
                    e.put("kind", want);
                    fixed++;
                }
            }
            prefs(ctx).edit()
                    .putString(KEY_LOG, arr.toString())
                    .putString(KEY_SCHEMA, LOG_SCHEMA)
                    .apply();
            if (fixed > 0) Log.i(TAG, "保活记录类别已修正 " + fixed + " 条");
        } catch (Exception e) {
            Log.w(TAG, "保活记录迁移失败，按清空处理: " + e.getMessage());
            prefs(ctx).edit().putString(KEY_SCHEMA, LOG_SCHEMA).remove(KEY_LOG).apply();
        }
    }

    static void clearLog(Context ctx) {
        prefs(ctx).edit().remove(KEY_LOG).apply();
    }

    /** 给界面看的状态 + 最近记录。 */
    static String stateJson(Context ctx) {
        try {
            JSONArray log = new JSONArray(loadLog(ctx));
            // 三类分别计数：把「会话失效」和「没测成」混在一起，等于让用户在
            // 一个错误的前提上做决定（真机踩过：17 次 DNS 失败被显示成"会话失效 17 次"）
            int sessionFailures = 0;
            int unreachable = 0;
            for (int i = 0; i < log.length(); i++) {
                JSONObject e = log.optJSONObject(i);
                if (e == null) continue;
                String kind = e.optString("kind", "");
                if (KIND_AUTH.equals(kind)) sessionFailures++;
                else if (KIND_UNREACHABLE.equals(kind)) unreachable++;
            }
            JSONObject o = new JSONObject();
            o.put("enabled", isEnabled(ctx));
            o.put("intervalMs", intervalMs(ctx));
            o.put("probeCount", probeCount(ctx));
            o.put("nextAtMs", prefs(ctx).getLong(KEY_NEXT, 0L));
            o.put("sessionFailures", sessionFailures);
            o.put("unreachable", unreachable);
            // 当前到底在保活哪些平台（来自配置里的 probes）。界面据此显示
            // 「正在保活：iSmart、智慧树」而不是笼统地写死某一个平台的名字。
            JSONArray platforms = new JSONArray();
            JSONObject cfg = config(ctx);
            JSONArray probesCfg = cfg == null ? null : cfg.optJSONArray("probes");
            if (probesCfg != null) {
                java.util.Set<String> seen = new java.util.LinkedHashSet<>();
                for (int i = 0; i < probesCfg.length(); i++) {
                    JSONObject p = probesCfg.optJSONObject(i);
                    if (p == null) continue;
                    String pid = p.optString("platformId", "");
                    if (!pid.isEmpty()) seen.add(pid);
                }
                for (String pid : seen) platforms.put(pid);
            }
            o.put("platforms", platforms);
            // ---- 每个平台的「会话连续存活时长」----
            //
            // 这才是判断保活是否有效的量化判据（2026-11-10 用户提出「9-10h 能否作为判据」）：
            // 光看"这段时间没掉"证明不了什么 —— 必须知道**最近一次失效之后连续正常了多久**。
            // 算法：从最新往回扫，遇到该平台最近一次 auth（会话失效）就停；
            //   存活时长 = 最新一条 ok 的时间 − 那次失效的时间（没有失效记录则用日志最早时间）。
            // 同时给出「最长一次连续存活」，用来和"没加保活时"的历史对照。
            JSONObject streaks = new JSONObject();
            java.util.Set<String> pids = new java.util.LinkedHashSet<>();
            for (int i = 0; i < log.length(); i++) {
                JSONObject e = log.optJSONObject(i);
                if (e == null) continue;
                String pid = e.optString("platformId", "");
                if (!pid.isEmpty()) pids.add(pid);
            }
            for (String pid : pids) {
                long lastAuthAt = 0;
                long lastOkAt = 0;
                long earliestAt = 0;
                long bestStreak = 0;
                long streakStart = 0;
                int gapsInCurrent = 0;
                long lastAuthForGaps = 0;
                for (int i = 0; i < log.length(); i++) {
                    JSONObject e = log.optJSONObject(i);
                    if (e == null || !pid.equals(e.optString("platformId", ""))) continue;
                    long t = e.optLong("t", 0L);
                    String kind = e.optString("kind", "");
                    if (t <= 0) continue;
                    if (earliestAt == 0 || t < earliestAt) earliestAt = t;
                    if (KIND_AUTH.equals(kind)) {
                        lastAuthAt = t;
                        lastAuthForGaps = t;
                        streakStart = 0;
                        gapsInCurrent = 0;
                    } else if (KIND_OK.equals(kind)) {
                        lastOkAt = t;
                        if (streakStart == 0) streakStart = t;
                        long len = t - streakStart;
                        if (len > bestStreak) bestStreak = len;
                    } else if (KIND_UNREACHABLE.equals(kind)) {
                        // 「未测成」不打断存活计时（没测成 ≠ 掉线），但必须**计入**——
                        // 否则一段断网之后会话死了，面板还会显示"连续 68 小时"，
                        // 把坏消息说成好消息（2026-11-14 真机就这么误导过）。
                        if (t > lastAuthForGaps) gapsInCurrent += 1;
                    }
                }
                JSONObject s = new JSONObject();
                long from = lastAuthAt > 0 ? lastAuthAt : earliestAt;
                long current = (lastOkAt > 0 && from > 0) ? Math.max(0, lastOkAt - from) : 0;
                s.put("currentStreakMs", current);
                s.put("bestStreakMs", bestStreak);
                s.put("lastAuthAtMs", lastAuthAt);
                s.put("windowFromMs", earliestAt);
                // 【关键】最近一次成功距今多久 —— 面板必须能看到"这条连续有多旧"。
                // 14:27 会话已死，但最后一次成功是 13:53，若只显示"连续 68 小时"，
                // 用户会以为一切正常。
                if (lastOkAt > 0) {
                    s.put("lastOkAtMs", lastOkAt);
                    s.put("sinceLastOkMs", Math.max(0, System.currentTimeMillis() - lastOkAt));
                }
                s.put("gapsInStreak", gapsInCurrent);

                // 【正向指标】近 24 小时「保活覆盖率」= 成功探测次数 / 理论应探测次数。
                //
                // 为什么需要它（用户 2026-11-16 提问）："会话失效次数""当前连续"本质上都是
                // **失败指标**或"没有失败"的推论 —— 用户无法据此判断保活到底有没有在工作，
                // 只能等下一次掉线报错。这个覆盖率是纯正向证据：
                // 它衡量"手机到底有没有按计划把探活请求发出去"，与会话是否失效无关。
                // 覆盖率低 = 手机在深睡掐网（该去改电池设置）；覆盖率高而仍掉线 = 平台策略。
                long since24 = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
                int ok24 = 0;
                int total24 = 0;
                for (int i = 0; i < log.length(); i++) {
                    JSONObject e2 = log.optJSONObject(i);
                    if (e2 == null || !pid.equals(e2.optString("platformId", ""))) continue;
                    long t2 = e2.optLong("t", 0L);
                    if (t2 <= 0 || t2 < since24) continue;
                    total24 += 1;
                    if (KIND_OK.equals(e2.optString("kind", ""))) ok24 += 1;
                }
                long iv = Math.max(1L, intervalMs(ctx));
                int expected24 = (int) Math.round(24.0 * 60 * 60 * 1000 / iv);
                s.put("ok24h", ok24);
                s.put("probes24h", total24);
                s.put("expected24h", expected24);
                s.put("coverage", expected24 > 0 ? Math.min(1.0, (double) ok24 / expected24) : 0.0);
                streaks.put(pid, s);
            }
            o.put("streaks", streaks);
            o.put("log", log);
            return o.toString();
        } catch (Exception e) {
            return "{\"enabled\":false,\"log\":[]}";
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
