package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * WATCHDOG RECEIVER — 15-min alarm (LocationTrackService khud schedule karta
 * hai). BOSS ORDER 2026-11-17 ke baad DUAL-MODE brain:
 *
 * 1) Service ZINDA hai + HOME mode + app band -> SILENT HANDOFF (FGS band,
 *    silent tower ping chain start — notification ZERO). Boss: "Background me
 *    silent me app chalao magar notifications nahi aana chahiye".
 * 2) Service MAR GAYI hai:
 *    - sales + lastTourMode=true  -> FGS restart (tour engine wapas)
 *    - sales + HOME/silent        -> silent ping turant (dedupe-safe)
 *    - worker + watch enabled     -> worker check turant (alarm revive)
 *
 * Ye alarm service band hone ke BAAD bhi fire hota hai (inexact repeating
 * alarm system me tikka rehta hai) — isliye handoff ke baad bhi backup
 * checker ka kaam karta hai.
 */
public class WatchdogReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE);
            String role = p.getString("role", "");

            // ---- 1) SERVICE ZINDA — HOME + app band = silent mode handoff ----
            if (LocationTrackService.running) {
                if ("sales".equals(role)) {
                    LocationTrackService.requestSilentHandoff(ctx);
                }
                return;
            }

            // ---- 2) SERVICE DEAD — role ke hisab se revive ----
            String uid = p.getString("uid", null);
            if (uid == null || uid.length() < 4) return;

            if ("sales".equals(role)) {
                if (p.getBoolean("lastTourMode", false)) {
                    // tour chal raha tha — FGS wapas (START_STICKY backup + ye)
                    ContextCompat.startForegroundService(ctx, new Intent(ctx, LocationTrackService.class));
                } else {
                    // HOME/silent mode — ping turant (engine dedupe karega)
                    SilentWatchPlugin.scheduleSalesAlarm(ctx, 500);
                }
            } else if ("worker".equals(role)) {
                SharedPreferences wp = ctx.getSharedPreferences(SilentWatchPlugin.WPREFS, Context.MODE_PRIVATE);
                if (wp.getBoolean("enabled", false)) {
                    SilentWatchPlugin.scheduleWorkerAlarm(ctx, 500);
                }
            }
        } catch (Exception ignore) {
        }
    }
}
