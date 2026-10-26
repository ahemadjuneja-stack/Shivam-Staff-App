package com.shivam.staff;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * LOCATION GUARD (Boss order: "location off karne par app INSTANT band ho")
 * + BACKGROUND TRACKING CONTROL (Boss order 2026-10-27: "app on naa bhi kare
 * aur location on kare tab bhi location dashboard par aana chahiye").
 *
 * JS-layer detection (watchPosition stall / getCurrentPosition probe) location
 * band hone par 20-60s let lagati hai — Boss ko chahiye INSTANT lock. Android
 * ka LocationManager system broadcast (PROVIDERS_CHANGED / MODE_CHANGED)
 * quick-settings se location OFF/ON hote hi MILLISECONDS me fire hota hai —
 * ye plugin wo broadcast sun kar JS ko turant bata deta hai:
 *
 *   notifyListeners("locationStateChanged", { enabled: true|false })
 *
 * RECEIVER_NOT_EXPORTED flag (targetSdk 34+ requirement) — system broadcast
 * deliver hote rahenge, sirf doosre apps is receiver ko target nahi kar sakte.
 *
 * BACKGROUND LAYER: startTracking() = LocationTrackService (foreground
 * service) start + prefs (uid/name/role) — app kill/hone par bhi tracking
 * chalti hai (native service + Firestore REST). stopTracking() = sab band.
 * isAppForeground() service ko batata hai ki JS zinda hai (duty punches JS
 * integrity path se hote hain — native background me hi duty likhta hai).
 */
@CapacitorPlugin(name = "LocationGuard")
public class LocationGuardPlugin extends Plugin {

    private BroadcastReceiver receiver;
    private boolean started = false;

    // ---- APP FOREGROUND COUNTER (service duty-dedupe ke liye) ----
    private static volatile int activityRefs = 0;
    private static boolean lifecycleHooked = false;

    static boolean isAppForeground() {
        return activityRefs > 0;
    }

    @Override
    public void load() {
        if (lifecycleHooked) return;
        lifecycleHooked = true;
        try {
            Application app = (Application) getContext().getApplicationContext();
            app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
                @Override
                public void onActivityStarted(Activity a) {
                    activityRefs++;
                }

                @Override
                public void onActivityStopped(Activity a) {
                    activityRefs = Math.max(0, activityRefs - 1);
                }

                @Override
                public void onActivityCreated(Activity a, Bundle b) {
                }

                @Override
                public void onActivityResumed(Activity a) {
                }

                @Override
                public void onActivityPaused(Activity a) {
                }

                @Override
                public void onActivitySaveInstanceState(Activity a, Bundle b) {
                }

                @Override
                public void onActivityDestroyed(Activity a) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (started && receiver != null) {
                call.resolve();
                return;
            }
            stopInternal();
            IntentFilter filter = new IntentFilter();
            filter.addAction(LocationManager.PROVIDERS_CHANGED_ACTION);
            filter.addAction(LocationManager.MODE_CHANGED_ACTION);
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent != null ? intent.getAction() : null;
                    if (LocationManager.PROVIDERS_CHANGED_ACTION.equals(action)
                            || LocationManager.MODE_CHANGED_ACTION.equals(action)) {
                        JSObject data = new JSObject();
                        data.put("enabled", isLocationEnabled());
                        notifyListeners("locationStateChanged", data);
                    }
                }
            };
            ContextCompat.registerReceiver(
                    getContext().getApplicationContext(),
                    receiver,
                    filter,
                    ContextCompat.RECEIVER_NOT_EXPORTED);
            started = true;
            call.resolve();
        } catch (Exception e) {
            call.reject("location guard start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            stopInternal();
            call.resolve();
        } catch (Exception e) {
            call.reject("location guard stop failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", isLocationEnabled());
        call.resolve(ret);
    }

    // ================= BACKGROUND TRACKING CONTROL =================

    /**
     * App.tsx (sales login) call karta hai: service start + prefs. Worker/
     * manager par no-op (unke apne systems hain). Pehli baar par notification
     * + background-location permission + battery-exemption prompt (best effort).
     */
    @PluginMethod
    public void startTracking(PluginCall call) {
        try {
            String uid = call.getString("uid");
            String name = call.getString("name");
            String role = call.getString("role", "");
            double versionCode = call.getDouble("versionCode", 0d);
            if (uid == null || uid.length() < 4 || !"sales".equals(role)) {
                // sirf sales background-tracked hai (Boss: "salesmen ka duty")
                call.resolve();
                return;
            }
            Context app = getContext().getApplicationContext();
            SharedPreferences p = app.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE);
            boolean firstTime = !uid.equals(p.getString("uid", null));
            p.edit()
                    .putString("uid", uid)
                    .putString("name", name == null || name.length() == 0 ? "Staff" : name)
                    .putString("role", "sales")
                    .putInt("versionCode", (int) versionCode)
                    .apply();
            Activity act = getActivity();
            if (act != null) {
                requestPermissionsBestEffort(act);
                if (firstTime) requestBatteryExemptionBestEffort(act);
            }
            ContextCompat.startForegroundService(app, new Intent(app, LocationTrackService.class));
            call.resolve();
        } catch (Exception e) {
            // service start fail (rare) — app-foreground JS tracking phir bhi hai
            call.resolve();
        }
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        try {
            Context app = getContext().getApplicationContext();
            app.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE)
                    .edit().clear().apply();
            try {
                app.stopService(new Intent(app, LocationTrackService.class));
            } catch (Exception ignore) {
            }
            LocationTrackService.running = false;
            call.resolve();
        } catch (Exception e) {
            call.resolve();
        }
    }

    /**
     * LocationGate gate-pass par: fresh fix ke saath session ensure (native
     * 'on' event + start coords iske paas hote hain agar naya session bana).
     */
    @PluginMethod
    public void ensureSession(PluginCall call) {
        try {
            boolean hasFix = call.getBoolean("hasFix", false);
            double lat = call.getDouble("lat", 0d);
            double lng = call.getDouble("lng", 0d);
            LocationTrackService.ensureFromPlugin(hasFix, lat, lng);
            call.resolve();
        } catch (Exception e) {
            call.resolve();
        }
    }

    private void requestPermissionsBestEffort(Activity act) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(act,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9101);
            }
            // Android 11+: background location ALAG request (saath me request
            // karne par system ignore kar deta hai) — FGS wapas/while-in-use
            // ke saath bhi tracking chalti hai, ye "allow all the time" hai
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (ContextCompat.checkSelfPermission(act, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                            != PackageManager.PERMISSION_GRANTED
                            && ContextCompat.checkSelfPermission(act, Manifest.permission.ACCESS_FINE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(act,
                                new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, 9102);
                    }
                } catch (Exception ignore) {
                }
            }, 900);
        } catch (Exception ignore) {
        }
    }

    private void requestBatteryExemptionBestEffort(Activity act) {
        try {
            PowerManager pm = (PowerManager) act.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (pm.isIgnoringBatteryOptimizations(act.getPackageName())) return;
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + act.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(i);
        } catch (Exception ignore) {
            // OEM block — service START_STICKY + watchdog se chalti rahegi
        }
    }

    private void stopInternal() {
        if (receiver != null) {
            try {
                getContext().getApplicationContext().unregisterReceiver(receiver);
            } catch (Exception ignore) {
                // already unregistered
            }
            receiver = null;
        }
        started = false;
    }

    private boolean isLocationEnabled() {
        try {
            LocationManager lm = (LocationManager) getContext().getApplicationContext()
                    .getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return false;
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            // unsure — true return karo, JS layers (probe/watchdog) decide karenge
            return true;
        }
    }
}
