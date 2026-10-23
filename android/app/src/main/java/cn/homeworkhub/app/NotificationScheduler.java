package cn.homeworkhub.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 截止提醒的「系统闹钟」排期。
 *
 * ── 为什么必须在原生做，而不是 WebView 里发 ──
 * 提醒的时刻（截止前 24 小时）用户几乎肯定没打开 App，而引擎跑在 WebView 的 JS 里：
 * 切后台后 JS 定时器会被系统节流到每分钟最多一次，App 被划掉更是直接连进程都没了。
 * 所以只有系统闹钟能在那一刻把我们叫醒。
 *
 * 分工：JS 负责**算**（哪些任务、什么时刻、通知里写什么 —— 领域逻辑都在那边），
 * 原生只负责**按时叫醒并显示**。原生不重新计算任何东西，它不理解"截止时间"，
 * 只认识「某时刻弹一条某标题、某正文的通知」。
 *
 * ── 两个刻意的取舍 ──
 * 1. 用非精确闹钟（setAndAllowWhileIdle）而不是 setExactAndAllowWhileIdle：
 *    精确闹钟在 Android 12+ 需要 SCHEDULE_EXACT_ALARM，在 14+ 还要用户去系统设置里
 *    单独授权 —— 而作业提醒早几分钟晚几分钟毫无影响，不值得为它加一层授权摩擦。
 * 2. 排期整体替换而不是增量维护：JS 每次重算全量清单，这边先撤销旧的再注册新的。
 *    增量维护听起来省事，但"任务改期/完成/删除"每条路径都得记得撤对应闹钟，
 *    漏一条就是一条幽灵通知。
 */
final class NotificationScheduler {

    private static final String TAG = "HomeworkHub";
    static final String CHANNEL_ID = "hh-deadline";
    private static final String PREFS = "hh_notifications";
    private static final String KEY_SCHEDULE = "schedule";
    private static final String KEY_ASKED = "asked_permission";
    static final String ACTION_FIRE = "cn.homeworkhub.app.REMINDER";

    private NotificationScheduler() {}

    /** 通知渠道（Android 8+ 必须显式创建，否则通知直接被丢弃）。 */
    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "作业截止提醒", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("作业、测验、考试截止前的提醒（截止前 24 小时 / 12 小时等）");
        nm.createNotificationChannel(ch);
    }

    /**
     * 全量替换排期。
     *
     * @param json [{key,title,body,fireAtMs,dueAtMs}, ...]；空数组表示"清空所有提醒"
     */
    static void syncSchedule(Context ctx, String json) {
        ensureChannel(ctx);
        cancelAll(ctx);
        String clean = json == null ? "[]" : json.trim();
        if (clean.isEmpty()) clean = "[]";
        save(ctx, clean);

        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        long nowMs = System.currentTimeMillis();
        int scheduled = 0;
        try {
            JSONArray arr = new JSONArray(clean);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                long fireAt = o.optLong("fireAtMs", 0L);
                // 已经过去的时刻不再注册：闹钟到点就是过去式，注册它只会立刻触发一次，
                // 相当于在同步的瞬间突袭用户一条通知（每轮同步都会再来一次）。
                if (fireAt <= nowMs) continue;
                String key = o.optString("key", "k" + i);
                Intent it = fireIntent(ctx, key);
                it.putExtra("title", o.optString("title", "作业提醒"));
                it.putExtra("body", o.optString("body", ""));
                PendingIntent pi = PendingIntent.getBroadcast(
                        ctx, requestCode(key), it,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi);
                scheduled++;
            }
            Log.i(TAG, "已排期 " + scheduled + " 条截止提醒（清单共 " + arr.length() + " 条）");
        } catch (Exception e) {
            Log.w(TAG, "排期失败: " + e.getMessage());
        }
    }

    /** 撤销已登记的全部闹钟。 */
    static void cancelAll(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        try {
            JSONArray arr = new JSONArray(load(ctx));
            for (int i = 0; i < arr.length(); i++) {
                String key = arr.getJSONObject(i).optString("key", "");
                if (key.isEmpty()) continue;
                // FLAG_NO_CREATE：只找已存在的，找不到返回 null（不新建一个空闹钟）
                PendingIntent pi = PendingIntent.getBroadcast(
                        ctx, requestCode(key), fireIntent(ctx, key),
                        PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (pi != null) {
                    am.cancel(pi);
                    pi.cancel();
                }
            }
        } catch (Exception ignored) {
            // 清单损坏就当作没有可撤销的 —— 顶多多留一个闹钟
        }
    }

    /** 手机重启后闹钟会全部丢失：从本地存的清单重新注册（过去的时刻自动跳过）。 */
    static void rescheduleFromStore(Context ctx) {
        String saved = load(ctx);
        Log.i(TAG, "开机恢复提醒排期，清单长度 " + saved.length());
        syncSchedule(ctx, saved);
    }

    /**
     * 显示一条通知。也供 {@link ReminderReceiver} 在闹钟触发时调用。
     */
    static void post(Context ctx, String title, String body) {
        ensureChannel(ctx);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        // 没有通知权限就什么都没法做 —— 但要留下日志，否则"提醒没弹"会变成玄学
        if (Build.VERSION.SDK_INT >= 33
                && ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "没有通知权限，提醒未显示: " + title);
            return;
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(
                ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title == null ? "作业提醒" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();

        // 用内容做 id：同一条提醒重复投递不会叠成一堆，不同提醒彼此独立
        nm.notify(String.valueOf(title).concat(String.valueOf(body)).hashCode(), n);
    }

    /** 让用户在系统设置里开通知权限（从应用内跳过去，比让他自己找设置路径强）。 */
    static boolean hasPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    static boolean askedBefore(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ASKED, false);
    }

    static void markAsked(Context ctx) {
        prefs(ctx).edit().putBoolean(KEY_ASKED, true).apply();
    }

    // ---------------------------------------------------------------- 内部

    private static Intent fireIntent(Context ctx, String key) {
        Intent it = new Intent(ctx, ReminderReceiver.class);
        it.setAction(ACTION_FIRE);
        // data 参与 PendingIntent 的匹配 —— 保证不同提醒是不同的 PendingIntent，
        // 否则 cancel 会互相误伤（extras 不参与匹配，只有 data/action/component 参与）
        it.setData(Uri.parse("hhreminder://" + Uri.encode(key)));
        return it;
    }

    private static int requestCode(String key) {
        return key.hashCode();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void save(Context ctx, String json) {
        prefs(ctx).edit().putString(KEY_SCHEDULE, json).apply();
    }

    private static String load(Context ctx) {
        return prefs(ctx).getString(KEY_SCHEDULE, "[]");
    }
}
