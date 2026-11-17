package com.shivam.staff;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoTdscdma;
import android.telephony.CellInfoWcdma;
import android.telephony.CellLocation;
import android.telephony.CellSignalStrength;
import android.telephony.GsmCellLocation;
import android.telephony.TelephonyManager;

import org.json.JSONObject;

import java.util.List;

/**
 * ============================================================
 * CELL TOWER WATCHER (Boss order 2026-11-17 — "Rail jaise system —
 * jaise wher is my rail ke apps me internet band ho location band ho
 * tab bhi tower id se pata chalta hai train kaha pohchi hai"):
 *
 * Sales TOUR mode me GPS chip BAND rehta hai (battery bachat). Phone
 * jo tower se connected hai wo CID/LAC/BAND se milta hai — ye read
 * RADIO se hota hai, na GPS chip chahiye na internet. Har fix/ping
 * par ye utility TOWER KA FINGERPRINT uthati hai:
 *
 *   key = "{mcc}-{mnc}-{lac}-{cid}"
 *
 *   - mcc  = 404 (India), mnc = operator circle (45=Airtel Gujarat...)
 *   - lac  = Location Area Code, cid = Cell ID (tower ka identity)
 *   - dbm  = signal strength (tower kitna paas hai)
 *
 * Ye key LocationTrackService me CellDbCache se map hoti hai
 * (lat/lng/city) — jo DB khud GPS fixes se SELF-LEARNING karta hai:
 * jis-jis tower se sales gaya, wo tower DB me city ke saath recorded
 * ho gaya. agli baar INTERNET BAND ho to bhi usi tower key se city
 * dikh jayegi (Where-is-my-train ka exact pattern).
 *
 * PERMISSION: Android 10+ pe getAllCellInfo() ko ACCESS_FINE_LOCATION
 * chahiye — gate pass ke baad permission already granted hoti hai.
 * getNetworkOperator() (mcc/mnc) ko koi permission nahi chahiye.
 *
 * HAR JAGAH try/catch — tracking service business-critical hai, tower
 * read kabhi crash nahi kar sakta (Boss: "galati ki koi gunjaish nahi").
 * ============================================================
 */
public final class CellTowerWatcher {

    private CellTowerWatcher() {
        // static utility — koi instance nahi
    }

    /** Ek tower ka resolved snapshot. Fields sirf jab available (optional). */
    public static final class TowerSnapshot {
        public boolean ok = false;      // cell read hua ya nahi (airplane/no sim)
        public String key = "";         // mcc-mnc-lac-cid (DB lookup key)
        public String mcc = "";
        public String mnc = "";
        public long lac = -1;
        public long cid = -1;
        public int dbm = 0;             // signal (0 = unknown)
        public boolean registered = false; // current serving tower

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", ok);
                if (!key.isEmpty()) o.put("key", key);
                if (!mcc.isEmpty()) o.put("mcc", mcc);
                if (!mnc.isEmpty()) o.put("mnc", mnc);
                if (lac >= 0) o.put("lac", lac);
                if (cid >= 0) o.put("cid", cid);
                if (dbm != 0) o.put("dbm", dbm);
            } catch (Exception ignore) {
            }
            return o;
        }
    }

    /**
     * CURRENT tower read — har fix/ping par call hota hai (zero extra
     * battery: radio se passively padha jata hai, koi scan nahi hota).
     */
    @SuppressLint("MissingPermission")
    public static TowerSnapshot read(Context ctx) {
        TowerSnapshot s = new TowerSnapshot();
        try {
            TelephonyManager tm = (TelephonyManager) ctx.getApplicationContext()
                    .getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return s;

            // ---- 1) MCC/MNC (operator) — permission-independent ----
            String op = tm.getNetworkOperator();
            if (op != null && op.length() >= 5) {
                s.mcc = op.substring(0, 3);
                s.mnc = op.substring(3);
                s.ok = true;
            }

            // ---- 2) Registered tower identity — getAllCellInfo (API 17+) ----
            try {
                List<CellInfo> infos = tm.getAllCellInfo();
                if (infos != null) {
                    for (CellInfo ci : infos) {
                        if (ci == null || !ci.isRegistered()) continue;
                        fillIdentity(s, ci);
                        if (s.cid >= 0) break; // serving tower mil gaya
                    }
                }
            } catch (Exception ignore) {
                // kuch OEM ROMs null/throw karte hain — fallback neeche
            }

            // ---- 3) FALLBACK: getCellLocation (deprecated par kaam karta hai) ----
            if (s.cid < 0) {
                try {
                    CellLocation cl = tm.getCellLocation();
                    if (cl instanceof GsmCellLocation) {
                        GsmCellLocation g = (GsmCellLocation) cl;
                        int lac = g.getLac();
                        int cid = g.getCid();
                        if (lac >= 0 && cid > 0) {
                            s.lac = lac;
                            s.cid = cid & 0xFFFF; // 16-bit GSM cid
                            s.ok = true;
                        }
                    }
                } catch (Exception ignore) {
                }
            }

            // ---- 4) Key build (DB ka primary lookup key) ----
            if (s.cid >= 0 && s.ok) {
                s.key = s.mcc + "-" + s.mnc + "-" + s.lac + "-" + s.cid;
            } else if (s.ok) {
                // sirf operator mila (tower identity nahi) — kamzor key
                s.key = s.mcc + "-" + s.mnc + "-0-0";
            }
        } catch (Exception ignore) {
            s.ok = false;
        }
        return s;
    }

    /** Registered CellInfo se identity+signal nikalta hai (GSM/LTE/WCDMA/NR). */
    private static void fillIdentity(TowerSnapshot s, CellInfo ci) {
        try {
            try {
                CellSignalStrength ss = ci.getCellSignalStrength();
                if (ss != null) s.dbm = ss.getDbm();
            } catch (Exception ignore) {
            }
            if (ci instanceof CellInfoGsm) {
                CellInfoGsm g = (CellInfoGsm) ci;
                if (g.getCellIdentity() == null) return;
                s.lac = safe(g.getCellIdentity().getLac());
                s.cid = safe(g.getCellIdentity().getCid());
                // getMccString API 28+ hai — API 23-27 par NoSuchMethodError
                // (Error = catch Exception me nahi pakda jata = CRASH). India ke
                // Android 6/7 devices pe yahi bachata hai. operator fallback
                // getNetworkOperator() se already aa chuka hai.
                if (Build.VERSION.SDK_INT >= 28) {
                    fillMccMnc(s, g.getCellIdentity().getMccString(), g.getCellIdentity().getMncString());
                }
                s.registered = true;
            } else if (ci instanceof CellInfoLte) {
                CellInfoLte l = (CellInfoLte) ci;
                if (l.getCellIdentity() == null) return;
                s.lac = safe(l.getCellIdentity().getTac()); // LTE: TAC = LAC equivalent
                s.cid = safe(l.getCellIdentity().getCi());
                if (Build.VERSION.SDK_INT >= 28) {
                    fillMccMnc(s, l.getCellIdentity().getMccString(), l.getCellIdentity().getMncString());
                }
                s.registered = true;
            } else if (ci instanceof CellInfoWcdma) {
                CellInfoWcdma w = (CellInfoWcdma) ci;
                if (w.getCellIdentity() == null) return;
                s.lac = safe(w.getCellIdentity().getLac());
                s.cid = safe(w.getCellIdentity().getCid());
                if (Build.VERSION.SDK_INT >= 28) {
                    fillMccMnc(s, w.getCellIdentity().getMccString(), w.getCellIdentity().getMncString());
                }
                s.registered = true;
            } else if (ci instanceof CellInfoTdscdma) {
                // CellInfoTdscdma/CellInfoNr API 28/29+ classes — purane device
                // par instanceof soft-fail (false) hota hai ART me, methods kabhi
                // enter nahi hote — koi crash nahi
                CellInfoTdscdma t = (CellInfoTdscdma) ci;
                if (t.getCellIdentity() == null) return;
                s.lac = safe(t.getCellIdentity().getLac());
                s.cid = safe(t.getCellIdentity().getCid());
                if (Build.VERSION.SDK_INT >= 28) {
                    fillMccMnc(s, t.getCellIdentity().getMccString(), t.getCellIdentity().getMncString());
                }
                s.registered = true;
            } else if (ci instanceof CellInfoNr) {
                // NR (5G): identity API-level heavy — sirf signal rakho,
                // key WCDMA/LTE/GSM fallback se aayegi
                s.registered = true;
            }
        } catch (Exception ignore) {
        }
    }

    private static void fillMccMnc(TowerSnapshot s, String mcc, String mnc) {
        try {
            if (s.mcc == null || s.mcc.isEmpty()) {
                if (mcc != null && mcc.length() > 0) s.mcc = mcc;
                if (mnc != null && mnc.length() > 0) s.mnc = mnc;
            }
        } catch (Exception ignore) {
        }
    }

    private static long safe(int v) {
        // LAC/CID "unknown" values (-1, MAX_INT) ko normalize karo
        if (v < 0 || v == Integer.MAX_VALUE) return -1;
        return v;
    }
}
