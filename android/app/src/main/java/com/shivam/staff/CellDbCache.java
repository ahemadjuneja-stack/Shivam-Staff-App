package com.shivam.staff;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * ============================================================
 * CELL TOWER DB CACHE (Boss order 2026-11-17 — offline tower->city):
 *
 * "Where is my train" jaisa system banane ka CORE — ye LOCAL FILE
 * hai jo tower fingerprint (mcc-mnc-lac-cid) ko location+city se
 * map karta hai. Do sources se bharta hai:
 *
 *  1) SELF-LEARNING (native): jab GPS fix mila (burst/gate fix —
 *     accuracy <= 60m) AUR cell read hua, to us tower ko us GPS
 *     location ke saath record() karte hain + Firestore cell_towers
 *     me upsert (LocationTrackService karta hai). Jitna staff ghumega,
 *     DB utna mota hota jayega — next trip par wahi towers se
 *     INTERNET BAND hone par bhi city dikh jayegi.
 *
 *  2) FIRESTORE SYNC (JS pushCellDb): dusré sales staff ne jo towers
 *     learn kiye (unke phone par GPS tha, is waqt net nahi hai), wo
 *     cell_towers collection se JS fetch karke is file me MERGE karta
 *     hai — pura team ka knowledge har phone me hota hai.
 *
 * FILE: filesDir/cell_towers.json — low-end device friendly (sirf
 * org ke towers = aaj kal khud record hue + team sync; expected few
 * hundred entries, JSON read/write < 10ms).
 *
 * LOOKUP (offline, zero network):
 *   - lookup(key)            -> exact tower {lat,lng,city}
 *   - nearestCity(lat,lng)   -> sabse paas ki tower ki city (25km cap)
 * ============================================================
 */
public final class CellDbCache {

    public static final class TowerEntry {
        public String key;
        public double lat;
        public double lng;
        public float acc;       // kitne accurate the original GPS fix (m)
        public String city = ""; // city label (geocoder/nearest/home se aaya tha)
        public int samples;     // kitni baar dikha (confidence)
        public long updatedAt;
    }

    private static final String FILE_NAME = "cell_towers.json";
    private static final float NEAREST_CITY_CAP_M = 25000f; // 25km door tak hi city label
    private static final int MAX_ENTRIES = 3000;            // cap — JSON file moti na ho

    private final Object lock = new Object();
    private final File file;
    private JSONObject db; // key -> {lat,lng,acc,city,samples,updatedAt}

    public CellDbCache(Context ctx) {
        file = new File(ctx.getApplicationContext().getFilesDir(), FILE_NAME);
        load();
    }

    // ================= LOAD/SAVE (file-backed) =================

    private void load() {
        synchronized (lock) {
            db = new JSONObject();
            try {
                if (file.exists()) {
                    FileInputStream fis = new FileInputStream(file);
                    byte[] buf = new byte[(int) file.length()];
                    int read = fis.read(buf);
                    fis.close();
                    if (read > 0) {
                        db = new JSONObject(new String(buf, StandardCharsets.UTF_8));
                    }
                }
            } catch (Exception ignore) {
                // corrupt file — fresh DB se chalu (tracking rukti nahi)
                db = new JSONObject();
            }
        }
    }

    private void save() {
        synchronized (lock) {
            try {
                FileOutputStream fos = new FileOutputStream(file);
                fos.write(db.toString().getBytes(StandardCharsets.UTF_8));
                fos.flush();
                fos.close();
            } catch (Exception ignore) {
                // save fail = sirf in-memory copy chalega (next save phir try karega)
            }
        }
    }

    // ================= LOOKUP (offline — no network) =================

    /** Exact tower key se {lat,lng,city} — net band hone par bhi kaam karta hai. */
    public TowerEntry lookup(String key) {
        if (key == null || key.isEmpty()) return null;
        synchronized (lock) {
            JSONObject o = db.optJSONObject(key);
            if (o == null) return null;
            return fromJson(key, o);
        }
    }

    /**
     * Sabse paas ki KNOWN tower ki city (25km cap) — tower key naya tha
     * (DB me nahi) par location halki si mil gayi (network fix) to bhi
     * city label de deta hai.
     */
    public String nearestCity(double lat, double lng) {
        synchronized (lock) {
            String bestCity = null;
            float bestDist = Float.MAX_VALUE;
            java.util.Iterator<String> it = db.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONObject o = db.optJSONObject(k);
                if (o == null) continue;
                double tLat = o.optDouble("lat", 9999);
                double tLng = o.optDouble("lng", 9999);
                if (tLat > 1000 || tLng > 1000) continue;
                float[] d = new float[1];
                try {
                    android.location.Location.distanceBetween(lat, lng, tLat, tLng, d);
                } catch (Exception e) {
                    continue;
                }
                if (d[0] < bestDist) {
                    bestDist = d[0];
                    String c = o.optString("city", "");
                    bestCity = c.isEmpty() ? null : c;
                }
            }
            if (bestDist <= NEAREST_CITY_CAP_M) return bestCity;
            return null;
        }
    }

    /** Kitne towers cached hain (diag/updater ke liye). */
    public int size() {
        synchronized (lock) {
            return db.length();
        }
    }

    // ================= SELF-LEARNING WRITE (native) =================

    /**
     * GPS fix (high-accuracy) + tower mila -> DB me record. Existing entry
     * par: EXISTING value Rakho agar naya fix zyada accurate hai tab hi
     * overwrite (jitter se tower ka anchor phisalta nahi). samples++.
     * City: naya city non-empty hai aur purana empty tha -> bhar do
     * (purana city naya ke saath overwrite nahi — city label stable rahta hai).
     */
    public void record(String key, double lat, double lng, float acc, String city) {
        if (key == null || key.isEmpty()) return;
        synchronized (lock) {
            try {
                JSONObject prev = db.optJSONObject(key);
                if (prev == null) {
                    JSONObject e = new JSONObject()
                            .put("lat", lat)
                            .put("lng", lng)
                            .put("acc", acc)
                            .put("city", city == null ? "" : city)
                            .put("samples", 1)
                            .put("updatedAt", System.currentTimeMillis());
                    db.put(key, e);
                    trimLocked();
                } else {
                    float prevAcc = (float) prev.optDouble("acc", 9999f);
                    if (acc > 0 && (prevAcc > 999f || acc < prevAcc)) {
                        prev.put("lat", lat).put("lng", lng).put("acc", acc);
                    }
                    if (city != null && !city.isEmpty()
                            && prev.optString("city", "").isEmpty()) {
                        prev.put("city", city);
                    }
                    prev.put("samples", prev.optInt("samples", 1) + 1);
                    prev.put("updatedAt", System.currentTimeMillis());
                }
                save();
            } catch (Exception ignore) {
            }
        }
    }

    // ================= TEAM SYNC MERGE (JS pushCellDb) =================

    /**
     * Firestore se aaye towers merge — naya/samples-bada hi jeetega.
     * JS har app-open par incremental sync karta hai (updatedAt > lastSync).
     */
    public int merge(JSONArray towers) {
        if (towers == null) return 0;
        int n = 0;
        synchronized (lock) {
            try {
                for (int i = 0; i < towers.length(); i++) {
                    JSONObject t = towers.optJSONObject(i);
                    if (t == null) continue;
                    String key = t.optString("key", "");
                    if (key.isEmpty()) continue;
                    double lat = t.optDouble("lat", 9999);
                    double lng = t.optDouble("lng", 9999);
                    if (lat > 1000 || lng > 1000) continue;
                    JSONObject prev = db.optJSONObject(key);
                    long newUpd = t.optLong("updatedAt", 0);
                    if (prev != null && prev.optLong("updatedAt", 0) > newUpd) continue; // purana sync
                    JSONObject e = new JSONObject()
                            .put("lat", lat)
                            .put("lng", lng)
                            .put("acc", t.optDouble("acc", 9999))
                            .put("city", t.optString("city", ""))
                            .put("samples", t.optInt("samples", 1))
                            .put("updatedAt", newUpd);
                    db.put(key, e);
                    n++;
                }
                if (n > 0) {
                    trimLocked();
                    save();
                }
            } catch (Exception ignore) {
            }
        }
        return n;
    }

    // ================= INTERNALS =================

    /** Cap se zyada entries ho to SABSE PURANE updatedAt wale hatao (LRU). */
    private void trimLocked() {
        try {
            while (db.length() > MAX_ENTRIES) {
                String oldestKey = null;
                long oldest = Long.MAX_VALUE;
                java.util.Iterator<String> it = db.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    long u = db.optJSONObject(k) == null ? 0 : db.optJSONObject(k).optLong("updatedAt", 0);
                    if (u < oldest) {
                        oldest = u;
                        oldestKey = k;
                    }
                }
                if (oldestKey == null) break;
                db.remove(oldestKey);
            }
        } catch (Exception ignore) {
        }
    }

    private static TowerEntry fromJson(String key, JSONObject o) {
        TowerEntry e = new TowerEntry();
        e.key = key;
        e.lat = o.optDouble("lat", 9999);
        e.lng = o.optDouble("lng", 9999);
        e.acc = (float) o.optDouble("acc", 9999);
        e.city = o.optString("city", "");
        e.samples = o.optInt("samples", 1);
        e.updatedAt = o.optLong("updatedAt", 0);
        return e;
    }
}
