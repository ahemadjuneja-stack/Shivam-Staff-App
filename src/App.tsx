import { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, query, where, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { auth, db } from './firebase';
import { PROFILE_KEY, readStoredCredentials, syncCredentialsFromDoc, clearSession } from './lib/session';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import LocationGate from './screens/LocationGate';
import UpdatePopup from './components/UpdatePopup';
import IntroScreen from './components/IntroScreen';
import BrandHeader from './components/BrandHeader';

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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setWatchUid(firebaseUser.uid);
        try {
          const userDocRef = doc(db, 'users', firebaseUser.uid);
          const userDocSnap = await getDoc(userDocRef);

          if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            if (data.status === 'active') {
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
              localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
            } else {
              // admin ne deactivate/delete kiya — REAL logout (profile + creds clear)
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
                if (d.status === 'active') {
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
                  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
                }
              }
            }
          }
        } catch (e) {
          console.error('Auth state sync error:', e);
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
        if (!cached) {
          setProfile(null);
        } else {
          const creds = readStoredCredentials();
          if (creds) {
            signInWithEmailAndPassword(auth, creds.email, creds.password).catch(() => {
              /* silent fail — cached profile + Firestore se app chalta rahega */
            });
          }
        }
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

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
        if (data.status !== 'active') {
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
        localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
      },
      (err) => {
        console.error('Profile watch error:', err);
      }
    );

    return () => unsub();
  }, [watchUid]);

  const handleLogout = () => {
    // EXPLICIT logout (hidden long-press) — yahi EK logout hai: profile + creds clear
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
          {loading ? (
            <div className="flex min-h-[80vh] items-center justify-center text-slate-400">
              <div className="text-center">
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-indigo-500 border-r-transparent"></div>
                <p className="mt-3 text-sm">Loading Shivam Staff...</p>
              </div>
            </div>
          ) : !profile ? (
            <AuthScreen
              onLoginSuccess={(p) => {
                setProfile(p);
                localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
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
