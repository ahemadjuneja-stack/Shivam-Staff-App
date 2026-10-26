import { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { auth, db } from './firebase';
import { PROFILE_KEY, readStoredCredentials, syncCredentialsFromDoc, clearSession, storeProfile, ensureSessionRestored } from './lib/session';
import { resolveUserDocByPhone } from './lib/userResolve';
import { diagInitVersion, diagSetIdentity, diagLog } from './lib/diag';
import { fetchAppVersionInfo } from './lib/reporting';
import { LocationGuard } from './lib/locationGuard';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import LocationGate from './screens/LocationGate';
import UpdatePopup from './components/UpdatePopup';
import IntroScreen from './components/IntroScreen';
import BrandHeader from './components/BrandHeader';

// status EXPLICITLY non-active (pending/deleted/rejected/inactive...) = admin
// ne band kiya -> real logout. Missing/undefined status = doc anomaly —
// session RAKHO (kisi doc-format surprise se galti ka logout kabhi nahi).
const isExplicitInactive = (s: unknown): boolean =>
  typeof s === 'string' && s.length > 0 && s !== 'active';

// Profile builder — users doc se UserProfile (role-mapping ek hi jagah).
// Task 59-b adoption paths bhi isi se profile banate hain.
const buildProfileFromDoc = (docId: string, d: any): UserProfile => ({
  uid: docId,
  name: d?.name || 'Staff',
  mobile: d?.phone || d?.mobile || '',
  city: d?.city || 'Main',
  role: (d?.role === 'sales' || d?.role === 'salesman' || d?.role === 'sales_manager') ? 'sales' : (d?.role === 'manager' || d?.role === 'admin') ? 'manager' : 'worker',
  status: 'active',
  photo: typeof d?.photo === 'string' && d.photo ? d.photo : undefined,
  createdAt: typeof d?.createdAt === 'number' ? d.createdAt : (typeof d?.createdAt === 'string' ? new Date(d.createdAt).getTime() : Date.now())
});

// SILENT RE-LOGIN RETRY (never-logout layer 3): cold start par data
// connection aksar late hota hai — pehli koshish network fail ho to 4s/12s/30s
// par dobara. invalid-credential (PIN change) par retry bekaar hai.
const SILENT_RELOGIN_DELAYS = [4000, 12000, 30000];
const trySilentReLogin = (attempt: number) => {
  const creds = readStoredCredentials();
  if (!creds) {
    diagLog('silent_skip', { reason: 'no-creds' });
    return;
  }
  signInWithEmailAndPassword(auth, creds.email, creds.password)
    .then(() => {
      diagLog('silent_ok', { attempt });
    })
    .catch((err: any) => {
      const code = String(err?.code || 'unknown');
      diagLog('silent_fail', { code, attempt });
      const networkFail = code.includes('network') || code.includes('timeout');
      if (networkFail && attempt <= SILENT_RELOGIN_DELAYS.length) {
        window.setTimeout(() => trySilentReLogin(attempt + 1), SILENT_RELOGIN_DELAYS[attempt - 1]);
      }
    });
};

export default function App() {
  const [introDone, setIntroDone] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  // BOOT FAST (Boss order 2026-10-25: "smoothly chalna chahiye"):
  // cached profile localStorage me hai to spinner SKIP — Home turant render,
  // onAuthStateChanged background me revalidate karega. NEVER-LOGOUT (Boss rule
  // 2026-10-26: "ek baar login -> kabhi logout nahi"): session restore fail ho
  // to cached profile RAKH kar silent re-login hota hai — login screen sirf
  // explicit logout / admin-delete par aati hai. Firestore listeners bhi
  // persistent cache se turant data denge (firebase.ts dekho).
  const [loading, setLoading] = useState<boolean>(() => {
    try {
      return !localStorage.getItem(PROFILE_KEY);
    } catch {
      return true;
    }
  });
  const [watchUid, setWatchUid] = useState<string | null>(null);

  // SLOW-NET OPEN FALLBACK (Boss order 2026-10-26: "net slowly chal raha ho
  // tab bhi open hona chahiye"): cached profile na ho aur network bahut slow
  // ho to spinner KABHI-KA nahi banta — 10s baad login screen dikhti hai
  // (interactive, retry possible) instead of infinite "Loading". Normal case
  // (cached profile) me ye effect chalta hi nahi — loading pehle hi false.
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => {
      diagLog('loading_fallback');
      setLoading(false);
    }, 10000);
    return () => window.clearTimeout(t);
  }, [loading]);

  // BOOT RESTORE (never-logout layer 2): WebView storage wipe hone par native
  // SessionVault (SharedPreferences) se cached profile + creds wapas aate
  // hain — pehle render se hi. onAuthStateChanged iske BAAD hi register hota
  // hai taaki wipe case me login screen kabhi flash na ho.
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    diagInitVersion().finally(() => {});
    // diag identity: stored creds ka phone (login se pehle bhi log doc me jaye)
    try {
      const c = readStoredCredentials();
      if (c?.email) diagSetIdentity(c.email.split('@')[0]);
    } catch {
      /* ignore */
    }
    ensureSessionRestored()
      .then((snap) => {
        diagLog('boot', {
          lp: snap.hadLocalProfile,
          lc: snap.hadLocalCreds,
          vp: snap.hadVaultProfile,
          vc: snap.hadVaultCreds,
          restored: snap.restoredFromVault,
          backfill: snap.backfilledToVault
        });
      })
      .catch(() => {
        diagLog('boot_err');
      })
      .finally(() => {
      if (!alive) return;
      try {
        const saved = localStorage.getItem(PROFILE_KEY);
        if (saved) {
          const p = JSON.parse(saved);
          if (p && typeof p === 'object') {
            setProfile(p);
            setLoading(false);
          }
        }
      } catch {
        /* corrupt cache — auth flow decide karega */
      }
      setBooted(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!booted) return;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setWatchUid(firebaseUser.uid);
        try {
          const userDocRef = doc(db, 'users', firebaseUser.uid);
          const userDocSnap = await getDoc(userDocRef);

          if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            // active ya status-missing — dono me app chalta rahega;
            // sirf EXPLICIT non-active status (pending/deleted/rejected) = logout
            if (!isExplicitInactive(data.status)) {
              syncCredentialsFromDoc(data);
              const p: UserProfile = {
                uid: firebaseUser.uid,
                name: data.name || 'Staff',
                mobile: data.phone || data.mobile || '',
                city: data.city || 'Main',
                role: (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : (data.role === 'manager' || data.role === 'admin') ? 'manager' : 'worker',
                status: 'active',
                photo: typeof data.photo === 'string' && data.photo ? data.photo : undefined,
                createdAt: typeof data.createdAt === 'number' ? data.createdAt : (typeof data.createdAt === 'string' ? new Date(data.createdAt).getTime() : Date.now())
              };
              setProfile(p);
              storeProfile(p);
              diagSetIdentity(p.mobile);
              diagLog('doc_ok', { status: String(data.status || 'missing'), role: String(data.role || 'missing') });
            } else {
              // DUPLICATE-ACCOUNT ADOPTION (Task 59-b — Boss phone 9898904578):
              // auth-uid doc inactive hai, par same phone ka ACTIVE doc ho sakta
              // hai (re-registration duplicate case — standard email duplicate
              // ke Auth account ke paas hai). Active doc mila to USSE adopt karo
              // (logout NAHI — watcher bhi usi doc ko watch karega), warna real
              // admin deactivate = REAL logout.
              const email = firebaseUser.email || '';
              const resolved = await resolveUserDocByPhone(email.split('@')[0]);
              if (resolved && !isExplicitInactive(resolved.data?.status)) {
                syncCredentialsFromDoc(resolved.data);
                const p = buildProfileFromDoc(resolved.id, resolved.data);
                setWatchUid(resolved.id);
                setProfile(p);
                storeProfile(p);
                diagSetIdentity(p.mobile);
                diagLog('uid_mismatch_adopted', { authStatus: String(data.status), role: String(resolved.data?.role || 'missing') });
              } else {
                // admin ne deactivate/delete kiya — REAL logout (profile + creds clear)
                diagLog('deactivate_logout', { status: String(data.status) });
                clearSession();
                setProfile(null);
              }
            }
          } else {
            const email = firebaseUser.email || '';
            const phoneFromEmail = email.split('@')[0];
            if (phoneFromEmail) {
              // phone-fallback bhi ACTIVE-doc resolver se (blind docs[0] nahi —
              // duplicate hone par galat doc uth sakta tha)
              const resolved = await resolveUserDocByPhone(phoneFromEmail);
              if (resolved) {
                const d = resolved.data;
                if (!isExplicitInactive(d.status)) {
                  syncCredentialsFromDoc(d);
                  const p = buildProfileFromDoc(resolved.id, d);
                  p.mobile = p.mobile || phoneFromEmail;
                  setWatchUid(resolved.id);
                  setProfile(p);
                  storeProfile(p);
                  diagSetIdentity(p.mobile);
                  diagLog('doc_phone_fallback', { status: String(d.status || 'missing'), role: String(d.role || 'missing') });
                } else {
                  diagLog('deactivate_logout', { status: String(d.status), via: 'phone-fallback' });
                  clearSession();
                  setProfile(null);
                }
              } else {
                diagLog('doc_missing', { authUid: firebaseUser.uid.slice(0, 6) });
              }
            }
          }
        } catch (e) {
          console.error('Auth state sync error:', e);
          diagLog('doc_err', { msg: String(e).slice(0, 140) });
        }
      } else {
        setWatchUid(null);
        // NEVER-AUTO-LOGOUT (Boss rule 2026-10-26: "ek baar login -> kabhi logout nahi"):
        // WebView me Firebase session restore kabhi-kabhi FAIL hota hai (IndexedDB
        // clear/corrupt, dashboard password change se refresh-token revoke). Cached
        // profile ko GAYAB mat karo — chupke se re-login try karo, isse staff ko
        // login screen kabhi nahi dikhti. Bina session ke bhi app chalti hai
        // (Firestore rules open + persistent cache).
        const cached = localStorage.getItem(PROFILE_KEY);
        diagLog('auth_null', { hadCached: !!cached });
        if (!cached) {
          setProfile(null);
        } else {
          const creds = readStoredCredentials();
          if (creds) {
            // cached profile ke saath app chalta rahega; creds se silent
            // re-login (network fail par 4s/12s/30s retry) — login screen
            // yahan se KABHI nahi aati
            trySilentReLogin(1);
          }
        }
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [booted]);

  // LIVE PROFILE SYNC (Boss bug 2026-10-26: "role change karne par screen ka
  // UI aur permissions change nahi hote"): ye watcher logged-in rehte hue
  // HAMESHA chalta hai — dashboard se role/status/name/PIN kuch bhi change
  // karo, app ka UI TURANT update ho jata hai (pehle ye sirf pending-approval
  // tak chalta tha, profile set hote hi band — isliye role change ke liye
  // logout/relogin karna padta tha).
  useEffect(() => {
    if (!watchUid) return;

    const userDocRef = doc(db, 'users', watchUid);
    const unsub = onSnapshot(
      userDocRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        // sirf EXPLICIT non-active status = admin logout; missing status = anomaly, session rakho
        if (isExplicitInactive(data.status)) {
          // Pending approval (profile abhi null) -> kuch mat karo, approval ka wait
          // Logged-in staff ko admin ne deactivate/delete kiya -> REAL logout
          if (localStorage.getItem(PROFILE_KEY)) {
            diagLog('watcher_deactivate', { status: String(data.status) });
            auth.signOut().catch(() => {});
            clearSession();
            setProfile(null);
          }
          return;
        }
        syncCredentialsFromDoc(data);
        const p: UserProfile = {
          uid: snap.id,
          name: data.name || 'Staff',
          mobile: data.phone || data.mobile || '',
          city: data.city || 'Main',
          role: (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : (data.role === 'manager' || data.role === 'admin') ? 'manager' : 'worker',
          status: 'active',
          photo: typeof data.photo === 'string' && data.photo ? data.photo : undefined,
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : (typeof data.createdAt === 'string' ? new Date(data.createdAt).getTime() : Date.now())
        };
        setProfile(p);
        storeProfile(p);
      },
      (err) => {
        console.error('Profile watch error:', err);
      }
    );

    return () => unsub();
  }, [watchUid]);

  // BACKGROUND LOCATION TRACKING (Boss order 2026-10-27: "salesman agar app
  // on naa bhi kare aur location on kare tab bhi unka location dashboard par
  // aana chahiye"): sales login hote hi NATIVE LocationTrackService (foreground
  // service) start — app band/killed hone par bhi GPS trail + ON/OFF events +
  // duty sync Firestore me jaate rehte hain. Logout / role-change (live watcher
  // se) / manager-worker switch par service stop. Worker/manager tracked nahi
  // (unke apne systems — native side bhi sales-only guard rakhta hai).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (profile?.role === 'sales' && profile?.uid) {
      fetchAppVersionInfo()
        .then((v) => LocationGuard.startTracking({
          uid: profile.uid,
          name: profile.name,
          role: 'sales',
          versionCode: v.appVersionCode
        }).catch(() => {}))
        .catch(() => {});
      diagLog('bg_track_start');
    } else {
      LocationGuard.stopTracking().catch(() => {});
    }
  }, [profile?.uid, profile?.role]);

  const handleLogout = () => {
    // EXPLICIT logout (hidden long-press) — yahi EK logout hai: profile + creds clear
    diagLog('logout_explicit');
    LocationGuard.stopTracking().catch(() => {}); // background tracking bhi band
    auth.signOut();
    clearSession();
    setProfile(null);
  };

  // NET-WAAPAS RE-LOGIN (slow-net layer 2): network restore hote hi chupke
  // se silent re-login — Firebase session turant wapas, staff ko kuch nahi
  // karna padta. Sirf tab jab cached session ho aur currentUser null ho.
  useEffect(() => {
    const onOnline = () => {
      try {
        if (auth.currentUser) return; // session already zinda hai
        if (!localStorage.getItem(PROFILE_KEY)) return; // logged-out — login khud karega
        if (!readStoredCredentials()) return;
        diagLog('silent_online_retry');
        trySilentReLogin(1);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Hardware back: in-app history => smooth slide back; root pe => app background (exit nahi)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: any = null;
    CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        CapApp.minimizeApp();
      }
    }).then((h) => {
      handle = h;
    });
    return () => {
      if (handle) handle.remove().catch(() => {});
    };
  }, []);

  return (
    <>
      {!introDone && <IntroScreen onDone={() => setIntroDone(true)} />}
      <UpdatePopup />
      <div className="relative flex min-h-screen flex-col">
        <BrandHeader />
        <main className="flex-1 pb-safe">
          {!booted || loading ? (
            <div className="flex min-h-[80vh] items-center justify-center text-slate-400">
              <div className="text-center">
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-indigo-500 border-r-transparent"></div>
                <p className="mt-3 text-sm">Loading Shivam Staff...</p>
              </div>
            </div>
          ) : !profile ? (
            <AuthScreen
              onLoginSuccess={(p) => {
                diagSetIdentity(p.mobile);
                diagLog('login_ok', { role: p.role });
                setProfile(p);
                storeProfile(p);
              }}
            />
          ) : (
            <div className="text-slate-100 font-sans selection:bg-amber-500/30">
              {/* LOCATION GATE (Boss order 2026-10-26): staff ko app open hote hi
                  sab se pehle location permission + 100m shop-radius check —
                  bahar = locked screen, andar = open + auto duty ON.
                  Manager kahin se bhi open (gate skip, tracking chalti hai). */}
              <LocationGate profile={profile}>
                {() => <HomeScreen profile={profile} onLogout={handleLogout} />}
              </LocationGate>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
