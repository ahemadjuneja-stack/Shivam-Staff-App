package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * BOOT RECEIVER — phone reboot ke baad tracking wapas (Boss order 2026-10-27:
 * "app on naa bhi kare aur location on kare tab bhi location dashboard par
 * aana chahiye"). BOSS ORDER 2026-11-17 ke baad DUAL-MODE:
 *
 *   sales + lastTourMode=true -> FGS restart (tour engine — notification FGS
 *                               ki invisible-MIN wali, tour me allowed)
 *   sales + HOME/silent       -> silent tower ping chain (ZERO notification)
 *   worker + watch enabled    -> worker silent engine chain (100m lock rule)
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
            if (uid == null || uid.length() < 4) return;
            String role = p.getString("role", "");

            if ("sales".equals(role)) {
                if (p.getBoolean("lastTourMode", false)) {
                    ContextCompat.startForegroundService(ctx, new Intent(ctx, LocationTrackService.class));
                } else {
                    // tour ke bahar = silent mode (Boss: no notifications)
                    SilentWatchPlugin.scheduleSalesAlarm(ctx, 2000);
                }
            } else if ("worker".equals(role)) {
                SharedPreferences wp = ctx.getSharedPreferences(SilentWatchPlugin.WPREFS, Context.MODE_PRIVATE);
                if (wp.getBoolean("enabled", false)) {
                    SilentWatchPlugin.scheduleWorkerAlarm(ctx, 2000);
                }
            }
        } catch (Exception ignore) {
            // restart na ho paye to app open / watchdog alarm sambhalega
        }
    }
}
