package cn.homeworkhub.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机后恢复提醒排期与会话保活探测。
 *
 * 系统闹钟在重启后会全部丢失（这是系统行为，不是我们的 bug）。
 * 如果不处理，用户重启一次手机，之后所有截止提醒都会静默消失，
 * 而且要等到他下次打开 App 才会回来 —— 恰好是最容易漏作业的那种情形。
 *
 * 恢复不需要重新计算：排期清单在 JS 下发时就存进 SharedPreferences 了，
 * 这里原样重新注册即可（过去的时刻会被自动跳过）。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.MY_PACKAGE_REPLACED".equals(action)) return;
        NotificationScheduler.rescheduleFromStore(context);
        // 保活探测的排期同样活在内存里，重启后要重新排 —— 否则
        // "每 30 分钟打一次点"会在用户重启手机后悄悄停掉，而测量结论
        // 正是建立在"间隔均匀"上的（间隙越大，寿命区间越宽）。
        // 这里用 reschedule（无条件）而不是 ensureScheduled：重启后存下来的
        // nextAt 是失效的旧值，按它判断会误以为"还有排期"而什么都不做。
        KeepAliveScheduler.reschedule(context);
    }
}
