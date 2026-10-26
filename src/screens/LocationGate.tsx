import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { fetchLocation } from '../lib/reporting';
import { getShopCenter, distanceToShopM, noteGpsFix } from '../lib/geofence';
import { LocationGuard } from '../lib/locationGuard';
import { diagLog } from '../lib/diag';
import { openLocationSession, closeLocationSession, appendTrackPoint } from '../lib/locTrack';

// ============================================================
// LOCATION GATE (Boss order 2026-10-26 + English screen 2026-10-26):
// "App open hote hi sab se pehle location puchna chahiye... jab location
//  access mile aur shop ke 100 mitter area me ho tabhi app open honi chahiye,
//  agar location on kare aur shop se door hai to app open hona hi nahi chahiye"
//
//  SALES RULE (Boss order 2026-10-26): "salesmen kahi se bhi application khol
//  sakte hai magar unko location har haal me dena hi hoga — bina location
//  application open hi nahi ho sakta"
//
//  WORKER (staff):
//    1. App open -> TURANT navigator.geolocation permission prompt (sab se pehle)
//    2. Permission + GPS fix -> distance vs BOSS-LOCKED shop center (lib/geofence)
//    3. Inside radius (default 100m) -> app open + AUTO-DUTY-ON request
//       (localStorage flag — Home.tsx utha ke duty ON karta hai)
//    4. Outside radius -> LOCKED screen ENGLISH me — auto-retry har 20s:
//       shop wapas aate hi app KHUD khul jayegi
//    5. Permission denied / GPS off -> instructions + Retry button
//
//  SALES: shop radius check NAHI (kahin se bhi) — par location permission +
//  GPS fix ZARURI (fix ke bina app open NAHI). Live monitoring bhi sales pe
//  chalti hai — app chalte-chalte location band = 'Location Turned Off' lock
//  (location wapas ON = app khud recover).
//
//  MANAGER: bypass — kahin se bhi open.
//
//  SLOW-NET + NO-CACHE RULE (Boss order 2026-10-26: "net slowly chal raha ho
//  tab bhi open hona chahiye, magar bina location on nahi hona chahiye, koi
//  bhi cache local me save mat karna"):
//    - Gate ka FAISLA 100% LOCAL hai: GPS fix (maximumAge:0, cached fix
//      KABHI nahi) + native location-service state. KOI network call gate
//      ko block nahi karti (shop center LOCKED coords se turant milta hai).
//    - KOI gate/permission state localStorage me save nahi hoti — har open
//      par FRESH check (state memory me hai, cold start = naya check).
//    - Net slow ho to bhi gate waise hi chalta hai — GPS ko net nahi chahiye.
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

// SALES AUTO DUTY OFF (Boss order 2026-10-26: "salesmen ka duty location par
// hi chalega — button nahi"): location OFF hote hi ye flag — Home consume
// karke auto 'out' punch karta hai (same toggleDuty sync-guarantee path).
const AUTO_DUTY_OFF_FLAG = 'shivam_auto_duty_off_request';
export const requestAutoDutyOff = () => {
  try {
    window.localStorage.setItem(AUTO_DUTY_OFF_FLAG, String(Date.now()));
  } catch {
    // ignore
  }
};
export const consumeAutoDutyOffRequest = (): boolean => {
  try {
    const v = Number(window.localStorage.getItem(AUTO_DUTY_OFF_FLAG) || 0);
    if (v > 0 && Date.now() - v < 3 * 60 * 1000) {
      window.localStorage.removeItem(AUTO_DUTY_OFF_FLAG);
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
  // GATE (Boss order 2026-10-26): worker = location + shop radius; sales =
  // location ONLY (kahin bhi — par location ke bina app open NAHI); manager bypass.
  const isWorker = profile.role === 'worker';
  const isSales = profile.role === 'sales';
  const gated = isWorker || isSales;
  // LIVE ROLE CHANGE (Task 56): role live badal sakta hai — closures (watch/
  // runCheck) fresh value ref se padhte hain, render-time value nahi.
  const radiusCheckRef = useRef(isWorker);
  radiusCheckRef.current = isWorker;
  const [state, setState] = useState<GateState>(gated ? { kind: 'checking' } : { kind: 'pass' });
  const [radius, setRadius] = useState<number>(100);
  const radiusRef = useRef<number>(100);
  radiusRef.current = radius;
  const retryTimer = useRef<number | null>(null);
  const trackTimerRef = useRef<number | null>(null); // sales road-map sampler
  const mounted = useRef(true);
  const runCheckRef = useRef<() => void>(() => {});
  // SESSION OPEN location — gate pass wala fresh fix (runCheck ne noteGpsFix
  // kiya hota hai) — kind-effect ise padhta hai (state closure stale na ho)
  const lastGpsFixRef = useRef<{ lat: number; lng: number } | null>(null);
  // PROBE LAYER (Boss bug 2026-10-26: "location band karne par bhi app continue
  // rehti hai"): current state/center refs — interval closures fresh padhte hain
  const stateKindRef = useRef<GateState['kind']>(state.kind);
  stateKindRef.current = state.kind;
  const centerRef = useRef<{ lat: number; lng: number; radius: number } | null>(null);
  const probeInFlightRef = useRef(false);
  const probeErrStreakRef = useRef(0);

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

  // ---------- DETECTION LAYER 0 (Boss order 2026-10-26: "location off karne
  // par app INSTANT band ho jaye — timing ka problem hai"): NATIVE SYSTEM
  // BROADCAST — Android LocationManager PROVIDERS_CHANGED/MODE_CHANGED quick
  // settings se location OFF/ON hote hi MILLISECONDS me fire hota hai
  // (LocationGuardPlugin sunta hai). enabled=false -> TURANT lock (probe/
  // watchdog ka 20-60s wait khatam); enabled=true -> full re-gate recovery.
  // Probe/watchdog layers iske BACKUP hain (web dev / broadcast miss case).
  useEffect(() => {
    if (!gated || !Capacitor.isNativePlatform()) return;
    let alive = true;
    let handle: import('@capacitor/core').PluginListenerHandle | null = null;
    LocationGuard.addListener('locationStateChanged', (d) => {
      if (!alive || !mounted.current) return;
      const enabled = !!d?.enabled;
      const k = stateKindRef.current;
      if (!enabled) {
        // INSTANT LOCK — system ne confirm kiya location band hai
        lastFixAtRef.current = 0;
        setState((prev) => (prev.kind === 'pass' || prev.kind === 'far' ? { kind: 'gps-off-live' } : prev));
      } else {
        // location wapas ON — full re-gate (gps-off-live/gps/far) ya probe (pass)
        if (k === 'gps-off-live' || k === 'gps' || k === 'far') {
          window.setTimeout(() => {
            if (!mounted.current) return;
            stopWatch();
            runCheckRef.current();
          }, 400);
        } else if (k === 'pass') {
          window.setTimeout(() => {
            if (mounted.current) runProbe();
          }, 400);
        }
      }
    }).then((h) => {
      if (!alive) {
        h.remove().catch(() => {});
        return;
      }
      handle = h;
    });
    LocationGuard.start().catch(() => {});
    // start-time safety: app background me toggle hua ho to bhi turant sahi state
    LocationGuard.isEnabled()
      .then((r) => {
        if (!alive || !mounted.current || !r || r.enabled) return;
        lastFixAtRef.current = 0;
        setState((prev) => (prev.kind === 'pass' || prev.kind === 'far' ? { kind: 'gps-off-live' } : prev));
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (handle) handle.remove().catch(() => {});
      LocationGuard.stop().catch(() => {});
    };
  }, [gated]);

  // ---------- DETECTION LAYER 3 (Boss bug 2026-10-26: "location band karne par
  // app band nahi hoti, continue rehti hai"): INDEPENDENT FRESH-FIX PROBE —
  // har 10s ek getCurrentPosition maximumAge:0 (cached fix KABHI nahi, sirf
  // FRESH fix). Location service band hote hi ye reliably error deta hai
  // (watchPosition ki tarah silent stall NAHI karta) — 2 lagatar fail = LOCK.
  // Native broadcast (layer 0) instant lock deta hai — ye backup hai. Wapas
  // location ON = fresh fix milte hi app KHUD recover (gps/gps-off-live dono se).
  // Ye layer KISI aur layer par depend nahi karti.
  const runProbe = async () => {
    if (!mounted.current || probeInFlightRef.current) return;
    if (!('geolocation' in navigator)) return;
    const kind = stateKindRef.current;
    if (kind === 'denied' || kind === 'far' || kind === 'checking') return;
    probeInFlightRef.current = true;
    try {
      const pos: any = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          resolve,
          (e) => resolve({ __err: e }),
          { timeout: 15000, enableHighAccuracy: true, maximumAge: 0 }
        );
      });
      if (!mounted.current) return;
      probeInFlightRef.current = false;
      if (pos && pos.__err) {
        const code = Number(pos.__err.code);
        if (code === 1) {
          // PERMISSION_DENIED — permission mid-session revoke hui
          probeErrStreakRef.current = 0;
          lastFixAtRef.current = 0;
          setState((prev) => (prev.kind === 'denied' ? prev : { kind: 'denied' }));
          return;
        }
        if (code === 2) {
          // POSITION_UNAVAILABLE = location service BAND — reliable signal,
          // 2 lagatar (40s me) = LOCK. Timeout (code 3) = sirf weak GPS signal
          // (indoor) — wo lock NAHI karta, usse watchdog (30s no-fresh-fix) sambhalta hai.
          probeErrStreakRef.current += 1;
          if (probeErrStreakRef.current >= 2) {
            lastFixAtRef.current = 0;
            setState((prev) => (prev.kind === 'gps-off-live' ? prev : { kind: 'gps-off-live' }));
          }
          return;
        }
        // code 3 (TIMEOUT) — weak GPS signal, location chal rahi ho sakti hai
        probeErrStreakRef.current = 0;
        return;
      }
      // FRESH fix mila — location CHAL rahi hai
      probeErrStreakRef.current = 0;
      if (pos && pos.coords) {
        const fixAge = Date.now() - (typeof pos.timestamp === 'number' ? pos.timestamp : Date.now());
        if (fixAge < 60000) lastFixAtRef.current = Date.now();
        noteGpsFix(pos.coords.latitude, pos.coords.longitude, Date.now());
        const k = stateKindRef.current;
        const center = centerRef.current;
        // RADIUS LIVE-SYNC: config radius background me load ho jaye to gate
        // ka UI bhi turant update (center object wahi mutated reference hai)
        if (center && center.radius !== radiusRef.current) setRadius(center.radius);
        if (k === 'gps-off-live' || k === 'gps') {
          // RECOVER: location wapas ON — watch fresh start + full gate re-run
          stopWatch();
          runCheckRef.current();
          return;
        }
        if (center && radiusCheckRef.current) {
          // worker radius live re-eval (watch stall ho to bhi radius enforce rahe)
          const d = distanceToShopM(pos.coords.latitude, pos.coords.longitude, center);
          if (k === 'pass' && d > center.radius) {
            setState({ kind: 'far', distM: Math.round(d) });
          } else if (k === 'far' && d <= center.radius) {
            setState({ kind: 'pass' });
          }
        }
      }
    } catch {
      probeInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!gated) return;
    const iv = window.setInterval(() => {
      if (!mounted.current) return;
      runProbe();
    }, 10000);
    return () => window.clearInterval(iv);
  }, [gated]);

  // Live GPS watch — fix mile to inside/outside decide, error pe (30s no-fix
  // guard se false-positive avoid) GPS-OFF warning popup. Location wapas on
  // hote hi watch khud recover karke popup hata dega.
  const startLiveWatch = (center: { lat: number; lng: number; radius: number }) => {
    if (!('geolocation' in navigator) || watchIdRef.current !== null) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (!mounted.current) return;
        // FIX FRESHNESS (probe layer ke saath): Android WebView kabhi-kabhi
        // location band hone ke baad bhi PURANA fix repeat karta rehta hai —
        // sirf callback arrival par lastFixAt update karna watchdog ko hamesha
        // reset kar deta tha (isliye app lock nahi hoti thi). Ab sirf FRESH
        // fix (60s ke andar ka) count hota hai — stale fix ignore.
        const fixAge = Date.now() - (typeof pos.timestamp === 'number' ? pos.timestamp : Date.now());
        if (fixAge >= 60000) return; // stale fix — watchdog ise nahi ginega
        lastFixAtRef.current = Date.now();
        if (gpsOffTimerRef.current) {
          window.clearTimeout(gpsOffTimerRef.current);
          gpsOffTimerRef.current = null;
        }
        noteGpsFix(pos.coords.latitude, pos.coords.longitude, Date.now());
        // SALES: radius check nahi — koi bhi fix = pass (kahin bhi ho sakta hai)
        if (!radiusCheckRef.current) {
          setState((prev) => (prev.kind === 'pass' ? prev : { kind: 'pass' }));
          return;
        }
        const d = distanceToShopM(pos.coords.latitude, pos.coords.longitude, center);
        if (d <= center.radius) {
          setState((prev) => (prev.kind === 'pass' ? prev : { kind: 'pass' }));
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
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 } // maximumAge:0 — NO-CACHE (Boss rule): sirf fresh fixes
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
  // popup avoid), phir watchdog normal chal jayega. SAATH HI turant fresh-fix
  // PROBE bhi — location band karke wapas aaye to wait nahi, jaldi pakda jata hai.
  useEffect(() => {
    if (!gated) return;
    const onVis = () => {
      if (document.visibilityState === 'visible' && mounted.current) {
        lastFixAtRef.current = Date.now();
        window.setTimeout(() => {
          if (mounted.current) runProbe();
        }, 300);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [gated]);

  // ---------- SALES LOCATION DUTY TRACKING (Boss order 2026-10-26: "salesmen
  // ka duty location par hi chale — button nahi; kaha ON kiya, kaha OFF,
  // poora road map dashboard me"): gate state machine par sessions chalti hai —
  //   pass        -> loc_session OPEN + auto-duty-ON request (Home punch karta hai)
  //                  + road-map sampler (har 3 min FRESH fix -> points[])
  //   off/denied  -> loc_session CLOSE (last point = OFF location) + auto-duty-OFF
  //                  request + loc_event 'off'
  // SALES ONLY (worker ka apna geofence system hai, manager bypass).
  useEffect(() => {
    if (!gated || !isSales) return;
    const kind = state.kind;
    if (kind === 'pass') {
      // SESSION OPEN/RESUME — lastGpsFix (fresh gate fix) = ON location
      openLocationSession(profile.uid, profile.name, (() => {
        const f = lastGpsFixRef.current;
        return f ? { lat: f.lat, lng: f.lng } : null;
      })()).catch(() => {});
      requestAutoDutyOn(); // location ON = duty ON (button nahi — auto)
      // ROAD-MAP SAMPLER — har 3 min FRESH fix -> session points[]
      if (trackTimerRef.current === null) {
        appendTrackPoint(profile.uid).catch(() => {}); // pehla point jaldi
        trackTimerRef.current = window.setInterval(() => {
          if (!mounted.current) return;
          appendTrackPoint(profile.uid).catch(() => {});
        }, 3 * 60 * 1000);
      }
    } else if (kind === 'gps-off-live' || kind === 'denied') {
      // SESSION CLOSE — location OFF / permission revoke = duty khatam
      closeLocationSession(profile.uid, profile.name, kind === 'denied' ? 'permission' : 'loc_off').catch(() => {});
      requestAutoDutyOff(); // location OFF = duty OFF (Home auto 'out' punch)
      if (trackTimerRef.current !== null) {
        window.clearInterval(trackTimerRef.current);
        trackTimerRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, isSales, state.kind]);

  // sampler cleanup
  useEffect(() => {
    return () => {
      if (trackTimerRef.current !== null) window.clearInterval(trackTimerRef.current);
    };
  }, []);

  const runCheck = async () => {
    if (!mounted.current) return;
    setState({ kind: 'checking' });
    const center = await getShopCenter();
    if (!mounted.current) return;
    centerRef.current = center;
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
    lastGpsFixRef.current = { lat: loc.lat, lng: loc.lng }; // sales session ON location
    // SALES GATE (Boss order 2026-10-26): salesman KAHIN SE BHI app khol sakta
    // hai — shop radius check NAHI — par location access + GPS fix ZARURI.
    if (!radiusCheckRef.current) {
      setState({ kind: 'pass' });
      diagLog('gate_pass', { mode: 'sales' }); // NO-CACHE proof: ye event sirf FRESH fix ke baad aata hai
      startLiveWatch(center); // live monitoring sales pe bhi — location band = lock
      return;
    }
    const distM = distanceToShopM(loc.lat, loc.lng, center);
    if (distM <= center.radius) {
      setState({ kind: 'pass' });
      diagLog('gate_pass', { mode: 'radius', distM: Math.round(distM) });
      requestAutoDutyOn(); // 100m andar + access = auto duty ON (Home uthata hai)
      startLiveWatch(center); // BOSS RULE: app chalte-chalte bhi location monitor rahe
    } else {
      setState({ kind: 'far', distM: Math.round(distM) });
      startLiveWatch(center); // far me bhi watch — wapas aate hi khud pass hoga
    }
  };
  runCheckRef.current = runCheck;

  useEffect(() => {
    if (!gated) return; // manager — koi gate nahi, kahin se bhi open
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, isWorker]); // isWorker: live role change (worker<->sales) par fresh check

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
              {isWorker
                ? `Please allow location access — this app opens only inside the ${radius}m shop area. GPS does not need internet.`
                : 'Please allow location access — this app needs your location to open. GPS does not need internet.'}
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
              {isWorker
                ? 'Turning off location can lower your credit points.'
                : 'Location is required to keep this app open.'}
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
