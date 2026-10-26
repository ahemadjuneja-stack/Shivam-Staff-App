package com.shivam.staff;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * BACKGROUND LOCATION TRACKING (Boss order 2026-10-27):
 * "Salesman agar app on naa bhi kare aur location on kare tab bhi app unka
 *  location dashboard par aana chahiye"
 *
 * WebView JS timers app background/killed me suspend ho jate hain — isliye
 * tracking ab NATIVE Foreground Service karta hai jo app band hone par bhi
 * zinda rehta hai (notification ke saath):
 *
 *   - LocationManager GPS + NETWORK providers: har ~45s / 15m fix
 *   - Firestore REST (rules open — Task 49 verified) DIRECT writes, koi
 *     Firebase SDK nahi chahiye (java.net + org.json built-in):
 *       loc_sessions/{ls-uid-at}  points[]  <- poora road map
 *       loc_events/le-uid-at      on|off    <- kahan location ON/OFF kiya
 *       users/{uid}               lastLocation + lastSeenAt (live position)
 *       staff_attendance/{uid}    isOnDuty   <- location OFF = duty auto OUT,
 *                                    location ON (background) = duty auto IN
 *       punches/{auto}            in|out     <- auto_bg flag ke saath
 *   - PROVIDERS_CHANGED/MODE_CHANGED broadcast: location toggle MILLISECONDS
 *     me pakda jata hai — ON = naya session + 'on' event, OFF = session close
 *     + 'off' event + duty OUT
 *   - Net off: writes SharedPreferences queue me — net wapas aate hi flush
 *   - BootReceiver: reboot par restart; WatchdogReceiver: 15-min alarm restart
 *   - FOREGROUND rules: jab app visible hai (JS zinda hai) duty punches JS ke
 *     integrity path se hi hote hain (double punch nahi) — native sirf
 *     background/dead case me duty likhta hai. loc_events native hamesha
 *     likhta hai (JS ne apne event writes hata diye hain — single source).
 *   - SALES ONLY: service start Tracking prefs me role hota hai (JS App.tsx
 *     sirf sales ke liye startTracking() karta hai; logout = stopTracking).
 */
public class LocationTrackService extends Service {

    private static final String BASE =
            "https://firestore.googleapis.com/v1/projects/shivam-staff-ff7d5/databases/(default)/documents/";
    private static final String CHANNEL_ID = "shivam_tracking";
    private static final int NOTIF_ID = 7361;
    private static final long FIX_INTERVAL_MS = 45000L;
    private static final float FIX_MIN_DIST_M = 15f;
    private static final int FLUSH_AT = 2;                 // points per commit
    private static final long FLUSH_MAX_AGE_MS = 90000L;
    private static final int USERLOC_EVERY = 2;            // users patch har 2nd fix
    private static final int TRIM_CHECK_EVERY = 20;        // flush cycles
    private static final int MAX_POINTS_HARD = 900;
    private static final int MAX_POINTS_TRIM = 600;
    private static final long SESSION_STALE_MS = 12L * 60 * 60 * 1000;
    private static final int QUEUE_MAX = 200;
    private static final long WATCHDOG_MS = 15L * 60 * 1000;
    public static final String PREFS = "shivam_track";
    // toggleDuty fallback (JS Home.tsx) — fix na ho to yahi coords
    private static final double DEF_LAT = 22.3039;
    private static final double DEF_LNG = 70.8022;

    public static volatile boolean running = false;
    private static LocationTrackService instance;

    private final ExecutorPool pool = new ExecutorPool();
    private final Object bufLock = new Object();
    private final List<JSONObject> pointBuf = new ArrayList<>();
    private long bufOldestAt = 0;
    private HandlerThread locThread;
    private Handler locHandler;
    private LocationManager lm;
    private LocationListener locListener;
    private BroadcastReceiver provReceiver;
    private ConnectivityManager.NetworkCallback netCb;
    private boolean updatesOn = false;
    private boolean lastEnabled = false;
    private boolean haveEnabled = false;
    private Location lastFix;
    private int fixCount = 0;
    private int flushCycles = 0;

    private SharedPreferences prefs;
    private String uid, name;
    private int versionCode;
    private String sessionId;
    private long sessionStartedAt;
    private boolean sessionOpen;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = true;
        instance = this;
        try {
            uid = prefs.getString("uid", null);
            name = prefs.getString("name", "Staff");
            String role = prefs.getString("role", "");
            versionCode = prefs.getInt("versionCode", 0);
            if (uid == null || uid.length() < 4 || !"sales".equals(role)) {
                hardStop();
                return START_NOT_STICKY;
            }
            startForegroundType(buildNotification());
            registerProvReceiver();
            registerNetCallback();
            scheduleWatchdog();
            loadSessionState();
            lastEnabled = isLocationEnabled();
            haveEnabled = true;
            if (lastEnabled) {
                startUpdates();
                Location lk = lastKnown();
                ensureSessionInternal(lk, false);
            }
            pool.execute(this::flushQueue);
        } catch (Exception e) {
            // service kabhi crash nahi hogi — staff tracking business-critical hai
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ================= LIFECYCLE HELPERS =================

    private void hardStop() {
        try {
            stopUpdates();
            if (provReceiver != null) {
                unregisterReceiver(provReceiver);
                provReceiver = null;
            }
        } catch (Exception ignore) {
        }
        running = false;
        if (instance == this) instance = null;
        stopSelf();
    }

    private void startForegroundType(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ServiceCompat.startForeground(this, NOTIF_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            try {
                startForeground(NOTIF_ID, buildNotification());
            } catch (Exception ignore) {
            }
        }
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null
                && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                    "Staff Location Tracking", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps location updates flowing to the dashboard while the app is closed.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("Shivam Staff")
                .setContentText("Location tracking active")
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);
        return b.build();
    }

    private void scheduleWatchdog() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(this, WatchdogReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(this, 9001, i,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + WATCHDOG_MS, WATCHDOG_MS, pi);
        } catch (Exception ignore) {
            // START_STICKY + BootReceiver backup hai
        }
    }

    // ================= PROVIDERS CHANGED (INSTANT location ON/OFF) =================

    private void registerProvReceiver() {
        if (provReceiver != null) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(LocationManager.PROVIDERS_CHANGED_ACTION);
        filter.addAction(LocationManager.MODE_CHANGED_ACTION);
        provReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                try {
                    boolean en = isLocationEnabled();
                    if (haveEnabled && en == lastEnabled) return;
                    handleEnabledChange(en);
                } catch (Exception ignore) {
                }
            }
        };
        ContextCompat.registerReceiver(getApplicationContext(), provReceiver, filter,
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void registerNetCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null || netCb != null) return;
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    pokeFlush(); // net wapas aaya — pending writes flush
                }
            };
            cm.registerDefaultNetworkCallback(netCb);
        } catch (Exception ignore) {
        }
    }

    private void handleEnabledChange(boolean en) {
        lastEnabled = en;
        haveEnabled = true;
        if (en) {
            startUpdates();
            ensureSessionInternal(lastKnown(), false);
        } else {
            Location lk = lastFix != null ? new Location(lastFix) : lastKnown();
            stopUpdates();
            closeSessionInternal("loc_off", lk);
            writeEvent("off", lk);
            if (!LocationGuardPlugin.isAppForeground()) {
                dutySync(false, lk);
            }
        }
    }

    // ================= LOCATION UPDATES =================

    private boolean hasFine() {
        return ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startUpdates() {
        if (updatesOn || !hasFine()) return;
        try {
            if (lm == null) lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            if (lm == null) return;
            if (locThread == null) {
                locThread = new HandlerThread("shivamLocTrack");
                locThread.start();
                locHandler = new Handler(locThread.getLooper());
            }
            if (locListener == null) {
                locListener = new LocationListener() {
                    @Override
                    public void onLocationChanged(@NonNull Location location) {
                        try {
                            if (location == null) return;
                            lastFix = location;
                            appendPoint(location);
                        } catch (Exception ignore) {
                        }
                    }

                    @Override
                    public void onStatusChanged(String p, int s, Bundle e) {
                    }

                    @Override
                    public void onProviderEnabled(@NonNull String p) {
                    }

                    @Override
                    public void onProviderDisabled(@NonNull String p) {
                    }
                };
            }
            boolean any = false;
            try {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, FIX_INTERVAL_MS,
                        FIX_MIN_DIST_M, locListener, locHandler.getLooper());
                any = true;
            } catch (Exception ignore) {
            }
            try {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, FIX_INTERVAL_MS,
                        FIX_MIN_DIST_M, locListener, locHandler.getLooper());
                any = true;
            } catch (Exception ignore) {
            }
            updatesOn = any;
        } catch (Exception ignore) {
        }
    }

    private void stopUpdates() {
        try {
            if (lm != null && locListener != null) {
                lm.removeUpdates(locListener);
            }
        } catch (Exception ignore) {
        }
        updatesOn = false;
    }

    private Location lastKnown() {
        try {
            if (lm == null || !hasFine()) return null;
            Location g = null, n = null;
            try {
                g = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            } catch (Exception ignore) {
            }
            try {
                n = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            } catch (Exception ignore) {
            }
            if (g == null) return n;
            if (n == null) return g;
            return n.getTime() > g.getTime() ? n : g;
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isLocationEnabled() {
        try {
            if (lm == null) lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            if (lm == null) return false;
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        try {
            if (Build.VERSION.SDK_INT >= 31) return l.isMock();
            return l.isFromMockProvider();
        } catch (Exception e) {
            return false;
        }
    }

    // ================= POINTS BUFFER + FLUSH =================

    private JSONObject pointJson(Location l, long at) {
        JSONObject p = new JSONObject();
        try {
            p.put("at", at);
        } catch (Exception ignore) {
        }
        if (l == null) return p;
        try {
            p.put("lat", l.getLatitude());
            p.put("lng", l.getLongitude());
            if (l.hasAccuracy()) p.put("acc", l.getAccuracy());
            if (isMock(l)) p.put("mock", true);
        } catch (Exception ignore) {
        }
        return p;
    }

    private void appendPoint(Location l) {
        fixCount++;
        JSONObject p = pointJson(l, System.currentTimeMillis());
        boolean needFlush = false;
        synchronized (bufLock) {
            if (pointBuf.isEmpty()) bufOldestAt = System.currentTimeMillis();
            pointBuf.add(p);
            needFlush = pointBuf.size() >= FLUSH_AT
                    || (System.currentTimeMillis() - bufOldestAt) >= FLUSH_MAX_AGE_MS;
        }
        if (needFlush) {
            flushPoints();
        }
        if (fixCount % USERLOC_EVERY == 0) {
            updateLastLocation(l);
        }
    }

    private void flushPoints() {
        List<JSONObject> batch;
        synchronized (bufLock) {
            if (pointBuf.isEmpty()) return;
            batch = new ArrayList<>(pointBuf);
            pointBuf.clear();
            bufOldestAt = 0;
        }
        final List<JSONObject> send = batch;
        final String sid = sessionId;
        if (!sessionOpen || sid == null) {
            requeuePoints(send);
            return;
        }
        pool.execute(() -> {
            try {
                JSONObject docName = new JSONObject();
                // REST transform: atomic arrayUnion — JS sampler race-safe
                JSONObject tf = new JSONObject();
                tf.put("document", "projects/shivam-staff-ff7d5/databases/(default)/documents/loc_sessions/" + sid);
                JSONArray arr = new JSONArray();
                for (JSONObject p : send) {
                    arr.put(new JSONObject().put("mapValue",
                            new JSONObject().put("fields", p)));
                }
                tf.put("fieldTransforms", new JSONArray().put(new JSONObject()
                        .put("fieldPath", "points")
                        .put("appendMissingElements", new JSONObject().put("values", arr))));
                JSONObject body = new JSONObject().put("writes",
                        new JSONArray().put(new JSONObject().put("transform", tf)));
                HttpResult r = http("POST", BASE + "documents:commit", body.toString());
                if (r.ok) {
                    flushCycles++;
                    if (flushCycles % TRIM_CHECK_EVERY == 0) trimCheck(sid);
                } else {
                    requeuePoints(send);
                }
            } catch (Exception e) {
                requeuePoints(send);
            }
        });
    }

    private void requeuePoints(List<JSONObject> pts) {
        try {
            JSONArray q = new JSONArray(prefs.getString("queue", "[]"));
            for (JSONObject p : pts) {
                q.put(new JSONObject()
                        .put("tag", "point")
                        .put("method", "POST")
                        .put("url", BASE + "documents:commit")
                        .put("body", pointCommitBody(p)));
            }
            saveQueue(q);
        } catch (Exception ignore) {
        }
    }

    private String pointCommitBody(JSONObject p) {
        try {
            JSONObject tf = new JSONObject();
            // document name session state se flush time par lena hoga — build-time
            // session null ho sakta hai; placeholder '*' flushQueue replace karta hai
            tf.put("document", "SESSION_DOC");
            JSONArray arr = new JSONArray().put(new JSONObject().put("mapValue",
                    new JSONObject().put("fields", p)));
            tf.put("fieldTransforms", new JSONArray().put(new JSONObject()
                    .put("fieldPath", "points")
                    .put("appendMissingElements", new JSONObject().put("values", arr))));
            return new JSONObject().put("writes",
                    new JSONArray().put(new JSONObject().put("transform", tf))).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void trimCheck(String sid) {
        try {
            HttpResult r = http("GET", BASE + "loc_sessions/" + sid, null);
            if (!r.ok) return;
            JSONObject doc = new JSONObject(r.body);
            JSONObject fields = doc.optJSONObject("fields");
            if (fields == null) return;
            JSONObject pts = fields.optJSONObject("points");
            if (pts == null) return;
            JSONArray vals = pts.optJSONObject("arrayValue") == null
                    ? null : pts.optJSONObject("arrayValue").optJSONArray("values");
            if (vals == null) return;
            if (vals.length() <= MAX_POINTS_HARD) return;
            JSONArray keep = new JSONArray();
            for (int i = Math.max(0, vals.length() - MAX_POINTS_TRIM); i < vals.length(); i++) {
                keep.put(vals.get(i));
            }
            JSONObject upd = new JSONObject().put("fields",
                    new JSONObject().put("points", new JSONObject().put("arrayValue",
                            new JSONObject().put("values", keep))));
            http("POST", BASE + "loc_sessions/" + sid + "?updateMask=points", upd.toString());
        } catch (Exception ignore) {
        }
    }

    // ================= USERS lastLocation (LIVE position) =================

    private void updateLastLocation(Location l) {
        try {
            JSONObject fields = new JSONObject()
                    .put("lastLocation", new JSONObject().put("mapValue",
                            new JSONObject().put("fields", new JSONObject()
                                    .put("lat", new JSONObject().put("doubleValue", l.getLatitude()))
                                    .put("lng", new JSONObject().put("doubleValue", l.getLongitude()))
                                    .put("at", new JSONObject().put("integerValue", String.valueOf(System.currentTimeMillis())))
                                    .put("src", new JSONObject().put("stringValue", "svc")))))
                    .put("lastSeenAt", new JSONObject().put("integerValue",
                            String.valueOf(System.currentTimeMillis())));
            JSONObject body = new JSONObject().put("fields", fields);
            final String url = BASE + "users/" + uid + "?updateMask=lastLocation,lastSeenAt";
            final String b = body.toString();
            pool.execute(() -> {
                try {
                    HttpResult r = http("POST", url, b);
                    if (!r.ok) queueOp("userloc", url, b);
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    // ================= SESSIONS =================

    private void loadSessionState() {
        sessionId = prefs.getString("sessionId", null);
        sessionStartedAt = prefs.getLong("sessionStartedAt", 0);
        sessionOpen = prefs.getBoolean("sessionOpen", false);
        if (sessionOpen && sessionId != null
                && System.currentTimeMillis() - sessionStartedAt > SESSION_STALE_MS) {
            // zombie (process poori tarah mar gaya tha) — close + fresh karenge
            final String sid = sessionId;
            pool.execute(() -> closeSessionRemote(sid, "stale", null));
            sessionOpen = false;
            sessionId = null;
        }
    }

    private void saveSessionState() {
        SharedPreferences.Editor e = prefs.edit();
        if (sessionId == null) {
            e.remove("sessionId").remove("sessionStartedAt");
        } else {
            e.putString("sessionId", sessionId).putLong("sessionStartedAt", sessionStartedAt);
        }
        e.putBoolean("sessionOpen", sessionOpen);
        e.apply();
    }

    private void ensureSessionInternal(Location fix, boolean fromGate) {
        try {
            startUpdates(); // idempotent — gate pass (permission ab-abhi mili) ke baad bhi updates chalu
            long now = System.currentTimeMillis();
            if (sessionOpen && sessionId != null
                    && now - sessionStartedAt < SESSION_STALE_MS) {
                return; // RESUME — wahi session chalega
            }
            if (sessionOpen && sessionId != null) {
                final String sid = sessionId;
                pool.execute(() -> closeSessionRemote(sid, "stale", null));
            }
            final String id = "ls-" + uid + "-" + now;
            JSONArray firstPts = new JSONArray();
            if (fix != null) {
                firstPts.put(new JSONObject().put("mapValue",
                        new JSONObject().put("fields", pointJson(fix, now))));
            }
            JSONObject fields = new JSONObject()
                    .put("uid", new JSONObject().put("stringValue", uid))
                    .put("name", new JSONObject().put("stringValue", name))
                    .put("startedAt", new JSONObject().put("integerValue", String.valueOf(now)))
                    .put("status", new JSONObject().put("stringValue", "open"))
                    .put("versionCode", new JSONObject().put("integerValue", String.valueOf(versionCode)))
                    .put("deviceModel", new JSONObject().put("stringValue", Build.MODEL == null ? "Android device" : Build.MODEL))
                    .put("osVersion", new JSONObject().put("stringValue", "Android " + Build.VERSION.RELEASE))
                    .put("source", new JSONObject().put("stringValue", "svc"))
                    .put("points", new JSONObject().put("arrayValue",
                            new JSONObject().put("values", firstPts)));
            if (fix != null) {
                fields.put("startLat", new JSONObject().put("doubleValue", fix.getLatitude()))
                        .put("startLng", new JSONObject().put("doubleValue", fix.getLongitude()));
            }
            JSONObject body = new JSONObject().put("fields", fields);
            final String url = BASE + "loc_sessions/" + id;
            final Location f = fix;
            pool.execute(() -> {
                try {
                    HttpResult r = http("POST", url, body.toString());
                    if (r.ok) {
                        sessionId = id;
                        sessionStartedAt = now;
                        sessionOpen = true;
                        saveSessionState();
                        writeEvent("on", f);
                        if (!fromGate && !LocationGuardPlugin.isAppForeground()) {
                            dutySync(true, f);
                        }
                    } else {
                        queueOp("sess", url, body.toString());
                    }
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    private void closeSessionInternal(String reason, Location fix) {
        if (!sessionOpen || sessionId == null) return;
        flushPoints(); // bache hue points pehle
        final String sid = sessionId;
        final Location f = fix;
        sessionOpen = false;
        saveSessionState();
        pool.execute(() -> closeSessionRemote(sid, reason, f));
    }

    private void closeSessionRemote(String sid, String reason, Location fix) {
        try {
            long now = System.currentTimeMillis();
            JSONObject fields = new JSONObject()
                    .put("status", new JSONObject().put("stringValue", "closed"))
                    .put("endedAt", new JSONObject().put("integerValue", String.valueOf(now)))
                    .put("closedReason", new JSONObject().put("stringValue", reason));
            String mask = "status,endedAt,closedReason";
            if (fix != null) {
                fields.put("endLat", new JSONObject().put("doubleValue", fix.getLatitude()))
                        .put("endLng", new JSONObject().put("doubleValue", fix.getLongitude()));
                mask += ",endLat,endLng";
            }
            JSONObject body = new JSONObject().put("fields", fields);
            String url = BASE + "loc_sessions/" + sid + "?updateMask=" + mask;
            HttpResult r = http("POST", url, body.toString());
            if (!r.ok) queueOp("sessclose", url, body.toString());
        } catch (Exception ignore) {
        }
    }

    // ================= LOC EVENTS (kahan ON/OFF kiya) =================

    private void writeEvent(String type, Location fix) {
        try {
            long now = System.currentTimeMillis();
            JSONObject fields = new JSONObject()
                    .put("uid", new JSONObject().put("stringValue", uid))
                    .put("name", new JSONObject().put("stringValue", name))
                    .put("type", new JSONObject().put("stringValue", type))
                    .put("at", new JSONObject().put("integerValue", String.valueOf(now)))
                    .put("versionCode", new JSONObject().put("integerValue", String.valueOf(versionCode)))
                    .put("deviceModel", new JSONObject().put("stringValue", Build.MODEL == null ? "Android device" : Build.MODEL))
                    .put("source", new JSONObject().put("stringValue", "svc"));
            if (fix != null) {
                fields.put("lat", new JSONObject().put("doubleValue", fix.getLatitude()))
                        .put("lng", new JSONObject().put("doubleValue", fix.getLongitude()));
                if (fix.hasAccuracy()) {
                    fields.put("accuracy", new JSONObject().put("doubleValue", fix.getAccuracy()));
                }
            }
            JSONObject body = new JSONObject().put("fields", fields);
            final String url = BASE + "loc_events?documentId=le-" + uid + "-" + now;
            final String b = body.toString();
            pool.execute(() -> {
                try {
                    HttpResult r = http("POST", url, b);
                    if (!r.ok) queueOp("event", url, b);
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    // ================= DUTY SYNC (background me location par duty) =================

    private void dutySync(boolean on, Location fix) {
        pool.execute(() -> {
            try {
                // dedupe: attendance already isi state me hai to punch nahi
                HttpResult cur = http("GET", BASE + "staff_attendance/" + uid, null);
                if (cur.ok) {
                    try {
                        JSONObject f = new JSONObject(cur.body).getJSONObject("fields");
                        JSONObject d = f.optJSONObject("isOnDuty");
                        boolean nowOn = d != null && d.optBoolean("booleanValue", false);
                        if (nowOn == on) return;
                    } catch (Exception ignore) {
                    }
                }
                long now = System.currentTimeMillis();
                double lat = fix != null ? fix.getLatitude() : DEF_LAT;
                double lng = fix != null ? fix.getLongitude() : DEF_LNG;
                // 1) staff_attendance patch
                JSONObject att = new JSONObject().put("fields", new JSONObject()
                        .put("uid", new JSONObject().put("stringValue", uid))
                        .put("name", new JSONObject().put("stringValue", name))
                        .put("isOnDuty", new JSONObject().put("booleanValue", on))
                        .put("updatedAt", new JSONObject().put("timestampValue", iso(now))));
                String attUrl = BASE + "staff_attendance/" + uid + "?updateMask=uid,name,isOnDuty,updatedAt";
                HttpResult r1 = http("POST", attUrl, att.toString());
                if (!r1.ok) queueOp("att", attUrl, att.toString());
                // 2) punch record (JS toggleDuty ke fields ka mirror)
                JSONObject punch = new JSONObject().put("fields", new JSONObject()
                        .put("uid", new JSONObject().put("stringValue", uid))
                        .put("name", new JSONObject().put("stringValue", name))
                        .put("type", new JSONObject().put("stringValue", on ? "in" : "out"))
                        .put("at", new JSONObject().put("integerValue", String.valueOf(now)))
                        .put("lat", new JSONObject().put("doubleValue", lat))
                        .put("lng", new JSONObject().put("doubleValue", lng))
                        .put("dist", new JSONObject().put("integerValue", "10"))
                        .put("opId", new JSONObject().put("stringValue", "pn-" + uid + "-" + now + (on ? "-in" : "-out")))
                        .put("serverEstAt", new JSONObject().put("integerValue", String.valueOf(now)))
                        .put("clockOffsetMs", new JSONObject().put("integerValue", "0"))
                        .put("clockSuspect", new JSONObject().put("booleanValue", false))
                        .put("flags", new JSONObject().put("arrayValue",
                                new JSONObject().put("values", new JSONArray()
                                        .put(new JSONObject().put("stringValue", "auto_bg"))))));
                String pUrl = BASE + "punches";
                HttpResult r2 = http("POST", pUrl, punch.toString());
                if (!r2.ok) queueOp("punch", pUrl, punch.toString());
            } catch (Exception ignore) {
            }
        });
    }

    // ================= OFFLINE QUEUE (net off -> flush on net on) =================

    private void queueOp(String tag, String url, String body) {
        try {
            JSONArray q = new JSONArray(prefs.getString("queue", "[]"));
            // dedupe: userloc sirf latest rakho
            if ("userloc".equals(tag)) {
                JSONArray nq = new JSONArray();
                for (int i = 0; i < q.length(); i++) {
                    JSONObject o = q.getJSONObject(i);
                    if (!"userloc".equals(o.optString("tag"))) nq.put(o);
                }
                q = nq;
            }
            q.put(new JSONObject().put("tag", tag).put("method", "POST")
                    .put("url", url).put("body", body));
            while (q.length() > QUEUE_MAX) {
                JSONArray nq = new JSONArray();
                for (int i = 1; i < q.length(); i++) nq.put(q.get(i));
                q = nq;
            }
            saveQueue(q);
        } catch (Exception ignore) {
        }
    }

    private void saveQueue(JSONArray q) {
        prefs.edit().putString("queue", q.toString()).apply();
    }

    private void flushQueue() {
        try {
            JSONArray q = new JSONArray(prefs.getString("queue", "[]"));
            if (q.length() == 0) return;
            JSONArray remain = new JSONArray();
            for (int i = 0; i < q.length(); i++) {
                JSONObject o = q.getJSONObject(i);
                String url = o.optString("url");
                String body = o.optString("body");
                // queued point-commit ka document name ab ke session se
                if (body.contains("SESSION_DOC")) {
                    if (!sessionOpen || sessionId == null) {
                        remain.put(o);
                        continue;
                    }
                    body = body.replace("SESSION_DOC",
                            "projects/shivam-staff-ff7d5/databases/(default)/documents/loc_sessions/" + sessionId);
                }
                try {
                    HttpResult r = http("POST", url, body);
                    if (!r.ok) remain.put(o);
                } catch (Exception e) {
                    remain.put(o);
                }
            }
            saveQueue(remain);
        } catch (Exception ignore) {
        }
    }

    // ================= HTTP (java.net — koi dependency nahi) =================

    private static class HttpResult {
        final boolean ok;
        final int code;
        final String body;

        HttpResult(boolean ok, int code, String body) {
            this.ok = ok;
            this.code = code;
            this.body = body;
        }
    }

    private HttpResult http(String method, String urlStr, String body) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            if ("GET".equals(method)) {
                c.setRequestMethod("GET");
            } else {
                // HttpURLConnection PATCH support nahi karta — Google APIs
                // X-HTTP-Method-Override header maante hain (PATCH yahi se)
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

    private static String iso(long ms) {
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(
                    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
            sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return sdf.format(new java.util.Date(ms));
        } catch (Exception e) {
            return String.valueOf(ms);
        }
    }

    // ================= PLUGIN ENTRY =================

    /** LocationGuard.ensureSession() — gate pass fresh fix ke saath. */
    public static void ensureFromPlugin(boolean hasFix, double lat, double lng) {
        LocationTrackService s = instance;
        if (s == null || !running) return;
        Location l = null;
        if (hasFix && lat != 0 && lng != 0) {
            l = new Location("jsfix");
            l.setLatitude(lat);
            l.setLongitude(lng);
            l.setAccuracy(10f);
            l.setTime(System.currentTimeMillis());
        } else {
            l = s.lastKnown();
        }
        final Location f = l;
        s.pool.execute(() -> s.ensureSessionInternal(f, true));
    }

    /** ConnectivityManager callback se queue flush (net wapas aaya). */
    public static void pokeFlush() {
        LocationTrackService s = instance;
        if (s == null || !s.running) return;
        s.pool.execute(s::flushQueue);
    }

    private static class ExecutorPool {
        private final java.util.concurrent.ExecutorService ex =
                java.util.concurrent.Executors.newSingleThreadExecutor();

        void execute(Runnable r) {
            try {
                ex.execute(r);
            } catch (Exception ignore) {
            }
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
        try {
            stopUpdates();
        } catch (Exception ignore) {
        }
        try {
            if (provReceiver != null) unregisterReceiver(provReceiver);
        } catch (Exception ignore) {
        }
        provReceiver = null;
        try {
            if (netCb != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(netCb);
            }
        } catch (Exception ignore) {
        }
        netCb = null;
        super.onDestroy();
    }
}
