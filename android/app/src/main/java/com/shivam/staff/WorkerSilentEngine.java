package com.shivam.staff;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * ============================================================
 * WORKER SILENT ENGINE (Boss order 2026-11-17):
 * "worker 100 mitter ke andar ho tabhi app on ho... aur bahar jaye to app
 *  lock... Location On rakhna zaroori hai" + "background me silent me app
 *  chalao magar notifications nahi aana chahiye".
 *
 * DESIGN — ZERO FGS, ZERO NOTIFICATION:
 *   Alarm (3 min on-duty / 15 min off-duty, setAndAllowWhileIdle)
 *   -> SilentAlarmReceiver -> JobScheduler job -> YE ENGINE (background thread)
 *   -> kaam khatam = process so jata hai. Screen/notification me KUCH nahi.
 *
 * IN_SHOP DETECTION (battery sasta -> mehnga order):
 *   1. WIFI FINGERPRINT (sasta): shop ke WiFi routers ki BSSID list
 *      (config/shop_wifi — manager app raat ko wifi_samples se seekhta hai).
 *      2+ shop AP dikhe (ya 1 strong >= -65dBm) = IN_SHOP — GPS chip BAND.
 *   2. GPS HYSTERESIS (mehnga, sirf zaroorat par): tower change hua / WiFi
 *      match nahi hua / fingerprint abhi seekh raha hai -> single fix.
 *      dist <= 100m = IN_SHOP (Boss: "100 mitter ke andar"), >= 150m =
 *      OUTSIDE (GPS noise buffer), beech me = PREVIOUS state (jitter band).
 *
 * LOCK LATCH: OUTSIDE confirm (on-duty me) -> worker_live.lock=true + alert.
 * Wapas IN -> auto unlock. Manager manual unlock = JS direct write (engine
 * lock field sirf TRANSITION par likhta hai — manager unlock overwrite NAHI).
 *
 * LEARNING LOOP ("improvement hota rahe"): har confirmed fix + scan ->
 * wifi_samples doc (8 samples ke batch) -> manager app aggregate karke
 * config/shop_wifi banata hai -> sab workers ka WiFi engine smart hota jata
 * hai. Jitna chalega, utna GPS band rahega.
 * ============================================================
 */
public final class WorkerSilentEngine {

    private WorkerSilentEngine() {
    }

    // ---- Boss-locked shop center (geofence.ts SHOP_CENTER_LOCKED jaisa — engine
    // prefs me JS startWorkerWatch se aata hai, fallback yahi locked coords) ----
    private static final double DEF_LAT = 21.5191279;
    private static final double DEF_LNG = 70.4621545;

    private static final int IN_RADIUS_M = 100;   // Boss: "100 mitter ke andar"
    private static final int OUT_RADIUS_M = 150;  // hysteresis outer — GPS noise buffer
    private static final long GPS_MIN_GAP_MS = 5L * 60 * 1000;     // consecutive GPS fix gap
    private static final long LASTKNOWN_MAX_AGE_MS = 10L * 60 * 1000;
    private static final long SCAN_MAX_AGE_US = 10L * 60 * 1000 * 1000L; // 10 min in µs
    private static final long FP_REFRESH_MS = 6L * 60 * 60 * 1000; // fingerprint refetch 6h
    private static final long SAMPLE_UPLOAD_MS = 30L * 60 * 1000;  // learning batch upload
    private static final int SAMPLE_UPLOAD_AT = 8;                 // ya 8 samples jama ho to
    private static final int SAMPLES_CAP = 12;
    private static final int APS_PER_SAMPLE = 20;                  // top-20 strongest APs
    private static final int WIFI_MATCH_RSSI_MIN = -80;            // fingerprint match gate
    private static final int WIFI_SINGLE_STRONG = -65;             // 1-AP rule threshold

    public static void run(Context ctx) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(SilentWatchPlugin.WPREFS, Context.MODE_PRIVATE);
            if (!p.getBoolean("enabled", false)) return;
            String uid = p.getString("uid", null);
            if (uid == null || uid.length() < 4) return;
            String name = p.getString("name", "Staff");
            String city = p.getString("city", "");
            int versionCode = p.getInt("versionCode", 0);
            boolean onDuty = p.getBoolean("onDuty", false);
            long now = System.currentTimeMillis();

            double shopLat = Double.longBitsToDouble(p.getLong("shopLat", Double.doubleToRawLongBits(DEF_LAT)));
            double shopLng = Double.longBitsToDouble(p.getLong("shopLng", Double.doubleToRawLongBits(DEF_LNG)));

            // ---- tower read (free, passive) ----
            CellTowerWatcher.TowerSnapshot tower = CellTowerWatcher.read(ctx);
            String lastTowerKey = p.getString("lastTowerKey", "");
            boolean towerChanged = tower != null && tower.ok && tower.key != null
                    && !tower.key.isEmpty() && !lastTowerKey.isEmpty() && !tower.key.equals(lastTowerKey);

            // ---- OFF-DUTY: light ping (no GPS, no lock, 15-min cadence) ----
            String prev = p.getString("state", "");
            if (!onDuty) {
                int[] bat = RestIo.readBattery(ctx);
                writeLiveDoc(ctx, p, uid, name, city, versionCode, "OFFDUTY", "none",
                        null, 0f, tower, bat, false, prev.equals("OFFDUTY") ? null : Boolean.FALSE,
                        now, new JSONArray());
                p.edit().putString("state", "OFFDUTY").putLong("stateAt", now)
                        .putBoolean("lockLatched", false)
                        .putString("lastTowerKey", tower != null && tower.ok ? tower.key : lastTowerKey)
                        .apply();
                return;
            }

            // ---- ON-DUTY: full engine ----
            boolean locOn = isLocationOn(ctx);

            // fingerprint cache refresh (sasta GET — 6h me ek baar / cold start)
            JSONObject fp = refreshFingerprint(ctx, p);

            // ---- WiFi scan + fingerprint match ----
            List<ScanResult> freshAps = new ArrayList<>();
            boolean wifiIn = false;
            if (locOn) {
                freshAps = scanFreshAps(ctx);
                if (fp.length() > 0 && !freshAps.isEmpty()) {
                    int matches = 0;
                    int strongest = -999;
                    // org.json (Android platform) me keySet() NAHI hota — keys()
                    // iterator se HashSet banao (harness jar me tha, Gradle me nahi)
                    Set<String> shopAps = new HashSet<>();
                    Iterator<String> kit = fp.keys();
                    while (kit.hasNext()) {
                        try {
                            String k = kit.next();
                            if (k != null) shopAps.add(k);
                        } catch (Exception ignore) {
                        }
                    }
                    for (ScanResult sr : freshAps) {
                        try {
                            if (sr == null || sr.BSSID == null) continue;
                            if (shopAps.contains(sr.BSSID) && sr.level >= WIFI_MATCH_RSSI_MIN) {
                                matches++;
                                if (sr.level > strongest) strongest = sr.level;
                            }
                        } catch (Exception ignore) {
                        }
                    }
                    wifiIn = matches >= 2 || (matches == 1 && strongest >= WIFI_SINGLE_STRONG);
                }
            }

            String newState;
            String src = "none";
            Location fix = null;
            float dist = -1f;

            if (!locOn) {
                // LOCATION OFF (Boss: "Location On rakhna zaroori hai" — manager
                // ko red LOC_OFF dikhega, GPS/WiFi dono fail)
                newState = "LOC_OFF";
            } else if (wifiIn) {
                newState = "IN_SHOP";
                src = "wifi";
            } else {
                // WiFi se confirm nahi hua -> GPS hysteresis check
                boolean needGps = towerChanged
                        || (now - p.getLong("lastGpsAt", 0L)) >= GPS_MIN_GAP_MS
                        || prev.isEmpty();
                if (needGps) {
                    fix = bestFix(ctx);
                    p.edit().putLong("lastGpsAt", System.currentTimeMillis()).apply();
                }
                if (fix != null) {
                    dist = RestIo.haversineM(fix.getLatitude(), fix.getLongitude(), shopLat, shopLng);
                    src = "gps";
                    if (dist <= IN_RADIUS_M) {
                        newState = "IN_SHOP";
                    } else if (dist >= OUT_RADIUS_M) {
                        newState = "OUTSIDE";
                    } else {
                        // hysteresis band — jitter ke andar hai, previous state rakho
                        newState = prev.isEmpty() ? "UNKNOWN" : prev;
                        src = prev.isEmpty() ? "gps" : "last";
                    }
                } else {
                    newState = prev.isEmpty() ? "UNKNOWN" : prev;
                    src = prev.isEmpty() ? "tower" : "last";
                }
            }

            // ---- lock latch + alerts (transition par hi) ----
            boolean latched = p.getBoolean("lockLatched", false);
            Boolean lockWrite = null;
            if (newState.equals("OUTSIDE") && !prev.equals("OUTSIDE") && !latched) {
                latched = true;
                lockWrite = Boolean.TRUE;
                postAlert(ctx, uid, name, "left_shop", "", now, fix, dist, tower, city);
            } else if ((newState.equals("IN_SHOP") || newState.equals("OFFDUTY")) && latched) {
                latched = false;
                lockWrite = Boolean.FALSE;
                if (prev.equals("OUTSIDE")) {
                    postAlert(ctx, uid, name, "back_shop", "", now, fix, dist, tower, city);
                }
            }

            int[] bat = RestIo.readBattery(ctx);
            writeLiveDoc(ctx, p, uid, name, city, versionCode, newState, src,
                    fix, dist, tower, bat, true, lockWrite, now, null);

            // ---- users lastLocation patch (manager identity card fresh rahe) ----
            if (fix != null) {
                patchLastLocation(ctx, uid, fix);
            }

            // ---- LEARNING: sample buffer + batch upload ----
            try {
                if (!freshAps.isEmpty() && (wifiIn || (fix != null && dist >= 0 && dist <= IN_RADIUS_M))) {
                    bufferSample(ctx, p, uid, name, freshAps, wifiIn || (fix != null && dist <= IN_RADIUS_M), now);
                }
            } catch (Exception ignore) {
            }

            // ---- save engine state ----
            SharedPreferences.Editor e = p.edit();
            e.putString("state", newState).putLong("stateAt", now)
                    .putBoolean("lockLatched", latched)
                    .putString("lastTowerKey", tower != null && tower.ok ? tower.key : lastTowerKey);
            if (fix != null) {
                e.putFloat("dist", dist);
            }
            e.apply();

            // ---- flush offline queue (net ho to pending writes jayenge) ----
            RestIo.flushQueue(p, "pend_queue");
        } catch (Exception ignore) {
            // engine kabhi crash nahi hoga — next alarm phir chalega
        }
    }

    // ================= WIFI =================

    /** Fresh scan results (≤10 min purane) — throttling ho to cached bhi chalega. */
    private static List<ScanResult> scanFreshAps(Context ctx) {
        List<ScanResult> out = new ArrayList<>();
        try {
            WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return out;
            try {
                wm.startScan(); // trigger — throttled ho to cached results milte hain
            } catch (Exception ignore) {
            }
            List<ScanResult> all = wm.getScanResults();
            if (all == null) return out;
            long nowBootUs = SystemClock.elapsedRealtimeNanos() / 1000L;
            for (ScanResult sr : all) {
                try {
                    if (sr == null || sr.BSSID == null || sr.BSSID.isEmpty()) continue;
                    long ageUs = nowBootUs - sr.timestamp;
                    if (ageUs >= 0 && ageUs <= SCAN_MAX_AGE_US) out.add(sr);
                } catch (Exception ignore) {
                }
            }
        } catch (Exception ignore) {
        }
        return out;
    }

    // ================= FINGERPRINT CACHE =================

    /** config/shop_wifi GET — {aps:{bssid:{...}}} ke BSSID keys = shop AP set. */
    private static JSONObject refreshFingerprint(Context ctx, SharedPreferences p) {
        JSONObject fp = new JSONObject();
        try {
            fp = new JSONObject(p.getString("fp", "{}"));
        } catch (Exception ignore) {
        }
        try {
            long now = System.currentTimeMillis();
            boolean cold = fp.length() == 0;
            if (!cold && (now - p.getLong("fpFetchedAt", 0L)) < FP_REFRESH_MS) return fp;
            RestIo.HttpResult r = RestIo.http("GET", RestIo.BASE + "config/shop_wifi", null);
            JSONObject next = new JSONObject();
            if (r.ok && r.body != null) {
                JSONObject resp = new JSONObject(r.body);
                JSONObject fields = resp.optJSONObject("fields");
                if (fields != null) {
                    JSONObject aps = fields.optJSONObject("aps");
                    if (aps != null) {
                        JSONObject map = aps.optJSONObject("mapValue");
                        if (map != null) {
                            JSONObject inner = map.optJSONObject("fields");
                            if (inner != null) {
                                Iterator<String> it = inner.keys();
                                while (it.hasNext()) {
                                    String bssid = it.next();
                                    if (bssid != null && bssid.length() >= 12) next.put(bssid, true);
                                }
                            }
                        }
                    }
                }
            }
            if (next.length() > 0) {
                fp = next;
                p.edit().putString("fp", fp.toString()).putLong("fpFetchedAt", now).apply();
            } else {
                // doc abhi khali/missing (cold start) — GPS path chalega, 6h me phir try
                p.edit().putLong("fpFetchedAt", now).apply();
            }
        } catch (Exception ignore) {
        }
        return fp;
    }

    // ================= GPS =================

    private static boolean isLocationOn(Context ctx) {
        try {
            int mode = Settings.Secure.getInt(ctx.getContentResolver(),
                    Settings.Secure.LOCATION_MODE, Settings.Secure.LOCATION_MODE_OFF);
            return mode != Settings.Secure.LOCATION_MODE_OFF;
        } catch (Exception e) {
            return true; // read fail — assume on (permission gate ne handle kiya hoga)
        }
    }

    private static Location bestFix(Context ctx) {
        try {
            LocationManager lm = (LocationManager) ctx.getApplicationContext()
                    .getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return null;
            long now = System.currentTimeMillis();
            Location best = null;
            long bestAge = Long.MAX_VALUE;
            try {
                List<String> providers = lm.getProviders(true);
                if (providers != null) {
                    for (String prov : providers) {
                        try {
                            Location l = lm.getLastKnownLocation(prov);
                            if (l == null) continue;
                            long age = now - l.getTime();
                            if (age < 0) age = 0;
                            if (age < bestAge) {
                                bestAge = age;
                                best = l;
                            }
                        } catch (Exception ignore) {
                        }
                    }
                }
            } catch (Exception ignore) {
            }
            if (best != null && bestAge <= LASTKNOWN_MAX_AGE_MS && best.getAccuracy() <= 200f) {
                return best;
            }
            // stale — NETWORK provider se ek single fix (GPS chip nahi, sasta)
            return singleFix(ctx, lm, LocationManager.NETWORK_PROVIDER, 8000);
        } catch (Exception ignore) {
            return null;
        }
    }

    private static HandlerThread locThread;
    private static Handler locHandler;

    /** Ek single passive fix — latch timeout ke saath (JobService thread safe). */
    private static Location singleFix(Context ctx, LocationManager lm, String provider, long timeoutMs) {
        try {
            synchronized (WorkerSilentEngine.class) {
                if (locThread == null) {
                    locThread = new HandlerThread("shivam_silent_loc");
                    locThread.start();
                    locHandler = new Handler(locThread.getLooper());
                }
            }
            final CountDownLatch latch = new CountDownLatch(1);
            final Location[] got = new Location[1];
            LocationListener listener = new LocationListener() {
                @Override
                public void onLocationChanged(Location location) {
                    try {
                        got[0] = location;
                    } catch (Exception ignore) {
                    } finally {
                        latch.countDown();
                    }
                }

                @Override
                public void onStatusChanged(String provider, int status, android.os.Bundle extras) {
                }

                @Override
                public void onProviderEnabled(String provider) {
                }

                @Override
                public void onProviderDisabled(String provider) {
                }
            };
            try {
                Looper looper = locHandler != null ? locHandler.getLooper() : null;
                if (looper == null) return null;
                lm.requestSingleUpdate(provider, listener, looper);
            } catch (Exception ignore) {
                return null;
            }
            try {
                latch.await(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignore) {
            }
            try {
                lm.removeUpdates(listener);
            } catch (Exception ignore) {
            }
            return got[0];
        } catch (Exception ignore) {
            return null;
        }
    }

    // ================= WRITES =================

    /**
     * worker_live/{uid} masked write — lock field SIRF transition par (mask me
     * tabhi add hota hai). Manager ka manual unlock overwrite KABHI nahi hota.
     */
    private static void writeLiveDoc(Context ctx, SharedPreferences p, String uid, String name,
                                     String city, int versionCode, String state, String src,
                                     Location fix, float dist, CellTowerWatcher.TowerSnapshot tower,
                                     int[] bat, boolean onDuty, Boolean lockWrite, long now,
                                     JSONArray extraFlags) {
        try {
            JSONObject fields = new JSONObject()
                    .put("uid", RestIo.fS(uid))
                    .put("name", RestIo.fS(name))
                    .put("state", RestIo.fS(state))
                    .put("src", RestIo.fS(src))
                    .put("onDuty", RestIo.fB(onDuty))
                    .put("at", RestIo.fI(now))
                    .put("city", RestIo.fS(city == null ? "" : city))
                    .put("citySrc", RestIo.fS("home"));
            if (fix != null) {
                fields.put("lat", RestIo.fD(fix.getLatitude()));
                fields.put("lng", RestIo.fD(fix.getLongitude()));
                if (fix.hasAccuracy()) fields.put("acc", RestIo.fD(fix.getAccuracy()));
            }
            if (dist >= 0) {
                fields.put("dist", RestIo.fI(Math.round(dist)));
            }
            if (tower != null && tower.ok && tower.key != null && !tower.key.isEmpty()) {
                fields.put("cellKey", RestIo.fS(tower.key));
                JSONObject cellMap = new JSONObject();
                try {
                    if (tower.mcc != null && !tower.mcc.isEmpty()) cellMap.put("mcc", RestIo.fS(tower.mcc));
                    if (tower.mnc != null && !tower.mnc.isEmpty()) cellMap.put("mnc", RestIo.fS(tower.mnc));
                    if (tower.lac >= 0) cellMap.put("lac", RestIo.fI(tower.lac));
                    if (tower.cid >= 0) cellMap.put("cid", RestIo.fI(tower.cid));
                    if (tower.dbm != 0) cellMap.put("dbm", RestIo.fI(tower.dbm));
                } catch (Exception ignore) {
                }
                if (cellMap.length() > 0) {
                    fields.put("cell", new JSONObject().put("mapValue",
                            new JSONObject().put("fields", cellMap)));
                }
            }
            if (bat != null && bat[0] >= 0) {
                fields.put("batteryPct", RestIo.fI(bat[0]));
                fields.put("charging", RestIo.fB(bat[1] == 1));
            }
            JSONArray flags = extraFlags != null ? extraFlags : new JSONArray();
            fields.put("flags", RestIo.fArr(flags));
            RestIo.putDeviceFields(fields, versionCode);
            if (lockWrite != null) {
                fields.put("lock", RestIo.fB(lockWrite));
            }

            StringBuilder mask = new StringBuilder();
            String[] maskFields = {"uid", "name", "state", "src", "onDuty", "at", "city", "citySrc",
                    "lat", "lng", "acc", "dist", "cellKey", "cell", "batteryPct", "charging",
                    "flags", "versionCode", "deviceModel", "osVersion"};
            for (String mf : maskFields) {
                if (fields.has(mf)) {
                    if (mask.length() > 0) mask.append('&');
                    mask.append("updateMask.fieldPaths=").append(mf);
                }
            }
            if (lockWrite != null) {
                mask.append("&updateMask.fieldPaths=lock");
            }
            String url = RestIo.BASE + "worker_live/" + uid + (mask.length() > 0 ? "?" + mask : "");
            String body = new JSONObject().put("fields", fields).toString();
            RestIo.HttpResult r = RestIo.http("POST", url, body);
            if (!r.ok) RestIo.queueOp(p, "pend_queue", url, body);
        } catch (Exception ignore) {
        }
    }

    private static void patchLastLocation(Context ctx, String uid, Location fix) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(SilentWatchPlugin.WPREFS, Context.MODE_PRIVATE);
            JSONObject fields = new JSONObject()
                    .put("lastLocation", new JSONObject().put("mapValue",
                            new JSONObject().put("fields", new JSONObject()
                                    .put("lat", RestIo.fD(fix.getLatitude()))
                                    .put("lng", RestIo.fD(fix.getLongitude()))
                                    .put("at", RestIo.fI(System.currentTimeMillis()))
                                    .put("src", RestIo.fS("silent")))))
                    .put("lastSeenAt", RestIo.fI(System.currentTimeMillis()));
            String url = RestIo.BASE + "users/" + uid + "?updateMask=lastLocation,lastSeenAt";
            String body = new JSONObject().put("fields", fields).toString();
            RestIo.HttpResult r = RestIo.http("POST", url, body);
            if (!r.ok) RestIo.queueOp(p, "pend_queue", url, body);
        } catch (Exception ignore) {
        }
    }

    private static void postAlert(Context ctx, String uid, String name, String type, String text,
                                  long now, Location fix, float dist,
                                  CellTowerWatcher.TowerSnapshot tower, String city) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(SilentWatchPlugin.WPREFS, Context.MODE_PRIVATE);
            JSONObject fields = new JSONObject()
                    .put("uid", RestIo.fS(uid))
                    .put("name", RestIo.fS(name))
                    .put("type", RestIo.fS(type))
                    .put("text", RestIo.fS(text == null ? "" : text))
                    .put("at", RestIo.fI(now))
                    .put("city", RestIo.fS(city == null ? "" : city))
                    .put("status", RestIo.fS("open"));
            if (fix != null) {
                fields.put("lat", RestIo.fD(fix.getLatitude()));
                fields.put("lng", RestIo.fD(fix.getLongitude()));
            }
            if (dist >= 0) fields.put("dist", RestIo.fI(Math.round(dist)));
            if (tower != null && tower.ok && tower.key != null && !tower.key.isEmpty()) {
                fields.put("cellKey", RestIo.fS(tower.key));
            }
            String url = RestIo.BASE + "worker_alerts/wa-" + uid + "-" + now;
            String body = new JSONObject().put("fields", fields).toString();
            RestIo.HttpResult r = RestIo.http("POST", url, body);
            if (!r.ok) RestIo.queueOp(p, "pend_queue", url, body);
        } catch (Exception ignore) {
        }
    }

    // ================= LEARNING LOOP =================

    /** Firestore REST: array element = {mapValue:{fields:{...}}} wrapper. */
    private static JSONObject wrapMapValue(JSONObject fields) {
        try {
            return new JSONObject().put("mapValue", new JSONObject().put("fields", fields));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void bufferSample(Context ctx, SharedPreferences p, String uid, String name,
                                     List<ScanResult> aps, boolean inShop, long now) {
        try {
            JSONArray buf = new JSONArray(p.getString("fpBuf", "[]"));
            JSONArray apArr = new JSONArray();
            List<ScanResult> sorted = new ArrayList<>(aps);
            try {
                java.util.Collections.sort(sorted, (a, b) -> {
                    try {
                        return Integer.compare(b.level, a.level);
                    } catch (Exception e) {
                        return 0;
                    }
                });
            } catch (Exception ignore) {
            }
            int n = Math.min(sorted.size(), APS_PER_SAMPLE);
            for (int i = 0; i < n; i++) {
                try {
                    ScanResult sr = sorted.get(i);
                    if (sr == null || sr.BSSID == null) continue;
                    apArr.put(wrapMapValue(new JSONObject()
                            .put("b", RestIo.fS(sr.BSSID))
                            .put("r", RestIo.fI(sr.level))));
                } catch (Exception ignore) {
                }
            }
            if (apArr.length() == 0) return;
            // sample ALREADY mapValue-wrapped — upload par seedha arrayValue me jata hai
            buf.put(wrapMapValue(new JSONObject()
                    .put("ts", RestIo.fI(now))
                    .put("inShop", RestIo.fB(inShop))
                    .put("aps", RestIo.fArr(apArr))));
            // cap
            JSONArray capped = new JSONArray();
            int start = Math.max(0, buf.length() - SAMPLES_CAP);
            for (int i = start; i < buf.length(); i++) capped.put(buf.get(i));

            long lastUp = p.getLong("fpBufAt", 0L);
            boolean due = capped.length() >= SAMPLE_UPLOAD_AT
                    || (now - lastUp) >= SAMPLE_UPLOAD_MS;
            if (due) {
                String day = RestIo.isoDay(now);
                JSONObject fields = new JSONObject()
                        .put("uid", RestIo.fS(uid))
                        .put("name", RestIo.fS(name))
                        .put("day", RestIo.fS(day))
                        .put("ts", RestIo.fI(now))
                        .put("samples", RestIo.fArr(capped));
                String url = RestIo.BASE + "wifi_samples/ws-" + uid + "-" + now;
                String body = new JSONObject().put("fields", fields).toString();
                RestIo.HttpResult r = RestIo.http("POST", url, body);
                if (r.ok) {
                    p.edit().putString("fpBuf", "[]").putLong("fpBufAt", now).apply();
                } else {
                    // net fail — buffer prefs me hi rahega, agli baar dubara try
                    p.edit().putString("fpBuf", capped.toString()).apply();
                }
            } else {
                p.edit().putString("fpBuf", capped.toString()).apply();
            }
        } catch (Exception ignore) {
        }
    }

    /** fArr() ke liye raw JSONArray (mapValues already built). */
    private static JSONArray toRawArray(JSONArray src) {
        JSONArray out = new JSONArray();
        try {
            for (int i = 0; i < src.length(); i++) out.put(src.get(i));
        } catch (Exception ignore) {
        }
        return out;
    }
}
