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

    static final String ACTION_PROBE = "cn.homeworkhub.app.KEEPALIVE";

    /**
     * 探测间隔下限 15 分钟。
     * 端口声明里写着「间隔不得短于 15 分钟」，这里做最后一道闸 ——
     * 配置算错就变成高频轮询，那正是用户明确要求避免的事。
     */
    private static final long MIN_INTERVAL_MS = 15 * 60 * 1000L;
    private static final long DEFAULT_INTERVAL_MS = 30 * 60 * 1000L;
    /** 保留最近多少条探测记录（滚动窗口） */
    private static final int KEEP_LOG = 40;

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
        long at = System.currentTimeMillis() + intervalMs(ctx);
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, probePendingIntent(ctx));
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

        String ua = userAgent(ctx);
        long nowMs = System.currentTimeMillis();
        for (int i = 0; i < probes.length(); i++) {
            JSONObject p = probes.optJSONObject(i);
            if (p == null) continue;
            String url = p.optString("url", "");
            if (url.isEmpty()) continue;
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
            appendLog(ctx, platformId, kind, status, note, nowMs);
            Log.i(TAG, "保活探测 " + platformId + " kind=" + kind + " status=" + status);
        }
    }

    // ---------------------------------------------------------------- 记录

    private static synchronized void appendLog(
            Context ctx, String platformId, String kind, int status, String note, long atMs) {
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
