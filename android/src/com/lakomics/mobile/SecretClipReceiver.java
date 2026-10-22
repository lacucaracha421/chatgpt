package com.lakomics.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Clears a copied secret-note value at its due time even while Lakomics is in the background,
 * where the activity's own timer may never run (cached apps are frozen). Only the clip's
 * timestamp travels in the alarm; the value itself is never stored or logged.
 */
public final class SecretClipReceiver extends BroadcastReceiver {
    private static final String STAMP = "stamp";

    static void schedule(Context context, long stamp, long dueElapsed) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.set(AlarmManager.ELAPSED_REALTIME, dueElapsed, pending(context, stamp));
    }

    static void cancel(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(pending(context, -1));
    }

    private static PendingIntent pending(Context context, long stamp) {
        Intent intent = new Intent(context, SecretClipReceiver.class).putExtra(STAMP, stamp);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Clears the clipboard unless it visibly holds a newer clip than `stamp`. Without window
     * focus (Android 10+) the clip cannot be read, only cleared, so it is cleared anyway: a
     * secret left behind is worse than losing a clip copied elsewhere within the 30 s.
     */
    static void clearIfOurs(Context context, long stamp) {
        ClipboardManager manager = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager == null) return;
        ClipDescription now;
        try { now = manager.getPrimaryClipDescription(); } catch (RuntimeException unreadable) { now = null; }
        if (now != null && now.getTimestamp() != stamp) return;
        try {
            if (Build.VERSION.SDK_INT >= 28) manager.clearPrimaryClip();
            else manager.setPrimaryClip(ClipData.newPlainText("", ""));
        } catch (RuntimeException ignored) { /* Nothing more can be done without the clipboard. */ }
    }

    @Override public void onReceive(Context context, Intent intent) {
        long stamp = intent.getLongExtra(STAMP, -1);
        if (stamp >= 0) clearIfOurs(context, stamp);
    }
}
