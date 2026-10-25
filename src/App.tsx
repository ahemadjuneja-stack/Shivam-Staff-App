import { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { auth, db } from './firebase';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import UpdatePopup from './components/UpdatePopup';
import IntroScreen from './components/IntroScreen';
import BrandHeader from './components/BrandHeader';

export default function App() {
  const [introDone, setIntroDone] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('shivam_staff_logged_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
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
              const p: UserProfile = {
                uid: firebaseUser.uid,
                name: data.name || 'Staff',
                mobile: data.phone || data.mobile || '',
                city: data.city || 'Main',
                role: (data.role === 'admin' || data.role === 'owner' || data.role === 'boss') ? 'admin' : (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : 'worker',
                status: 'active',
                createdAt: typeof data.createdAt === 'number' ? data.createdAt : (typeof data.createdAt === 'string' ? new Date(data.createdAt).getTime() : Date.now())
              };
              setProfile(p);
              localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
            } else {
              setProfile(null);
              localStorage.removeItem('shivam_staff_logged_user');
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
                  const p: UserProfile = {
                    uid: snap.docs[0].id,
                    name: d.name || 'Staff',
                    mobile: d.phone || d.mobile || phoneFromEmail,
                    city: d.city || 'Main',
                    role: (d.role === 'admin' || d.role === 'owner' || d.role === 'boss') ? 'admin' : (d.role === 'sales' || d.role === 'salesman' || d.role === 'sales_manager') ? 'sales' : 'worker',
                    status: 'active',
                    createdAt: typeof d.createdAt === 'number' ? d.createdAt : (typeof d.createdAt === 'string' ? new Date(d.createdAt).getTime() : Date.now())
                  };
                  setProfile(p);
                  localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
                }
              }
            }
          }
        } catch (e) {
          console.error('Auth state sync error:', e);
        }
      } else {
        setWatchUid(null);
        setProfile(null);
        localStorage.removeItem('shivam_staff_logged_user');
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!watchUid || profile) return;

    const userDocRef = doc(db, 'users', watchUid);
    const unsub = onSnapshot(
      userDocRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.status !== 'active') return;
        const p: UserProfile = {
          uid: snap.id,
          name: data.name || 'Staff',
          mobile: data.phone || data.mobile || '',
          city: data.city || 'Main',
          role: (data.role === 'admin' || data.role === 'owner' || data.role === 'boss') ? 'admin' : (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : 'worker',
          status: 'active',
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : (typeof data.createdAt === 'string' ? new Date(data.createdAt).getTime() : Date.now())
        };
        setProfile(p);
        localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
      },
      (err) => {
        console.error('Approval watch error:', err);
      }
    );

    return () => unsub();
  }, [watchUid, profile]);

  const handleLogout = () => {
    auth.signOut();
    localStorage.removeItem('shivam_staff_logged_user');
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
                localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
              }}
            />
          ) : (
            <div className="text-slate-100 font-sans selection:bg-amber-500/30">
              <HomeScreen profile={profile} onLogout={handleLogout} />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
