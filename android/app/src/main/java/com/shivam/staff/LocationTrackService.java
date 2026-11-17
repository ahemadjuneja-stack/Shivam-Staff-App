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
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
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
 *   - ADAPTIVE LOCATION ENGINE (Boss 2026-10-27: "Zomato jaisa formulas —
 *     location hamesha on rahe magar battery kam use ho"; Boss 2026-10-28
 *     battery order: "ek jaga bethe ho to bar bar location nahi lena chahiye,
 *     thoda sa chalne ke baad location leta rahe"): MOVING = GPS+NETWORK
 *     60s/20m (fix sirf tab jab thoda sa chal gaya ho); 2 min ek jagah ruko
 *     = STILL = GPS chip BAND, sirf NETWORK har 4min + PASSIVE provider
 *     (dusre apps ke GPS fixes FREE) + hardware SignificantMotion sensor
 *     (hila to turant MOVING wapas). Anchor se 75m+accuracy ya 250m+ jaane
 *     par bhi MOVING. Passive flood 20s gap-guard. Research-backed: adaptive
 *     polling + displacement throttle + passive provider + motion sensor
 *     (Uber/Zomato playbook) — background GPS active time ~60-90% kam
 *     typical field day me.
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
    private static final String CHANNEL_ID = "shivam_track_v2";
    private static final String CHANNEL_ID_OLD = "shivam_tracking";
    private static final int NOTIF_ID = 7361;
    // BATTERY (Boss 2026-10-28: "ek jaga bethe ho to bar bar location nahi
    // lena chahiye, thoda sa chalne ke baad location leta rahe"): MOVING fix
    // 45s/15m -> 60s/20m (displacement-driven — ruka hua vyakti fix trigger
    // nahi karega) + STILL confirm 3min -> 2min (GPS chip 1 min pehle band).
    private static final long FIX_INTERVAL_MS = 60000L;
    private static final float FIX_MIN_DIST_M = 20f;
    // ---- ADAPTIVE BATTERY ENGINE constants ----
    private static final int MODE_MOVING = 0;
    private static final int MODE_STILL = 1;
    private static final long STILL_INTERVAL_MS = 240000L;   // STILL: network fix har 4min
    private static final float STILL_MIN_DIST_M = 40f;       // STILL: 40m displacement
    private static final float STATIONARY_RADIUS_M = 75f;    // anchor radius (accuracy-aware)
    private static final long STILL_CONFIRM_MS = 120000L;    // 2 min still -> GPS band (Boss 2026-10-28 battery order)
    private static final long MIN_FIX_GAP_MS = 20000L;       // passive flood guard
    private static final int FLUSH_AT = 2;                 // points per commit
    private static final long FLUSH_MAX_AGE_MS = 90000L;
    private static final int USERLOC_EVERY = 2;            // users patch har 2nd fix
    private static final int TRIM_CHECK_EVERY = 20;        // flush cycles
    private static final int MAX_POINTS_HARD = 900;
    private static final int MAX_POINTS_TRIM = 600;
    private static final long SESSION_STALE_MS = 12L * 60 * 60 * 1000;
    private static final int QUEUE_MAX = 200;
    private static final long WATCHDOG_MS = 15L * 60 * 1000;
    // ---- HYBRID TOUR ENGINE (Boss order 2026-11-17: "Rail jaise system —
    //      jaise where is my train me internet band ho tab bhi tower id se
    //      pata chalta hai train kaha pohchi hai" + "har 15 min me data manager
    //      ko" + GPS battery bachat): TOUR me GPS chip BAND — sirf NETWORK
    //      (tower/wifi) 15-min ping + PASSIVE free fixes; 15 min ek jagah ruka
    //      = ONE-TIME GPS BURST = exact CLIENT VISIT LOG; tower key (mcc-mnc-
    //      lac-cid) local self-learning DB se city me map hota hai — internet
    //      band hone par bhi (CellDbCache — Where-is-my-train pattern). ----
    private static final long TOUR_PING_MS = 15L * 60 * 1000;   // 15-min ping = manager sync cadence
    private static final float TOUR_MIN_DIST_M = 50f;           // network ping displacement
    private static final float TOUR_FAR_M = 10000f;             // home base se 10km+ = TOUR mode
    private static final long DWELL_MIN_MS = 15L * 60 * 1000;   // 15 min ruka = CLIENT VISIT
    private static final float DWELL_RADIUS_M = 200f;           // dwell radius (accuracy-aware)
    private static final long BURST_TIMEOUT_MS = 45000L;        // GPS burst 45s timeout -> fallback
    private static final float BURST_ACC_MAX_M = 60f;           // burst fix accuracy gate
    private static final long LIVE_MIN_GAP_MS = 120000L;        // HOME mode live-doc throttle (2 min)
    private static final long TOUR_PASSIVE_GAP_MS = 60000L;     // tour passive flood guard (60s)
    private static final float TELEPORT_KMH = 260f;             // anti-spoof speed cap (flight = fake GPS)
    private static final long TELEPORT_WINDOW_MS = 600000L;     // 10-min+ gap par teleport check nahi
    private static final float TOWER_MISMATCH_M = 15000f;       // GPS vs serving tower 15km+ = spoof flag
    private static final float LEARN_ACC_MAX_M = 60f;           // tower learning sirf accurate fix se
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

    // adaptive engine state (locHandler thread owner, mode volatile — cross-thread)
    private volatile int mode = MODE_MOVING;
    private double anchorLat, anchorLng;
    private boolean hasAnchor = false;
    private long stillSinceAt = 0L;
    private long lastAcceptedFixAt = 0L;
    private SensorManager sm;
    private Sensor sigMotion;
    private TriggerEventListener trigListener;

    // ---- HYBRID TOUR STATE (locHandler thread owner; volatile = cross-thread) ----
    private double homeLat, homeLng;                 // home base = shop center (JS startTracking se)
    private String homeCity = "";                    // sales ka apna city (users doc)
    private volatile boolean tourMode = false;       // true = GPS band, tower engine chalu
    private volatile boolean burstDone = false;      // current anchor ka visit log ho chuka (dedupe)
    private volatile boolean burstInFlight = false;  // GPS burst abhi chal raha hai
    private volatile String liveState = "HOME";      // HOME|TRANSIT|DWELL|VISIT|LOC_OFF
    private volatile long lastLiveWriteAt = 0L;
    private volatile String lastCellKey = "";        // current serving tower fingerprint
    private volatile CellTowerWatcher.TowerSnapshot lastCell;
    private volatile float lastTeleportKmh = -1f;    // is fix par teleport pakda (anti-spoof)
    private LocationListener burstListener;          // sirf locHandler thread
    private Runnable burstTimeout;                   // sirf locHandler thread
    private CellDbCache cellDb;                      // offline tower->city DB (file-backed)
    private volatile String visitDayKey = "";        // local YYYY-MM-DD — todayVisits roll
    private volatile int todayVisits = 0;            // aaj ke GPS-burst visits (service restart-proof)
    private volatile long lastVisitAt = 0L;
    private volatile String lastVisitCity = "";

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
            initTourState(); // home base + tower DB + aaj ke visits load (hybrid engine)
            lastEnabled = isLocationEnabled();
            haveEnabled = true;
            resetStillness();
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
            disarmMotionSensor();
            cleanupBurst();
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

    /** NOTIFICATION JUGAAD (Boss 2026-10-28: "kam se kam unhe notification naa
     *  dikhe ke battery le raha hai aur background me chal raha hai — apne
     *  hisab se kuch jugad lagao"):
     *  1) NAYA channel "shivam_track_v2" IMPORTANCE_MIN par — notification
     *     drawer ke SABSE NICHE silent section me jata hai (Android 13+ "Ongoing"
     *     collapsed section), koi sound/vibration/badge nahi, lockscreen par
     *     nahi dikhta. Kuch OEM ROMs (Xiaomi/Samsung) MIN ko status bar se
     *     poora chhupa bhi dete hain. PURANA channel (IMPORTANCE_LOW) delete —
     *     channel importance immutable hota hai, isliye naya ID zaroori tha.
     *  2) Text me battery/tracking/background jaise shabd NAHI — bas "App
     *     connected" (normal sync service jaisa neutral).
     *  3) FOREGROUND_SERVICE_DEFERRED (API 31+): notification turant pop nahi
     *     hoti. NOTE: Android system ka "Active apps" panel (long-press) FGS
     *     chalne par dikhata hi hai — wo OS UI hai, hum nahi hata sakte;
     *     par user ko notification bar me battery-warning AB nahi dikhegi. */
    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            try {
                nm.deleteNotificationChannel(CHANNEL_ID_OLD); // purana LOW-importance channel hatao
            } catch (Exception ignore) {
            }
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                        "Staff App", NotificationManager.IMPORTANCE_MIN);
                ch.setDescription("Keeps the app connected while you work.");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("Shivam Staff")
                .setContentText("App connected")
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED);
            } catch (Exception ignore) {
            }
        }
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
            resetStillness();
            startUpdates();
            ensureSessionInternal(lastKnown(), false);
        } else {
            Location lk = lastFix != null ? new Location(lastFix) : lastKnown();
            stopUpdates();
            closeSessionInternal("loc_off", lk);
            writeEvent("off", lk);
            // LIVE DOC ALERT (Boss 2026-11-17): location band karte hi manager
            // board par red "LOC_OFF" — chhupna impossible (aakhri tower/city
            // ke saath snapshot: kahan khada tha us waqt)
            liveState = "LOC_OFF";
            try {
                writeLiveDoc(lk, "svc", "LOC_OFF");
            } catch (Exception ignore) {
            }
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
                            onFixAdaptive(location);
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
            if (tourMode) {
                // ---- TOUR MODE (Boss 2026-11-17: GPS chip BAND, battery bachat) ----
                // Sirf NETWORK (tower/wifi) 15-min ping + PASSIVE (dusre apps ke
                // fixes FREE). GPS sirf dwell-burst + gate-fix par jalta hai.
                // City/internet-band case: tower key -> CellDbCache (offline).
                try {
                    if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                        lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, TOUR_PING_MS,
                                TOUR_MIN_DIST_M, locListener, locHandler.getLooper());
                        any = true;
                    }
                } catch (Exception ignore) {
                }
                try {
                    lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 0L, 0f,
                            locListener, locHandler.getLooper());
                } catch (Exception ignore) {
                }
                if (!any) {
                    // NETWORK off (airplane/rural) — GPS fallback (blind na rahe;
                    // tour ping rare hai isliye yahan bhi battery hit minimal)
                    try {
                        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, TOUR_PING_MS,
                                TOUR_MIN_DIST_M, locListener, locHandler.getLooper());
                        any = true;
                    } catch (Exception ignore) {
                    }
                }
            } else if (mode == MODE_MOVING) {
                // MOVING: GPS + NETWORK 60s/20m — fix tab hi jab thoda sa chal
                // gaya (Boss 2026-10-28: "thoda sa chalne ke baad location leta rahe")
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
            } else {
                // STILL (Zomato-grade saver): GPS chip BAND — sirf NETWORK (cell/wifi)
                // har 4min + PASSIVE (dusre apps ke fixes FREE). Network na ho to GPS
                // fallback (blind na rahe). Is state me GPS battery ~90% bachti hai.
                boolean netOk = false;
                try {
                    if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                        lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, STILL_INTERVAL_MS,
                                STILL_MIN_DIST_M, locListener, locHandler.getLooper());
                        netOk = true;
                    }
                } catch (Exception ignore) {
                }
                try {
                    lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 0L, 0f,
                            locListener, locHandler.getLooper());
                } catch (Exception ignore) {
                }
                if (!netOk) {
                    try {
                        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, FIX_INTERVAL_MS,
                                FIX_MIN_DIST_M, locListener, locHandler.getLooper());
                        netOk = true;
                    } catch (Exception ignore) {
                    }
                }
                any = netOk;
            }
            updatesOn = any;
            armMotionSensor();
        } catch (Exception ignore) {
        }
    }

    // ================= ADAPTIVE BATTERY ENGINE (research-backed) =================

    private void resetStillness() {
        hasAnchor = false;
        stillSinceAt = 0L;
    }

    private void switchMode(int m) {
        if (mode == m) return;
        mode = m;
        if (updatesOn) {
            stopUpdates();
            startUpdates();
        }
    }

    /**
     * Har fix par mode decision:
     *  - anchor se STATIONARY_RADIUS+accuracy (ya 250m+) door = MOVING (GPS on)
     *  - MOVING me 3 min ek jagah = STILL (GPS band, network-only + passive)
     * Accuracy-aware threshold — coarse network fix ka noise mode-flapping
     * nahi karega (flapping = zyada battery, isliye guard zaroori).
     */
    private void onFixAdaptive(Location l) {
        long now = System.currentTimeMillis();
        float teleportKmh = -1f;
        try {
            // TELEPORT GUARD (anti-cheat — Boss: "galati hui to fayda salesmen ko
            // hoga boss ko nahi"): pichle accepted fix se 260km/h+ = physically
            // impossible — fake-GPS app ka classic signal. Tower wahi khada hai
            // par GPS 100km door le jata hai — dono flag + mismatch alag se.
            if (lastAcceptedFixAt > 0 && lastFix != null) {
                long gap = now - lastAcceptedFixAt;
                if (gap > 5000L && gap < TELEPORT_WINDOW_MS) {
                    try {
                        float[] dt = new float[1];
                        Location.distanceBetween(lastFix.getLatitude(), lastFix.getLongitude(),
                                l.getLatitude(), l.getLongitude(), dt);
                        float kmh = dt[0] / Math.max(1f, gap / 1000f) * 3.6f;
                        if (kmh > TELEPORT_KMH) teleportKmh = kmh;
                    } catch (Exception ignore) {
                    }
                }
            }
            // TOUR/HOME mode: home base (shop center) se 10km+ door = tour
            // (GPS band -> tower engine) — wapas aaya to poora precise engine
            updateTourMode(l);
            double lat = l.getLatitude();
            double lng = l.getLongitude();
            if (!hasAnchor) {
                anchorLat = lat;
                anchorLng = lng;
                hasAnchor = true;
                stillSinceAt = now;
            } else {
                float[] d = new float[1];
                try {
                    Location.distanceBetween(lat, lng, anchorLat, anchorLng, d);
                } catch (Exception e) {
                    d[0] = 0f;
                }
                float acc = l.hasAccuracy() ? l.getAccuracy() : 30f;
                boolean moved = d[0] > (STATIONARY_RADIUS_M + acc) || d[0] > 250f;
                if (moved) {
                    anchorLat = lat;
                    anchorLng = lng;
                    stillSinceAt = now;
                    if (tourMode) {
                        // TOUR: chal pada — naya anchor, is anchor ka visit-burst reset
                        burstDone = false;
                        liveState = "TRANSIT";
                    }
                    if (mode != MODE_MOVING) switchMode(MODE_MOVING);
                } else if (!tourMode && mode == MODE_MOVING && now - stillSinceAt >= STILL_CONFIRM_MS) {
                    switchMode(MODE_STILL);
                }
            }
        } catch (Exception ignore) {
        }
        // STILL me passive fixes flood ho sakte hain (dusra app navigation chala
        // raha ho) — 20s gap guard warna writes + radio baar-baar jagenge
        if ((tourMode || mode == MODE_STILL) && "passive".equals(l.getProvider())
                && now - lastAcceptedFixAt < TOUR_PASSIVE_GAP_MS) {
            return;
        }
        lastAcceptedFixAt = now;
        lastTeleportKmh = teleportKmh;
        appendPoint(l);
        // HYBRID PIPELINE (Boss 2026-11-17): TOUR me visit-burst + 15-min
        // manager sync; HOME me throttled (2 min) live-doc — dono manager
        // dashboard ko sales_live/{uid} par feed karte hain.
        try {
            if (tourMode) {
                onTourFix(l, now);
            } else if (now - lastLiveWriteAt >= LIVE_MIN_GAP_MS) {
                writeLiveDoc(l, "svc", null);
            }
        } catch (Exception ignore) {
        }
    }

    /** Hardware Significant Motion sensor — hila to MILLISECONDS me MOVING mode
     *  (zero GPS cost, pure hardware trigger — Zomato/Uber jaisa). */
    private void armMotionSensor() {
        try {
            if (sm == null) sm = (SensorManager) getSystemService(SENSOR_SERVICE);
            if (sm == null || trigListener != null) return; // pehle se armed
            sigMotion = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
            if (sigMotion == null) return; // sensor nahi — distance fallback kaafi hai
            trigListener = new TriggerEventListener() {
                @Override
                public void onTrigger(TriggerEvent event) {
                    // trigger fire hone par auto-cancel hota hai — PEHLE re-arm
                    try {
                        sm.requestTriggerSensor(this, sigMotion);
                    } catch (Exception ignore) {
                    }
                    try {
                        if (locHandler != null) {
                            locHandler.post(() -> {
                                try {
                                    if (running && updatesOn && mode == MODE_STILL) {
                                        switchMode(MODE_MOVING);
                                    }
                                } catch (Exception ignore) {
                                }
                            });
                        }
                    } catch (Exception ignore) {
                    }
                }
            };
            sm.requestTriggerSensor(trigListener, sigMotion);
        } catch (Exception ignore) {
        }
    }

    private void disarmMotionSensor() {
        try {
            if (sm != null && trigListener != null) sm.cancelTriggerSensor(trigListener, sigMotion);
        } catch (Exception ignore) {
        }
        trigListener = null;
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
        // TOUR me har fix = 15-min ka hi hota hai — users.lastLocation bhi
        // har fix par (manager StaffDetail fresh rahe); HOME me purana throttle
        if (fixCount % (tourMode ? 1 : USERLOC_EVERY) == 0) {
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
            // APP-OPEN FIRST FIX (Boss 2026-11-17: "app open hote hi sab se
            // pehle gps location bheje"): gate ka fresh fix = serving tower read
            // + tower learning + live-doc write — manager ko TURANT pata sales
            // kahan app khol kar hai (city + tower + battery ke saath).
            final CellTowerWatcher.TowerSnapshot gateCell = CellTowerWatcher.read(this);
            if (gateCell != null && gateCell.ok) {
                lastCell = gateCell;
                lastCellKey = gateCell.key;
            }
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
                try {
                    if (f != null && f.hasAccuracy() && f.getAccuracy() <= LEARN_ACC_MAX_M) {
                        learnTower(f, gateCell); // GPS + tower = DB self-learning
                    }
                } catch (Exception ignore) {
                }
                try {
                    writeLiveDoc(f != null ? f : lastKnown(), "app_open", null);
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
            // dedupe: userloc/live sirf LATEST rakho (purana overwrite bekaar)
            if ("userloc".equals(tag) || "live".equals(tag)) {
                JSONArray nq = new JSONArray();
                for (int i = 0; i < q.length(); i++) {
                    JSONObject o = q.getJSONObject(i);
                    String t = o.optString("tag");
                    if (!"userloc".equals(t) && !"live".equals(t)) nq.put(o);
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

    // ============================================================
    // HYBRID TOUR ENGINE (Boss order 2026-11-17)
    // "Rail jaise system": TOUR me GPS chip BAND (battery bachat) — location
    // tower ID se chalti hai (NETWORK ping + cell key -> CellDbCache). 15 min
    // ek jagah ruka = ONE-TIME GPS BURST = exact CLIENT VISIT LOG. Har ping
    // manager ko sales_live/{uid} par. State machine:
    //   HOME -> TRANSIT -> DWELL -> [GPS BURST] -> VISIT -> (move) -> TRANSIT
    // ============================================================

    /** Home base prefs (JS startTracking se: shop center + home city) + tower DB + visits count. */
    private void initTourState() {
        try {
            if (lm == null) lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            homeLat = Double.longBitsToDouble(prefs.getLong("homeLat", 0L));
            homeLng = Double.longBitsToDouble(prefs.getLong("homeLng", 0L));
            homeCity = prefs.getString("homeCity", "");
            visitDayKey = prefs.getString("visitsDay", "");
            todayVisits = prefs.getInt("visitsCount", 0);
            lastVisitAt = prefs.getLong("lastVisitAt", 0L);
            lastVisitCity = prefs.getString("lastVisitCity", "");
            rollVisitDayIfNeeded();
            // CellDbCache (file I/O) + updateTourMode (geographer-free paths) —
            // file read main thread par StrictMode violation nahi kare, isliye
            // pool thread par init + tour decision
            final Location lk = lastKnown();
            pool.execute(() -> {
                try {
                    if (cellDb == null) cellDb = new CellDbCache(this);
                    if (lk != null) updateTourMode(lk);
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    /** Din badla -> todayVisits reset (local midnight bucket). */
    private void rollVisitDayIfNeeded() {
        try {
            String day = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                    .format(new java.util.Date());
            if (!day.equals(visitDayKey)) {
                visitDayKey = day;
                todayVisits = 0;
                prefs.edit().putString("visitsDay", day).putInt("visitsCount", 0).apply();
            }
        } catch (Exception ignore) {
        }
    }

    /**
     * HOME base (shop center) se 10km+ door = TOUR mode: GPS chip BAND —
     * sirf NETWORK 15-min ping + PASSIVE. Wapas shop ke paas = HOME mode:
     * poora precise road-map engine (Boss ka 2026-10-28 battery engine).
     */
    private void updateTourMode(Location l) {
        try {
            boolean far = false;
            if (homeLat != 0d && homeLng != 0d) {
                float[] d = new float[1];
                try {
                    Location.distanceBetween(l.getLatitude(), l.getLongitude(), homeLat, homeLng, d);
                } catch (Exception e) {
                    d[0] = 0f;
                }
                far = d[0] > TOUR_FAR_M;
            }
            if (far != tourMode) {
                tourMode = far;
                liveState = far ? "TRANSIT" : "HOME";
                if (updatesOn) {
                    stopUpdates();
                    startUpdates();
                }
                writeLiveDoc(l, "svc", far ? "TRANSIT" : "HOME");
            }
        } catch (Exception ignore) {
        }
    }

    /**
     * TOUR ping pipeline (har fix par — network 15-min + passive):
     * serving tower read -> dwell/visit decision -> 15-min manager sync.
     */
    private void onTourFix(Location l, long now) {
        try {
            CellTowerWatcher.TowerSnapshot cell = CellTowerWatcher.read(this);
            lastCell = cell;
            if (cell.ok && cell.key != null && !cell.key.isEmpty()) {
                lastCellKey = cell.key;
            }
            long dwellMs = hasAnchor ? now - stillSinceAt : 0L;
            float[] d = new float[1];
            if (hasAnchor) {
                try {
                    Location.distanceBetween(l.getLatitude(), l.getLongitude(), anchorLat, anchorLng, d);
                } catch (Exception e) {
                    d[0] = 0f;
                }
            }
            // accuracy-aware dwell radius (coarse network fix ka noise dwell
            // na tode — Boss rule: "galati ki koi gunjaish nahi")
            float acc = l.hasAccuracy() ? Math.min(l.getAccuracy(), 600f) : 400f;
            boolean stillHere = hasAnchor && d[0] <= (DWELL_RADIUS_M + acc);
            if (stillHere && dwellMs >= DWELL_MIN_MS && !burstDone && !burstInFlight) {
                // ---- STATE C: DWELL >= 15 min CONFIRMED -> ONE-TIME GPS BURST ----
                startBurst();
                return;
            }
            liveState = stillHere ? (burstDone ? "VISIT" : "DWELL") : "TRANSIT";
            // ---- STATE A: 15-min manager sync (ping interval hi cadence hai) ----
            if (now - lastLiveWriteAt >= TOUR_PING_MS) {
                writeLiveDoc(l, cell.ok ? "network" : "last", null);
            }
        } catch (Exception ignore) {
        }
    }

    /**
     * STATE C — ONE-TIME high-accuracy GPS burst (poore tour me yahi GPS hai):
     * 45s window, sirf ek visit per dwell-episode. Fix milte hi GPS listener
     * hata diya jata hai — GPS chip wapas band (battery bachat).
     */
    private void startBurst() {
        try {
            burstDone = true; // ek anchor = ek visit log (dedupe — double visit kabhi nahi)
            burstInFlight = true;
            liveState = "VISIT";
            if (lm == null || locHandler == null || !hasFine()) {
                handleBurstFix(null);
                return;
            }
            LocationListener bl = new LocationListener() {
                @Override
                public void onLocationChanged(@NonNull Location location) {
                    if (location != null && burstInFlight) handleBurstFix(location);
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
            burstListener = bl;
            try {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0L, 0f, bl, locHandler.getLooper());
            } catch (Exception e) {
                handleBurstFix(null); // GPS unavailable — last-fix fallback se bhi visit log
                return;
            }
            burstTimeout = () -> {
                if (burstInFlight) handleBurstFix(null); // 45s me fix nahi -> fallback
            };
            locHandler.postDelayed(burstTimeout, BURST_TIMEOUT_MS);
        } catch (Exception e) {
            burstInFlight = false;
        }
    }

    /**
     * Burst fix/timeout: visit log (sales_visits) + live doc + tower learning.
     * ANTI-SPOOF layer yahan hai: mock / teleport / low-accuracy / GPS-vs-
     * tower-mismatch flags — Boss ko hamesha sahi sach dikhe.
     */
    private void handleBurstFix(Location burst) {
        try {
            burstInFlight = false;
            if (burstTimeout != null && locHandler != null) {
                locHandler.removeCallbacks(burstTimeout);
                burstTimeout = null;
            }
            if (burstListener != null && lm != null) {
                try {
                    lm.removeUpdates(burstListener); // GPS chip turant BAND
                } catch (Exception ignore) {
                }
                burstListener = null;
            }
            // BEST fix: accurate burst > purana lastFix
            Location best;
            if (burst != null && (!burst.hasAccuracy() || burst.getAccuracy() <= BURST_ACC_MAX_M)) {
                best = burst;
            } else if (burst != null && lastFix != null
                    && burst.getAccuracy() <= (lastFix.hasAccuracy() ? lastFix.getAccuracy() : 9999f)) {
                best = burst;
            } else {
                best = lastFix;
            }
            long now = System.currentTimeMillis();
            long dwellMin = hasAnchor ? Math.max(1L, (now - stillSinceAt) / 60000L) : 0L;
            if (best == null) {
                // fix mila hi nahi (godown/underground) — is dwell ka burst
                // RETRY karenge (next 15-min ping par) — visit chhupna impossible,
                // missing visit = salesmen ka fayda (Boss: "galati ki koi gunjaish nahi")
                burstDone = false;
                writeLiveDoc(null, "burst_timeout", "VISIT");
                return;
            }
            java.util.List<String> flags = new ArrayList<>();
            if (lastTeleportKmh > 0) flags.add("gps_teleport");
            if (best.hasAccuracy() && best.getAccuracy() > BURST_ACC_MAX_M) flags.add("gps_low_accuracy");
            if (isMock(best)) flags.add("mock_location");
            // TOWER MISMATCH (anti-spoof ka sabse strong signal): fake-GPS app
            // location 100km door le jata hai par SIM REAL tower se judi rehti
            // hai — burst GPS vs serving tower 15km+ door = cheating flag
            CellTowerWatcher.TowerSnapshot cell = lastCell != null ? lastCell : CellTowerWatcher.read(this);
            lastCell = cell;
            if (cell != null && cell.ok && cellDb != null) {
                CellDbCache.TowerEntry te = cellDb.lookup(cell.key);
                if (te != null && te.lat < 1000d) {
                    float[] dm = new float[1];
                    try {
                        Location.distanceBetween(best.getLatitude(), best.getLongitude(), te.lat, te.lng, dm);
                    } catch (Exception e) {
                        dm[0] = 0f;
                    }
                    if (dm[0] > TOWER_MISMATCH_M) flags.add("gps_tower_mismatch");
                }
            }
            String[] city = resolveCity(best, cell);
            lastVisitAt = now;
            lastVisitCity = city[0];
            todayVisits++;
            prefs.edit().putInt("visitsCount", todayVisits)
                    .putLong("lastVisitAt", lastVisitAt)
                    .putString("lastVisitCity", lastVisitCity)
                    .apply();
            writeVisitLog(best, dwellMin, cell, city, flags, now);
            writeLiveDoc(best, "gps_burst", "VISIT");
            learnTower(best, cell); // GPS + tower = DB self-learning (future offline)
        } catch (Exception ignore) {
        }
    }

    /** Burst GPS listener + timeout ka cleanup (service stop/mode change par). */
    private void cleanupBurst() {
        try {
            if (burstTimeout != null && locHandler != null) locHandler.removeCallbacks(burstTimeout);
        } catch (Exception ignore) {
        }
        burstTimeout = null;
        try {
            if (burstListener != null && lm != null) lm.removeUpdates(burstListener);
        } catch (Exception ignore) {
        }
        burstListener = null;
        burstInFlight = false;
    }

    // ================= CITY RESOLUTION (geocoder -> tower DB -> home) =================

    /**
     * City naam nikaalna (manager ko naak ke neeche naam dikhta hai):
     *  1) Geocoder (accurate, net chahiye) — sirf decent-accuracy fix par
     *  2) Serving tower key ki city (CellDbCache — INTERNET BAND me bhi chalta hai)
     *  3) Nearest known tower ki city (25km cap)
     *  4) Home base 10km ke andar = home city
     * Returns {city, citySrc} — citySrc manager ko transparency ke liye.
     */
    private String[] resolveCity(Location fix, CellTowerWatcher.TowerSnapshot cell) {
        try {
            if (cellDb == null) cellDb = new CellDbCache(this);
            if (fix != null && fix.hasAccuracy() && fix.getAccuracy() <= 150f
                    && android.location.Geocoder.isPresent()) {
                try {
                    android.location.Geocoder g = new android.location.Geocoder(this, java.util.Locale.ENGLISH);
                    java.util.List<android.location.Address> list =
                            g.getFromLocation(fix.getLatitude(), fix.getLongitude(), 1);
                    if (list != null && !list.isEmpty()) {
                        android.location.Address a = list.get(0);
                        String c = a.getLocality() != null ? a.getLocality()
                                : (a.getSubAdminArea() != null ? a.getSubAdminArea() : a.getAdminArea());
                        if (c != null && !c.trim().isEmpty()) return new String[]{c.trim(), "geocoder"};
                    }
                } catch (Exception ignore) {
                    // offline/slow net — tower DB wale sources
                }
            }
            if (cell != null && cell.ok && cell.key != null && !cell.key.isEmpty() && cellDb != null) {
                CellDbCache.TowerEntry te = cellDb.lookup(cell.key);
                if (te != null && !te.city.isEmpty()) return new String[]{te.city, "tower_db"};
            }
            if (fix != null && cellDb != null) {
                String c = cellDb.nearestCity(fix.getLatitude(), fix.getLongitude());
                if (c != null && !c.isEmpty()) return new String[]{c, "tower_near"};
            }
            if (fix != null && homeLat != 0d && homeLng != 0d && homeCity != null && !homeCity.isEmpty()) {
                float[] d = new float[1];
                try {
                    Location.distanceBetween(fix.getLatitude(), fix.getLongitude(), homeLat, homeLng, d);
                } catch (Exception e) {
                    d[0] = Float.MAX_VALUE;
                }
                if (d[0] <= TOUR_FAR_M) return new String[]{homeCity, "home"};
            }
        } catch (Exception ignore) {
        }
        return new String[]{"", "none"};
    }

    // ================= TOWER DB LEARNING (GPS + tower mila = DB grow) =================

    /**
     * SELF-LEARNING (Where-is-my-train ka core): accurate GPS fix + serving
     * tower -> local cache record + Firestore cell_towers/{key} upsert.
     * Jitna staff ghumega, DB utna mota — agli trip par INTERNET BAND hone
     * par bhi tower se city dikh jayegi. Sirf <= 60m accuracy ke fix se
     * learn hota hai (galat tower-anchor kabhi nahi banta).
     */
    private void learnTower(Location fix, CellTowerWatcher.TowerSnapshot cell) {
        try {
            if (cellDb == null) cellDb = new CellDbCache(this);
            if (fix == null || cell == null || !cell.ok) return;
            if (cell.key == null || cell.key.isEmpty() || cell.key.endsWith("-0-0")) return;
            if (!fix.hasAccuracy() || fix.getAccuracy() > LEARN_ACC_MAX_M) return;
            String[] city = resolveCity(fix, cell);
            cellDb.record(cell.key, fix.getLatitude(), fix.getLongitude(), fix.getAccuracy(), city[0]);
            final String key = cell.key;
            final double lat = fix.getLatitude();
            final double lng = fix.getLongitude();
            final float acc = fix.getAccuracy();
            final String cityStr = city[0];
            pool.execute(() -> {
                try {
                    int samples = 1;
                    HttpResult cur = http("GET", BASE + "cell_towers/" + key, null);
                    if (cur.ok) {
                        try {
                            JSONObject f = new JSONObject(cur.body).optJSONObject("fields");
                            if (f != null) {
                                JSONObject sObj = f.optJSONObject("samples");
                                int prev = sObj == null ? 0 : sObj.optInt("integerValue", 0);
                                samples = Math.max(1, prev) + 1;
                            }
                        } catch (Exception ignore) {
                        }
                    }
                    JSONObject fields = new JSONObject()
                            .put("key", new JSONObject().put("stringValue", key))
                            .put("lat", new JSONObject().put("doubleValue", lat))
                            .put("lng", new JSONObject().put("doubleValue", lng))
                            .put("acc", new JSONObject().put("doubleValue", acc))
                            .put("samples", new JSONObject().put("integerValue", String.valueOf(samples)))
                            .put("updatedAt", new JSONObject().put("integerValue",
                                    String.valueOf(System.currentTimeMillis())));
                    if (cityStr != null && !cityStr.isEmpty()) {
                        fields.put("city", new JSONObject().put("stringValue", cityStr));
                    }
                    JSONObject body = new JSONObject().put("fields", fields);
                    String url = BASE + "cell_towers/" + key;
                    HttpResult r = http("POST", url, body.toString());
                    if (!r.ok) queueOp("tower", url, body.toString());
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    // ================= SALES VISIT LOG (GPS burst ka output) =================

    /**
     * sales_visits/{sv-uid-at} — CLIENT VISIT LOG (append-only):
     * {uid, name, at, arrivedAt, dwellMin, lat, lng, acc, city, citySrc,
     *  cellKey, mock, flags[], src:'hybrid_burst', versionCode, deviceModel}
     */
    private void writeVisitLog(Location fix, long dwellMin, CellTowerWatcher.TowerSnapshot cell,
                               String[] city, java.util.List<String> flags, long now) {
        try {
            JSONObject fields = new JSONObject()
                    .put("uid", new JSONObject().put("stringValue", uid))
                    .put("name", new JSONObject().put("stringValue", name))
                    .put("at", new JSONObject().put("integerValue", String.valueOf(now)))
                    .put("arrivedAt", new JSONObject().put("integerValue", String.valueOf(stillSinceAt)))
                    .put("dwellMin", new JSONObject().put("integerValue", String.valueOf(dwellMin)))
                    .put("lat", new JSONObject().put("doubleValue", fix.getLatitude()))
                    .put("lng", new JSONObject().put("doubleValue", fix.getLongitude()))
                    .put("src", new JSONObject().put("stringValue", "hybrid_burst"))
                    .put("versionCode", new JSONObject().put("integerValue", String.valueOf(versionCode)))
                    .put("deviceModel", new JSONObject().put("stringValue",
                            Build.MODEL == null ? "Android device" : Build.MODEL))
                    .put("osVersion", new JSONObject().put("stringValue", "Android " + Build.VERSION.RELEASE));
            if (fix.hasAccuracy()) {
                fields.put("acc", new JSONObject().put("doubleValue", fix.getAccuracy()));
            }
            if (city != null) {
                fields.put("city", new JSONObject().put("stringValue", city[0]));
                fields.put("citySrc", new JSONObject().put("stringValue", city[1]));
            }
            if (cell != null && cell.ok && cell.key != null && !cell.key.isEmpty()) {
                fields.put("cellKey", new JSONObject().put("stringValue", cell.key));
            }
            if (isMock(fix)) {
                fields.put("mock", new JSONObject().put("booleanValue", true));
            }
            if (flags != null && !flags.isEmpty()) {
                JSONArray arr = new JSONArray();
                for (String fl : flags) arr.put(new JSONObject().put("stringValue", fl));
                fields.put("flags", new JSONObject().put("arrayValue", new JSONObject().put("values", arr)));
            }
            JSONObject body = new JSONObject().put("fields", fields);
            String url = BASE + "sales_visits?documentId=sv-" + uid + "-" + now;
            final String b = body.toString();
            final String u = url;
            pool.execute(() -> {
                try {
                    HttpResult r = http("POST", u, b);
                    if (!r.ok) queueOp("visit", u, b); // net off — queue me, baad me flush
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    // ================= SALES LIVE DOC (har 15-min manager ko dikhta hai) =================

    /**
     * sales_live/{uid} — FULL REPLACE (stale flags kabhi nahi baste):
     * {uid, name, state, tourMode, lat, lng, acc, src, city, citySrc,
     *  cellKey, cell{mcc,mnc,lac,cid,dbm}, batteryPct, charging, flags[],
     *  todayVisits, lastVisitAt, lastVisitCity, at, versionCode, deviceModel}
     * Manager board (SalesLive.tsx) onSnapshot karta hai — 15-min fresh.
     * Queue tag "live" = dedupe-latest (net off par sirf sabse naya flush).
     */
    private void writeLiveDoc(Location fix, String src, String stateOverride) {
        try {
            long now = System.currentTimeMillis();
            rollVisitDayIfNeeded();
            final String state = stateOverride != null && !stateOverride.isEmpty() ? stateOverride : liveState;
            final Location f = fix;
            final String srcF = src;
            lastLiveWriteAt = now;
            // POORA BODY POOL THREAD PAR — resolveCity() me Geocoder (network)
            // call hai; ye main thread (PROVIDERS_CHANGED broadcast) se bhi call
            // hota hai — geocoder main thread par ANR de sakta hai (Boss:
            // "galati ki koi gunjaish nahi").
            pool.execute(() -> {
                try {
                    JSONObject fields = new JSONObject()
                            .put("uid", new JSONObject().put("stringValue", uid))
                            .put("name", new JSONObject().put("stringValue", name))
                            .put("state", new JSONObject().put("stringValue", state))
                            .put("tourMode", new JSONObject().put("booleanValue", tourMode))
                            .put("at", new JSONObject().put("integerValue", String.valueOf(now)))
                            .put("versionCode", new JSONObject().put("integerValue", String.valueOf(versionCode)))
                            .put("deviceModel", new JSONObject().put("stringValue",
                                    Build.MODEL == null ? "Android device" : Build.MODEL))
                            .put("osVersion", new JSONObject().put("stringValue", "Android " + Build.VERSION.RELEASE));
                    if (f != null) {
                        fields.put("lat", new JSONObject().put("doubleValue", f.getLatitude()));
                        fields.put("lng", new JSONObject().put("doubleValue", f.getLongitude()));
                        if (f.hasAccuracy()) {
                            fields.put("acc", new JSONObject().put("doubleValue", f.getAccuracy()));
                        }
                    }
                    if (srcF != null) {
                        fields.put("src", new JSONObject().put("stringValue", srcF));
                    }
                    // SERVING TOWER (rail-system core: ye key offline city deta hai)
                    CellTowerWatcher.TowerSnapshot cell = lastCell != null ? lastCell : CellTowerWatcher.read(this);
                    lastCell = cell;
                    if (cell != null && cell.ok && cell.key != null && !cell.key.isEmpty()) {
                        fields.put("cellKey", new JSONObject().put("stringValue", cell.key));
                        JSONObject cellMap = new JSONObject();
                        if (cell.mcc != null && !cell.mcc.isEmpty()) {
                            cellMap.put("mcc", new JSONObject().put("stringValue", cell.mcc));
                        }
                        if (cell.mnc != null && !cell.mnc.isEmpty()) {
                            cellMap.put("mnc", new JSONObject().put("stringValue", cell.mnc));
                        }
                        if (cell.lac >= 0) cellMap.put("lac", new JSONObject().put("integerValue", String.valueOf(cell.lac)));
                        if (cell.cid >= 0) cellMap.put("cid", new JSONObject().put("integerValue", String.valueOf(cell.cid)));
                        if (cell.dbm != 0) cellMap.put("dbm", new JSONObject().put("integerValue", String.valueOf(cell.dbm)));
                        if (cellMap.length() > 0) {
                            fields.put("cell", new JSONObject().put("mapValue",
                                    new JSONObject().put("fields", cellMap)));
                        }
                    }
                    // CITY (tower DB + geocoder + home) — manager ko naam se dikhta hai
                    String[] city = resolveCity(f, cell);
                    fields.put("city", new JSONObject().put("stringValue", city[0]));
                    fields.put("citySrc", new JSONObject().put("stringValue", city[1]));
                    // BATTERY (phone band/battery drain bhi ek cheating signal hai)
                    int[] bat = readBattery();
                    if (bat[0] >= 0) {
                        fields.put("batteryPct", new JSONObject().put("integerValue", String.valueOf(bat[0])));
                        fields.put("charging", new JSONObject().put("booleanValue", bat[1] == 1));
                    }
                    // INTEGRITY FLAGS (anti-cheat layer)
                    JSONArray arr = new JSONArray();
                    if (lastTeleportKmh > 0) arr.put(new JSONObject().put("stringValue", "gps_teleport"));
                    if (f != null && isMock(f)) arr.put(new JSONObject().put("stringValue", "mock_location"));
                    if (f != null && f.hasAccuracy() && f.getAccuracy() > 300f) {
                        arr.put(new JSONObject().put("stringValue", "gps_low_accuracy"));
                    }
                    fields.put("flags", new JSONObject().put("arrayValue",
                            new JSONObject().put("values", arr)));
                    fields.put("todayVisits", new JSONObject().put("integerValue", String.valueOf(todayVisits)));
                    fields.put("lastVisitAt", new JSONObject().put("integerValue", String.valueOf(lastVisitAt)));
                    fields.put("lastVisitCity", new JSONObject().put("stringValue",
                            lastVisitCity == null ? "" : lastVisitCity));
                    JSONObject body = new JSONObject().put("fields", fields);
                    String url = BASE + "sales_live/" + uid;
                    HttpResult r = http("POST", url, body.toString());
                    if (!r.ok) queueOp("live", url, body.toString());
                } catch (Exception ignore) {
                }
            });
        } catch (Exception ignore) {
        }
    }

    /** [batteryPct, charging] — sticky battery intent se (koi listener nahi). */
    private int[] readBattery() {
        int[] out = new int[]{-1, 0};
        try {
            android.os.BatteryManager bm = (android.os.BatteryManager) getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                int level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (level > 0 && level <= 100) out[0] = level;
            }
            Intent i = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i != null) {
                int plugged = i.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0);
                out[1] = plugged != 0 ? 1 : 0;
            }
        } catch (Exception ignore) {
        }
        return out;
    }

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
            disarmMotionSensor();
            cleanupBurst(); // GPS burst listener/timeout ka poora cleanup
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
