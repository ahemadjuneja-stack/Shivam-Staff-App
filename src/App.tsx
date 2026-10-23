import { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import UpdatePopup from './components/UpdatePopup';

export default function App() {
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
                role: (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : 'worker',
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
                    role: (d.role === 'sales' || d.role === 'salesman' || d.role === 'sales_manager') ? 'sales' : 'worker',
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
          role: (data.role === 'sales' || data.role === 'salesman' || data.role === 'sales_manager') ? 'sales' : 'worker',
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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050C18] text-slate-400">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-indigo-500 border-r-transparent"></div>
          <p className="mt-3 text-sm">Loading Shivam Staff...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <UpdatePopup />
      {!profile ? (
        <AuthScreen
          onLoginSuccess={(p) => {
            setProfile(p);
            localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
          }}
        />
      ) : (
        <div className="min-h-screen bg-[#050C18] text-slate-100 font-sans selection:bg-amber-500/30">
          <HomeScreen profile={profile} onLogout={handleLogout} />
        </div>
      )}
    </>
  );
}
