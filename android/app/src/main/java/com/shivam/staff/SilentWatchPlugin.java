package com.shivam.staff;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.List;

/**
 * ============================================================
 * SILENT WATCH PLUGIN (Boss order 2026-11-17) — JS <-> native silent engines
 * ka bridge + alarm/job scheduling helpers.
 *
 * WORKER (Boss: "100 mitter ke andar ho tabhi app on, bahar jaye to lock"):
 *   startWorkerWatch() — login par JS call: uid/name/shop center/city save +
 *   engine chalu (3-min on-duty checks). stopWorkerWatch() — logout.
 *   setWorkerDuty() — duty toggle par cadence switch (on=3min, off=15min) +
 *   lock latch clear. workerState() — lock screen ke liye last state.
 *   wifiScan() — diagnostics (consent/manager debugging ke liye).
 *
 * SALES — plugin se scheduling sirf backup ke liye; main flow LocationTrackService
 * handoff (WatchdogReceiver) + BootReceiver + SalesSilentEngine self re-arm.
 *
 * SAB alarms setAndAllowWhileIdle (doze-safe, inexact — SCHEDULE_EXACT_ALARM
 * permission ki zaroorat nahi) + JobScheduler one-shot (no broadcast 10s limit).
 * ZERO notifications — Boss ka silent rule.
 * ============================================================
 */
@CapacitorPlugin(name = "SilentWatch")
public class SilentWatchPlugin extends Plugin {

    public static final String WPREFS = "shivam_worker_watch";

    public static final long WORKER_ACTIVE_MS = 3L * 60 * 1000;   // on-duty: 3 min
    public static final long WORKER_IDLE_MS = 15L * 60 * 1000;    // off-duty: 15 min
    public static final long SALES_PING_MS = 15L * 60 * 1000;     // sales silent ping

    private static final int ALARM_WORKER_RC = 5501;
    private static final int ALARM_SALES_RC = 5502;
    public static final int JOB_WORKER = 4401;
    public static final int JOB_SALES = 4402;

    // ================= JS METHODS =================

    @PluginMethod
    public void startWorkerWatch(PluginCall call) {
        try {
            String uid = call.getString("uid");
            if (uid == null || uid.length() < 4) {
                call.reject("uid required");
                return;
            }
            SharedPreferences p = getContext().getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            SharedPreferences.Editor e = p.edit()
                    .putBoolean("enabled", true)
                    .putString("uid", uid)
                    .putString("name", call.getString("name", "Staff"))
                    .putString("city", call.getString("city", ""));
            String vc = call.getString("versionCode", "0");
            try {
                e.putInt("versionCode", Integer.parseInt(vc));
            } catch (Exception ignore) {
            }
            Double lat = call.getDouble("shopLat");
            Double lng = call.getDouble("shopLng");
            if (lat != null && lng != null && lat != 0 && lng != 0) {
                e.putLong("shopLat", Double.doubleToRawLongBits(lat));
                e.putLong("shopLng", Double.doubleToRawLongBits(lng));
            }
            e.apply();
            // pehla check ~1s me (job) + alarm chain start
            scheduleJobNow(getContext(), JOB_WORKER);
            scheduleWorkerAlarm(getContext(), WORKER_ACTIVE_MS);
            call.resolve();
        } catch (Exception ex) {
            call.reject("startWorkerWatch failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void stopWorkerWatch(PluginCall call) {
        try {
            Context ctx = getContext();
            SharedPreferences p = ctx.getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            p.edit().putBoolean("enabled", false).apply();
            cancelWorker(ctx);
            call.resolve();
        } catch (Exception ex) {
            call.reject("stopWorkerWatch failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void setWorkerDuty(PluginCall call) {
        try {
            boolean on = call.getBoolean("onDuty", false);
            Context ctx = getContext();
            SharedPreferences p = ctx.getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            SharedPreferences.Editor e = p.edit().putBoolean("onDuty", on);
            if (!on) e.putBoolean("lockLatched", false); // duty off = lock latch clear
            e.apply();
            // cadence switch — next fire nayi interval par
            scheduleWorkerAlarm(ctx, on ? WORKER_ACTIVE_MS : WORKER_IDLE_MS);
            call.resolve();
        } catch (Exception ex) {
            call.reject("setWorkerDuty failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void workerState(PluginCall call) {
        try {
            SharedPreferences p = getContext().getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            JSObject out = new JSObject();
            out.put("enabled", p.getBoolean("enabled", false));
            out.put("onDuty", p.getBoolean("onDuty", false));
            out.put("state", p.getString("state", ""));
            out.put("stateAt", p.getLong("stateAt", 0L));
            out.put("lock", p.getBoolean("lockLatched", false));
            out.put("dist", p.getFloat("dist", -1f));
            out.put("lastTowerKey", p.getString("lastTowerKey", ""));
            call.resolve(out);
        } catch (Exception ex) {
            call.reject("workerState failed: " + ex.getMessage());
        }
    }

    /** WiFi scan — diagnostics/manager debugging (consent ke baad hi data milta hai). */
    @PluginMethod
    public void wifiScan(PluginCall call) {
        try {
            final PluginCall c = call;
            Thread t = new Thread(() -> {
                JSObject out = new JSObject();
                try {
                    android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager)
                            getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    JSONArray arr = new JSONArray();
                    if (wm != null) {
                        try {
                            wm.startScan();
                        } catch (Exception ignore) {
                        }
                        List<android.net.wifi.ScanResult> all = wm.getScanResults();
                        if (all != null) {
                            for (android.net.wifi.ScanResult sr : all) {
                                try {
                                    if (sr == null || sr.BSSID == null) continue;
                                    JSONObject o = new JSONObject()
                                            .put("bssid", sr.BSSID)
                                            .put("ssid", sr.SSID == null ? "" : sr.SSID)
                                            .put("rssi", sr.level);
                                    arr.put(o);
                                } catch (Exception ignore) {
                                }
                            }
                        }
                    }
                    out.put("aps", arr.toString());
                    out.put("count", arr.length());
                } catch (Exception ex) {
                    out.put("count", 0);
                    out.put("error", String.valueOf(ex));
                }
                c.resolve(out);
            });
            t.setDaemon(true);
            t.start();
        } catch (Exception ex) {
            call.reject("wifiScan failed: " + ex.getMessage());
        }
    }

    // ================= SCHEDULING (statics — receivers/boot/plugin sab yahi use karte) =================

    /** Worker alarm — interval onDuty pref se decide (3 min / 15 min). */
    public static void scheduleWorkerAlarm(Context ctx, long delayMs) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            if (!p.getBoolean("enabled", false)) return;
            long interval = p.getBoolean("onDuty", false) ? WORKER_ACTIVE_MS : WORKER_IDLE_MS;
            AlarmManager am = (AlarmManager) ctx.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(ctx.getApplicationContext(), SilentAlarmReceiver.class);
            i.putExtra(SilentAlarmReceiver.EXTRA_KIND, SilentAlarmReceiver.KIND_WORKER);
            PendingIntent pi = PendingIntent.getBroadcast(ctx.getApplicationContext(), ALARM_WORKER_RC, i,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + Math.max(500, delayMs), pi);
        } catch (Exception ignore) {
        }
    }

    /** Sales silent ping alarm — FGS handoff/boot ke baad chain start. */
    public static void scheduleSalesAlarm(Context ctx, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) ctx.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(ctx.getApplicationContext(), SilentAlarmReceiver.class);
            i.putExtra(SilentAlarmReceiver.EXTRA_KIND, SilentAlarmReceiver.KIND_SALES);
            PendingIntent pi = PendingIntent.getBroadcast(ctx.getApplicationContext(), ALARM_SALES_RC, i,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + Math.max(500, delayMs), pi);
        } catch (Exception ignore) {
        }
    }

    public static void cancelWorker(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                Intent i = new Intent(ctx.getApplicationContext(), SilentAlarmReceiver.class);
                i.putExtra(SilentAlarmReceiver.EXTRA_KIND, SilentAlarmReceiver.KIND_WORKER);
                PendingIntent pi = PendingIntent.getBroadcast(ctx.getApplicationContext(), ALARM_WORKER_RC, i,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                am.cancel(pi);
            }
            JobScheduler js = (JobScheduler) ctx.getApplicationContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_WORKER);
        } catch (Exception ignore) {
        }
    }

    public static void cancelSalesPing(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                Intent i = new Intent(ctx.getApplicationContext(), SilentAlarmReceiver.class);
                i.putExtra(SilentAlarmReceiver.EXTRA_KIND, SilentAlarmReceiver.KIND_SALES);
                PendingIntent pi = PendingIntent.getBroadcast(ctx.getApplicationContext(), ALARM_SALES_RC, i,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                am.cancel(pi);
            }
            JobScheduler js = (JobScheduler) ctx.getApplicationContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_SALES);
        } catch (Exception ignore) {
        }
    }

    /** One-shot job schedule (alarm receiver se) — purana pending same-ID job replace. */
    public static void scheduleJobNow(Context ctx, int jobId) {
        try {
            JobScheduler js = (JobScheduler) ctx.getApplicationContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            ComponentName cn = new ComponentName(ctx.getApplicationContext(), SilentJobService.class);
            JobInfo.Builder b = new JobInfo.Builder(jobId, cn)
                    .setMinimumLatency(0)
                    .setOverrideDeadline(400)
                    .setRequiresCharging(false)
                    .setRequiresBatteryNotLow(false)
                    .setPersisted(false);
            js.schedule(b.build());
        } catch (Exception ignore) {
        }
    }

    /** Diagnostics: worker prefs snapshot (JS diag screen ke liye). */
    public static JSONObject workerPrefsSnapshot(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            SharedPreferences p = ctx.getSharedPreferences(WPREFS, Context.MODE_PRIVATE);
            Iterator<String> keys = p.getAll().keySet().iterator();
            while (keys.hasNext()) {
                String k = keys.next();
                try {
                    Object v = p.getAll().get(k);
                    if (v instanceof Long || v instanceof Integer || v instanceof Float || v instanceof Boolean
                            || v instanceof String) {
                        o.put(k, String.valueOf(v));
                    } else {
                        o.put(k, "?");
                    }
                } catch (Exception ignore) {
                }
            }
        } catch (Exception ignore) {
        }
        return o;
    }
}
