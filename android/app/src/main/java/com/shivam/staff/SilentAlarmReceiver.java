package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * ============================================================
 * SILENT ALARM RECEIVER (Boss 2026-11-17) — patla sa receiver: sirf
 * JobScheduler job schedule karta hai (receiver ka 10s budget kabhi nahi
 * bharta). Asli kaam SilentJobService + engines karte hain.
 *
 *   kind "w" -> worker silent check (3 min on-duty / 15 min off-duty)
 *   kind "s" -> sales silent tower ping (15 min, tour ke bahar)
 *
 * Re-arm engine ke ANDAR hota hai (har run apna next alarm khud lagata hai —
 * doze-safe self-perpetuating pattern). Koi notification KABHI nahi.
 * ============================================================
 */
public class SilentAlarmReceiver extends BroadcastReceiver {

    public static final String EXTRA_KIND = "kind";
    public static final String KIND_WORKER = "w";
    public static final String KIND_SALES = "s";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            String kind = intent != null ? intent.getStringExtra(EXTRA_KIND) : null;
            if (KIND_SALES.equals(kind)) {
                SilentWatchPlugin.scheduleJobNow(ctx, 4402);
            } else {
                SilentWatchPlugin.scheduleJobNow(ctx, 4401);
            }
        } catch (Exception ignore) {
        }
    }
}
