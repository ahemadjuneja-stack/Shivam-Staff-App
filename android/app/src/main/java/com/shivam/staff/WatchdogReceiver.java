package com.shivam.staff;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * WATCHDOG RECEIVER — 15-min alarm (LocationTrackService khud schedule karta
 * hai): agar system ne service/process maar diya ho to yahan se restart.
 * Agar service zinda hai (running==true) to kuch nahi karta. Background FGS
 * start API 31+ par blocked ho sakta hai — try/catch, START_STICKY + Boot
 * receiver backup hain.
 */
public class WatchdogReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            if (LocationTrackService.running) return;
            SharedPreferences p = ctx.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE);
            String uid = p.getString("uid", null);
            if (uid == null || !"sales".equals(p.getString("role", ""))) return;
            ContextCompat.startForegroundService(ctx, new Intent(ctx, LocationTrackService.class));
        } catch (Exception ignore) {
        }
    }
}
