package cn.homeworkhub.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 保活探测的闹钟到点接收器。
 *
 * 这个类会在**应用进程已被杀死的情况下**被系统拉起执行 —— 这正是用闹钟
 * 而不是 WebView 定时器的原因。所以它不能依赖任何内存状态，
 * 配置与 UA 都从 {@link KeepAliveScheduler} 的 SharedPreferences 里读。
 *
 * 用 goAsync() 是因为探测要发网络请求，而 onReceive 返回后进程随时可能被回收；
 * 不 goAsync 的话请求大概率发不出去（或发到一半被杀）。
 */
public class KeepAliveReceiver extends BroadcastReceiver {

    private static final String TAG = "HomeworkHub";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !KeepAliveScheduler.ACTION_PROBE.equals(intent.getAction())) return;

        final Context app = context.getApplicationContext();

        // 先把下一次排上再干活：探测中途出任何问题（网络异常、进程被杀）
        // 都不能让这条链断掉 —— 链一断，"定时打点"就变成了"偶尔打一次"，
        // 测量结论会跟着失真。
        // 用 reschedule 而不是 scheduleNext：它会检查开关与探测清单，
        // 万一探测刚被用户关掉、或账号被移除，这里就不会又把它排回来。
        KeepAliveScheduler.reschedule(app);

        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                KeepAliveScheduler.runProbe(app);
            } catch (Throwable t) {
                Log.w(TAG, "保活探测执行失败", t);
            } finally {
                pending.finish();
            }
        }, "hh-keepalive").start();
    }
}
