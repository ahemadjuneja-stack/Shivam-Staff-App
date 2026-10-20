import { useState } from 'react';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';
import HisabScreen from './screens/Hisab';
import ShivamLogo from './components/ShivamLogo';

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('shivam_staff_logged_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [currentTab, setCurrentTab] = useState<'duty' | 'hisab'>('duty');

  const handleLogout = () => {
    localStorage.removeItem('shivam_staff_logged_user');
    setProfile(null);
  };

  if (!profile) {
    return (
      <AuthScreen
        onLoginSuccess={(p) => {
          setProfile(p);
          localStorage.setItem('shivam_staff_logged_user', JSON.stringify(p));
        }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#050914] text-slate-100">
      <header className="sticky top-0 z-40 grid grid-cols-3 items-center border-b border-slate-800 bg-slate-900/90 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center">
          <span className="text-xs font-semibold text-slate-300 truncate">{profile.name}</span>
        </div>
        <div className="flex justify-center">
          <ShivamLogo size="sm" />
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleLogout}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            Logout
          </button>
        </div>
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
