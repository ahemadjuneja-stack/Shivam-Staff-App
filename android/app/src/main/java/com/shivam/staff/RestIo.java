package com.shivam.staff;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * ============================================================
 * REST IO — SILENT ENGINES ka shared Firestore REST layer
 * (Boss order 2026-11-17: worker 100m engine + sales silent tower ping,
 * "notifications nahi aana chahiye, background me silent").
 *
 * LocationTrackService ka exact http() pattern copy — rules open (Task 49
 * verified), X-HTTP-Method-Override PATCH (HttpURLConnection PATCH support
 * nahi karta), offline pending-queue SharedPreferences me (next wake par
 * flush — app killed ho gaya to bhi write kho nahi jata).
 *
 * SAB kuch try/catch — silent engine kabhi crash nahi kar sakta (Boss:
 * "galati ki koi gunjaish nahi"). No notification, no foreground service,
 * no screen — sirf radio read + chhota REST write.
 * ============================================================
 */
public final class RestIo {

    private RestIo() {
    }

    public static final String BASE =
            "https://firestore.googleapis.com/v1/projects/shivam-staff-ff7d5/databases/(default)/documents/";

    public static final class HttpResult {
        public final boolean ok;
        public final int code;
        public final String body;

        HttpResult(boolean ok, int code, String body) {
            this.ok = ok;
            this.code = code;
            this.body = body;
        }
    }

    /** LocationTrackService.http() ka copy — silent engines standalone chalte hain. */
    public static HttpResult http(String method, String urlStr, String body) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(9000);
            c.setReadTimeout(12000);
            if ("GET".equals(method)) {
                c.setRequestMethod("GET");
            } else {
                c.setRequestMethod("POST");
                c.setRequestProperty("X-HTTP-Method-Override", method);
                c.setDoOutput(true);
            }
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            if (body != null) {
                byte[] out = body.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(out.length);
                OutputStream os = c.getOutputStream();
                os.write(out);
                os.flush();
                os.close();
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
            }
            return new HttpResult(code >= 200 && code < 300, code, sb.toString());
        } catch (Exception e) {
            return new HttpResult(false, -1, "");
        } finally {
            if (c != null) try {
                c.disconnect();
            } catch (Exception ignore) {
            }
        }
    }

    public static String iso(long ms) {
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(
                    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
            sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return sdf.format(new java.util.Date(ms));
        } catch (Exception e) {
            return String.valueOf(ms);
        }
    }

    public static String isoDay(long ms) {
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(
                    "yyyy-MM-dd", java.util.Locale.US);
            return sdf.format(new java.util.Date(ms));
        } catch (Exception e) {
            return "";
        }
    }

    // ---------- Firestore REST field shorthands ----------
    // NOTE (Gradle build fix): Android platform org.json ka HAR put() overload
    // checked JSONException THROW karta hai — helpers internal try/catch ke
    // saath safe hain (callers ke try blocks double-cover karte hain).

    public static JSONObject fS(String v) {
        try {
            return new JSONObject().put("stringValue", v == null ? "" : v);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public static JSONObject fI(long v) {
        try {
            return new JSONObject().put("integerValue", String.valueOf(v));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public static JSONObject fD(double v) {
        try {
            return new JSONObject().put("doubleValue", v);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public static JSONObject fB(boolean v) {
        try {
            return new JSONObject().put("booleanValue", v);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public static JSONObject fArr(JSONArray values) {
        try {
            return new JSONObject().put("arrayValue",
                    new JSONObject().put("values", values.length() == 0 ? new JSONArray() : values));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    // ---------- OFFLINE QUEUE (prefs-backed — write fail to next wake par flush) ----------

    public static void queueOp(SharedPreferences p, String listKey, String url, String body) {
        try {
            JSONArray q = new JSONArray(p.getString(listKey, "[]"));
            q.put(new JSONObject().put("url", url).put("body", body));
            // cap 25 — sabse purane drop (naye zyada zaroori)
            JSONArray capped = new JSONArray();
            int start = Math.max(0, q.length() - 25);
            for (int i = start; i < q.length(); i++) capped.put(q.get(i));
            p.edit().putString(listKey, capped.toString()).apply();
        } catch (Exception ignore) {
        }
    }

    public static void flushQueue(SharedPreferences p, String listKey) {
        try {
            JSONArray q = new JSONArray(p.getString(listKey, "[]"));
            if (q.length() == 0) return;
            JSONArray remain = new JSONArray();
            for (int i = 0; i < q.length(); i++) {
                try {
                    JSONObject op = q.getJSONObject(i);
                    HttpResult r = http("POST", op.getString("url"), op.getString("body"));
                    if (!r.ok) remain.put(op);
                } catch (Exception e) {
                    try {
                        remain.put(q.get(i));
                    } catch (Exception ignore) {
                    }
                }
            }
            p.edit().putString(listKey, remain.length() == 0 ? "[]" : remain.toString()).apply();
        } catch (Exception ignore) {
        }
    }

    /** [batteryPct, charging] — sticky intent se (koi listener nahi, zero cost). */
    public static int[] readBattery(Context ctx) {
        int[] out = new int[]{-1, 0};
        try {
            BatteryManager bm = (BatteryManager) ctx.getApplicationContext()
                    .getSystemService(Context.BATTERY_SERVICE);
            if (bm != null) {
                int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (level > 0 && level <= 100) out[0] = level;
            }
            Intent i = ctx.getApplicationContext().registerReceiver(null,
                    new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i != null) {
                int plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                out[1] = plugged != 0 ? 1 : 0;
            }
        } catch (Exception ignore) {
        }
        return out;
    }

    /** Dono points ke beech distance (meters) — geofence.ts haversine jaisa. */
    public static float haversineM(double aLat, double aLng, double bLat, double bLng) {
        try {
            float[] res = new float[1];
            android.location.Location.distanceBetween(aLat, aLng, bLat, bLng, res);
            return res[0];
        } catch (Exception e) {
            return -1f;
        }
    }

    /** Common doc fields jo har silent write me jaate hain (device identity). */
    public static void putDeviceFields(JSONObject fields, int versionCode) {
        try {
            fields.put("versionCode", fI(versionCode));
            fields.put("deviceModel", fS(Build.MODEL == null ? "Android device" : Build.MODEL));
            fields.put("osVersion", fS("Android " + Build.VERSION.RELEASE));
        } catch (Exception ignore) {
        }
    }

}
