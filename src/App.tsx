import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import HisabScreen from './screens/Hisab';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentTab, setCurrentTab] = useState<'duty' | 'hisab'>('duty');

  const [demoProfile, setDemoProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('shivam_staff_demo_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user && !demoProfile) {
        setProfile(null);
        setLoading(false);
      }
    });
    return () => unsubscribeAuth();
  }, [demoProfile]);

  useEffect(() => {
    if (demoProfile) {
      setProfile(demoProfile);
      setLoading(false);
      return;
    }
    if (!currentUser) return;
    const unsubProfile = onSnapshot(doc(db, 'users', currentUser.uid), (docSnap) => {
      if (docSnap.exists()) {
        setProfile({ uid: docSnap.id, ...(docSnap.data() as Omit<UserProfile, 'uid'>) });
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return () => unsubProfile();
  }, [currentUser, demoProfile]);

  const handleLogout = () => {
    localStorage.removeItem('shivam_staff_demo_user');
    setDemoProfile(null);
    setProfile(null);
    signOut(auth).catch(() => {});
  };

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-900 text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent"></div>
          <p className="text-sm tracking-wide text-slate-400">Loading Shivam Staff...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen onRegistrationDone={() => setLoading(true)} />;
  }

  if (!profile || profile.status === 'pending') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-6 text-center text-slate-200">
        <div className="rounded-2xl border border-slate-800 bg-slate-800/80 p-8 shadow-2xl backdrop-blur max-w-sm w-full">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-400 text-2xl font-bold">
            ⏳
          </div>
          <h2 className="text-xl font-bold text-white">Verification Pending</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Aapka registration receive ho chuka hai. Owner ke verify karne ke baad ye screen turant unlock ho jayegi.
          </p>
          <button
            onClick={handleLogout}
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700"
          >
            Log Out
          </button>
        </div>
      </div>
    );
  }

  if (profile.status === 'rejected') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-6 text-center text-slate-200">
        <div className="rounded-2xl border border-red-500/20 bg-slate-800/80 p-8 shadow-2xl max-w-sm w-full">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 text-red-400 text-2xl font-bold">
            ✕
          </div>
          <h2 className="text-xl font-bold text-white">Registration Rejected</h2>
          <p className="mt-3 text-sm text-slate-400">
            Aapka registration approve nahi kiya gaya hai. Kripya shop owner se direct sampark karein.
          </p>
          <button
            onClick={handleLogout}
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-slate-300"
          >
            Log Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 py-3 backdrop-blur">
        <div>
          <h1 className="text-base font-black tracking-wider text-white">SHIVAM STAFF</h1>
          <p className="text-xs text-indigo-400 capitalize">{profile.name} • {profile.role}</p>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white"
        >
          Logout
        </button>
      </header>

      <main className="flex-1 pb-20">
        {currentTab === 'duty' ? <HomeScreen profile={profile} /> : <HisabScreen profile={profile} />}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-slate-800 bg-slate-900/95 backdrop-blur">
        <button
          onClick={() => setCurrentTab('duty')}
          className={`flex flex-1 flex-col items-center py-2.5 text-xs font-semibold ${
            currentTab === 'duty' ? 'text-indigo-400 border-t-2 border-indigo-500' : 'text-slate-400'
          }`}
        >
          <span className="text-lg">⏱️</span>
          Duty & Star
        </button>
        {profile.role === 'sales' && (
          <button
            onClick={() => setCurrentTab('hisab')}
            className={`flex flex-1 flex-col items-center py-2.5 text-xs font-semibold ${
              currentTab === 'hisab' ? 'text-indigo-400 border-t-2 border-indigo-500' : 'text-slate-400'
            }`}
          >
            <span className="text-lg">📊</span>
            Hisab
          </button>
        )}
      </nav>
    </div>
  );
}
