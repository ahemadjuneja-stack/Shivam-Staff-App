import { useState } from 'react';
import { UserProfile } from './types';
import AuthScreen from './screens/Auth';
import HomeScreen from './screens/Home';

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('shivam_staff_logged_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

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
    <div className="min-h-screen bg-[#050C18] text-slate-100 font-sans selection:bg-amber-500/30">
      <HomeScreen profile={profile} onLogout={handleLogout} />
    </div>
  );
}

