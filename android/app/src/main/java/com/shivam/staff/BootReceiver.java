package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * BOOT RECEIVER — phone reboot hote hi background tracking service wapas
 * (prefs me sales user pada hai to). Boss order 2026-10-27: "app on naa bhi
 * kare aur location on kare tab bhi location dashboard par aana chahiye".
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            String action = intent != null ? intent.getAction() : null;
            if (action == null) return;
            if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                    && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
                return;
            }
            SharedPreferences p = ctx.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE);
            String uid = p.getString("uid", null);
            if (uid == null || !"sales".equals(p.getString("role", ""))) return;
            ContextCompat.startForegroundService(ctx, new Intent(ctx, LocationTrackService.class));
        } catch (Exception ignore) {
            // restart na ho paye to app open / watchdog alarm sambhalega
        }
    }
}
