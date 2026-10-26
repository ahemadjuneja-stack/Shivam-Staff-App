import { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, query, where, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { auth, db } from './firebase';
import { PROFILE_KEY, readStoredCredentials, syncCredentialsFromDoc, clearSession, storeProfile, ensureSessionRestored } from './lib/session';
import { diagInitVersion, diagSetIdentity, diagLog } from './lib/diag';
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
                createdAt: typeof data.createdAt === 'number' ? data.createdAt : (typeof data.createdAt === 'string' ? new Date(data.createdAt).getTime() : Date.now())
              };
              setProfile(p);
              storeProfile(p);
              diagSetIdentity(p.mobile);
              diagLog('doc_ok', { status: String(data.status || 'missing'), role: String(data.role || 'missing') });
            } else {
              // admin ne deactivate/delete kiya — REAL logout (profile + creds clear)
              diagLog('deactivate_logout', { status: String(data.status) });
              clearSession();
              setProfile(null);
            }
          } else {
            const email = firebaseUser.email || '';
            const phoneFromEmail = email.split('@')[0];
            if (phoneFromEmail) {
              const q = query(collection(db, 'users'), where('phone', '==', phoneFromEmail));
              const snap = await getDocs(q);
              if (!snap.empty) {
                const d = snap.docs[0].data();
                if (!isExplicitInactive(d.status)) {
                  syncCredentialsFromDoc(d);
                  const p: UserProfile = {
                    uid: snap.docs[0].id,
                    name: d.name || 'Staff',
                    mobile: d.phone || d.mobile || phoneFromEmail,
                    city: d.city || 'Main',
                    role: (d.role === 'sales' || d.role === 'salesman' || d.role === 'sales_manager') ? 'sales' : (d.role === 'manager' || d.role === 'admin') ? 'manager' : 'worker',
                    status: 'active',
                    createdAt: typeof d.createdAt === 'number' ? d.createdAt : (typeof d.createdAt === 'string' ? new Date(d.createdAt).getTime() : Date.now())
                  };
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

  const handleLogout = () => {
    // EXPLICIT logout (hidden long-press) — yahi EK logout hai: profile + creds clear
    diagLog('logout_explicit');
    auth.signOut();
    clearSession();
    setProfile(null);
  };

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
