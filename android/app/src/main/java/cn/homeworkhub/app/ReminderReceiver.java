package cn.homeworkhub.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 系统闹钟到点的接收器：把通知交给 {@link NotificationScheduler#post}。
 *
 * 这个类会在**应用进程已被杀死的情况下**被系统拉起执行 —— 这正是用闹钟
 * 而不是 WebView 定时器的原因。所以它不能依赖任何内存状态，
 * 通知的标题/正文都由 Intent 带进来（排期时就写好了）。
 */
public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !NotificationScheduler.ACTION_FIRE.equals(intent.getAction())) return;
        NotificationScheduler.post(
                context,
                intent.getStringExtra("title"),
                intent.getStringExtra("body"));
    }
}
