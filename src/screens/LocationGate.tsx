import { useEffect, useRef, useState } from 'react';
import { fetchLocation } from '../lib/reporting';
import { getShopCenter, distanceToShopM, noteGpsFix } from '../lib/geofence';

// ============================================================
// LOCATION GATE (Boss order 2026-10-26 + English screen 2026-10-26):
// "App open hote hi sab se pehle location puchna chahiye... jab location
//  access mile aur shop ke 100 mitter area me ho tabhi app open honi chahiye,
//  agar location on kare aur shop se door hai to app open hona hi nahi chahiye"
//
//  GATE SIRF STAFF (role 'worker') PE — Boss: "ye sirf staff mambers ke liye
//  rules hai, salesman ke liye alag rule banege" — sales + manager KAHIN SE
//  BHI open kar sakte hain (location tracking Home.tsx reportDeviceAndLocation
//  se chalti hi hai).
//
//  STAFF (worker):
//    1. App open -> TURANT navigator.geolocation permission prompt (sab se pehle)
//    2. Permission + GPS fix -> distance vs BOSS-LOCKED shop center (lib/geofence)
//    3. Inside radius (default 100m) -> app open + AUTO-DUTY-ON request
//       (localStorage flag — Home.tsx utha ke duty ON karta hai)
//    4. Outside radius -> LOCKED screen ENGLISH me (Boss: "screen showing honi
//       chahiye English me ke aap abhi shop par nahi hai is liye aap application
//       sirf shop me open kar sakte hai") — auto-retry har 20s:
//       shop wapas aate hi app KHUD khul jayegi
//    5. Permission denied / GPS off -> instructions + Retry button
// GPS ko net nahi chahiye — permission + GPS only.
// ============================================================

const AUTO_DUTY_FLAG = 'shivam_auto_duty_request';
export const requestAutoDutyOn = () => {
  try {
    window.localStorage.setItem(AUTO_DUTY_FLAG, String(Date.now()));
  } catch {
    // ignore
  }
};
export const consumeAutoDutyRequest = (): boolean => {
  try {
    const v = Number(window.localStorage.getItem(AUTO_DUTY_FLAG) || 0);
    if (v > 0 && Date.now() - v < 3 * 60 * 1000) {
      window.localStorage.removeItem(AUTO_DUTY_FLAG);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
};

type GateState =
  | { kind: 'checking' }              // permission prompt + GPS fix chal raha hai
  | { kind: 'denied' }                // permission reject hua
  | { kind: 'gps' }                   // GPS off / fix nahi mila
  | { kind: 'far'; distM: number }    // shop se door
  | { kind: 'gps-off-live' }          // app chalte-chalte location band kar diya (Boss order: warning popup)
  | { kind: 'pass' };                 // andar hai — app open

interface LocationGateProps {
  profile: { uid: string; role: string; name: string };
  children: (fix: { lat: number; lng: number }) => void;
}

export default function LocationGate({ profile, children }: LocationGateProps) {
  // GATE sirf staff ('worker') pe — sales ke alag rule banenge (Boss), manager
  // kahin se bhi open karta hai. Dono bypass.
  const gated = profile.role === 'worker';
  const [state, setState] = useState<GateState>(gated ? { kind: 'checking' } : { kind: 'pass' });
  const [radius, setRadius] = useState<number>(100);
  const retryTimer = useRef<number | null>(null);
  const mounted = useRef(true);
  const runCheckRef = useRef<() => void>(() => {});

  // LIVE MONITORING (Boss order 2026-10-26): app open hone ke BAAD bhi location
  // monitor rahe — pehle sirf start par check hota tha, isliye staff location
  // band karke ya bahar jaake app chala raha tha (koi popup nahi aata tha).
  const watchIdRef = useRef<number | null>(null);
  const lastFixAtRef = useRef<number>(0);
  const gpsOffTimerRef = useRef<number | null>(null);

  const stopWatch = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (gpsOffTimerRef.current) {
      window.clearTimeout(gpsOffTimerRef.current);
      gpsOffTimerRef.current = null;
    }
  };

  // Live GPS watch — fix mile to inside/outside decide, error pe (30s no-fix
  // guard se false-positive avoid) GPS-OFF warning popup. Location wapas on
  // hote hi watch khud recover karke popup hata dega.
  const startLiveWatch = (center: { lat: number; lng: number; radius: number }) => {
    if (!('geolocation' in navigator) || watchIdRef.current !== null) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (!mounted.current) return;
        lastFixAtRef.current = Date.now();
        if (gpsOffTimerRef.current) {
          window.clearTimeout(gpsOffTimerRef.current);
          gpsOffTimerRef.current = null;
        }
        const d = distanceToShopM(pos.coords.latitude, pos.coords.longitude, center);
        if (d <= center.radius) {
          setState((prev) => (prev.kind === 'pass' ? prev : { kind: 'pass' }));
          noteGpsFix(pos.coords.latitude, pos.coords.longitude, Date.now());
        } else {
          setState({ kind: 'far', distM: Math.round(d) });
        }
      },
      (err) => {
        if (!mounted.current) return;
        if (err.code === err.PERMISSION_DENIED) {
          setState({ kind: 'denied' });
          return;
        }
        // GPS band / signal gone — turant popup nahi: 30s no-fix guard
        // (shop ke andar GPS kabhi-kabhi late hota hai — false popup avoid)
        if (gpsOffTimerRef.current) return;
        gpsOffTimerRef.current = window.setTimeout(() => {
          if (!mounted.current) return;
          if (Date.now() - lastFixAtRef.current >= 30000) {
            setState({ kind: 'gps-off-live' });
          }
          gpsOffTimerRef.current = null;
        }, 30000);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 25000 }
    );
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      stopWatch();
    };
  }, []);

  // ---------- DETECTION LAYER 1 (BOSS BUG FIX 2026-10-26):
  // PERMISSIONS API instant watch — Android me location band karte hi geolocation
  // permission state 'denied' ho jata hai. Purane code me popup sirf watchPosition
  // ke ERROR callback par depend tha, lekin WebView me location off par error
  // AKSAR FIRE HI NAHI HOTI (watch silently stall) — isliye popup kabhi nahi aata
  // tha. Ab yahan TURANT pakda jata hai — 30s wait nahi.
  useEffect(() => {
    if (!gated || !('permissions' in navigator)) return;
    let cancelled = false;
    let ps: PermissionStatus | null = null;
    const onChange = () => {
      if (!mounted.current || !ps) return;
      if (ps.state === 'denied') {
        // Location band / permission hata — INSTANT warning popup
        lastFixAtRef.current = 0; // watchdog bhi turant armed rahe
        setState((prev) => (prev.kind === 'checking' ? prev : { kind: 'gps-off-live' }));
      } else if (ps.state === 'granted') {
        // Wapas allowed — fresh gate (popup khud hat jayega, watch recover)
        setState((prev) => (prev.kind === 'gps-off-live' || prev.kind === 'denied' ? { kind: 'checking' } : prev));
        runCheckRef.current();
      }
    };
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (cancelled) return;
        ps = s;
        s.onchange = onChange;
      })
      .catch(() => {
        // permissions API unavailable — watchdog layer kaafi hai
      });
    return () => {
      cancelled = true;
      if (ps) ps.onchange = null;
    };
  }, [gated]);

  // ---------- DETECTION LAYER 2 (BOSS BUG FIX): INDEPENDENT NO-FIX WATCHDOG —
  // watchPosition ka error callback arm karta tha, jo WebView stall me kabhi
  // nahi chalta tha. Ab ye interval KISI SE MATLAB NAHI — bas dekho: pichle
  // 30s me koi NAYA GPS fix aaya? Nahi aaya = location band = popup.
  useEffect(() => {
    if (!gated) return;
    const iv = window.setInterval(() => {
      if (!mounted.current) return;
      if (
        lastFixAtRef.current > 0 &&
        Date.now() - lastFixAtRef.current >= 30000
      ) {
        setState((prev) =>
          prev.kind === 'pass' || prev.kind === 'far' ? { kind: 'gps-off-live' } : prev
        );
      }
    }, 5000);
    return () => window.clearInterval(iv);
  }, [gated]);

  // ---------- BACKGROUND GRACE: app background me WebView timers + GPS updates
  // pause ho jate hain — wapas foreground aane par 30s ki fresh grace do (false
  // popup avoid), phir watchdog normal chal jayega.
  useEffect(() => {
    if (!gated) return;
    const onVis = () => {
      if (document.visibilityState === 'visible' && mounted.current) {
        lastFixAtRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [gated]);

  const runCheck = async () => {
    if (!mounted.current) return;
    setState({ kind: 'checking' });
    const center = await getShopCenter();
    if (!mounted.current) return;
    setRadius(center.radius);
    const loc = await fetchLocation();
    if (!mounted.current) return;
    if (!loc) {
      // GPS fix nahi mila — permission ya GPS band. Kaunsa hai wo alag karo:
      if ('permissions' in navigator) {
        try {
          const perm = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
          if (perm.state === 'denied') {
            setState({ kind: 'denied' });
            return;
          }
        } catch {
          // permissions API unavailable — GPS error hi dikhao
        }
      }
      setState({ kind: 'gps' });
      return;
    }
    noteGpsFix(loc.lat, loc.lng, loc.at); // is fix ko punches ke coords me bhi use karo
    lastFixAtRef.current = Date.now();
    const distM = distanceToShopM(loc.lat, loc.lng, center);
    if (distM <= center.radius) {
      setState({ kind: 'pass' });
      requestAutoDutyOn(); // 100m andar + access = auto duty ON (Home uthata hai)
      startLiveWatch(center); // BOSS RULE: app chalte-chalte bhi location monitor rahe
    } else {
      setState({ kind: 'far', distM: Math.round(distM) });
      startLiveWatch(center); // far me bhi watch — wapas aate hi khud pass hoga
    }
  };
  runCheckRef.current = runCheck;

  useEffect(() => {
    if (!gated) return; // sales/manager — koi gate nahi, kahin se bhi open
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated]);

  if (!gated || state.kind === 'pass') {
    return <>{children({ lat: 0, lng: 0 })}</>;
  }

  return (
    <div className="relative flex min-h-[86vh] items-center justify-center px-6 text-slate-100">
      <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-indigo-500/15" />
      <div className="glass-card relative z-10 w-full max-w-sm rounded-[26px] px-6 py-8 text-center">
        {state.kind === 'checking' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-sky-300/25 bg-sky-400/10">
              <svg className="h-8 w-8 animate-spin text-sky-300" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-white">Checking Location</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              Please allow location access — this app opens only inside the {radius}m shop area.
              GPS does not need internet.
            </p>
          </>
        )}

        {state.kind === 'denied' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-rose-300/25 bg-rose-400/10">
              <svg viewBox="0 0 24 24" className="h-8 w-8 text-rose-300" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z" />
                <line x1="4" y1="4" x2="20" y2="20" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-white">Location Permission Required</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              Location access is required to use this app. Please set the location permission to
              <b className="text-slate-200"> Allow</b> in your device/app settings, then tap Retry.
            </p>
            <button
              onClick={() => runCheck()}
              className="mt-5 w-full rounded-xl bg-gradient-to-r from-sky-400 to-indigo-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-sky-500/25 transition active:scale-95"
            >
              Retry Location Check
            </button>
          </>
        )}

        {state.kind === 'gps' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-amber-300/25 bg-amber-400/10">
              <svg viewBox="0 0 24 24" className="h-8 w-8 text-amber-300" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
                <circle cx="12" cy="12" r="8" opacity="0.35" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-white">No GPS Signal</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              Please turn <b className="text-slate-200">ON</b> your device Location (GPS mode: High accuracy),
              move to an open area, then tap Retry.
            </p>
            <button
              onClick={() => runCheck()}
              className="mt-5 w-full rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-amber-500/25 transition active:scale-95"
            >
              Retry GPS
            </button>
          </>
        )}

        {state.kind === 'gps-off-live' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-rose-300/25 bg-rose-400/10">
              <svg viewBox="0 0 24 24" className="h-8 w-8 text-rose-300" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-white">Location Turned Off</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed font-semibold text-slate-200">
              Turning off location can lower your credit points.
            </p>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-slate-400">
              Your device location is switched off while the app is running. Please turn
              location back <b className="text-slate-200">ON</b> (GPS mode: High accuracy) —
              the app will continue automatically as soon as your location is available again.
            </p>
            <div className="glass-inset mt-4 rounded-xl px-4 py-2.5 text-[10.5px] font-semibold text-amber-300/90">
              This app monitors location the whole time you are working.
            </div>
          </>
        )}

        {state.kind === 'far' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-rose-300/25 bg-rose-400/10">
              <svg viewBox="0 0 24 24" className="h-8 w-8 text-rose-300" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
            </div>
            <h2 className="text-[17px] font-bold text-white">App Locked</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed font-semibold text-slate-200">
              You are not at the shop right now, so you can only open this application at the shop.
            </p>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-slate-400">
              You are <b className="text-rose-300">{state.distM}m</b> away from the shop.
              This application works only inside the <b className="text-slate-200">{radius}m</b> shop area.
            </p>
            <div className="glass-inset mt-4 rounded-xl px-4 py-2.5 text-[10.5px] font-semibold text-slate-400">
              Shop: Shivam Store, Pushpak Plaza, Mangnath Rd, Junagadh
            </div>
          </>
        )}
      </div>
    </div>
  );
}
