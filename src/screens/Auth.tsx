import { useState } from 'react';
import {
  collection,
  query,
  where,
  getDocs,
  setDoc,
  doc
} from 'firebase/firestore';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from 'firebase/auth';
import { db, auth } from '../firebase';
import { UserProfile } from '../types';
import ShivamLogo from '../components/ShivamLogo';

interface AuthScreenProps {
  onLoginSuccess: (profile: UserProfile) => void;
}

export default function AuthScreen({ onLoginSuccess }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'pending'>('login');
  const [mobile, setMobile] = useState('');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const getEmail = (phone: string) => `${phone.trim()}@shivamstaff.app`;
  const getPassword = (p: string) => `sv${p.trim()}shivam`;

  const friendlyError = (err: any) => {
    const code = err?.code || '';
    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/wrong-password' ||
      code === 'auth/user-not-found' ||
      code === 'auth/invalid-email'
    ) {
      return 'Incorrect mobile number or PIN.';
    }
    if (code === 'auth/email-already-in-use') {
      return 'This mobile number is already registered. Please login.';
    }
    if (code === 'auth/weak-password') {
      return 'PIN is too weak.';
    }
    return err?.message || 'Authentication failed. Please try again.';
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (!mobile.trim() || !pin.trim()) {
      setErrorMsg('Please enter mobile number and 4-digit PIN.');
      return;
    }
    if (mobile.trim().length !== 10) {
      setErrorMsg('Please enter a valid 10-digit mobile number.');
      return;
    }
    if (pin.trim().length !== 4) {
      setErrorMsg('PIN must be 4 digits.');
      return;
    }

    try {
      const email = getEmail(mobile);
      const password = getPassword(pin);

      await signInWithEmailAndPassword(auth, email, password);

      const q = query(
        collection(db, 'users'),
        where('phone', '==', mobile.trim())
      );
      const querySnap = await getDocs(q);

      let userData: any = null;
      let userUid = auth.currentUser?.uid || '';

      if (!querySnap.empty) {
        const userDoc = querySnap.docs[0];
        userData = userDoc.data();
        userUid = userDoc.id;
      }

      if (userData) {
        if (userData.status === 'pending') {
          setMode('pending');
          return;
        }
        if (userData.status === 'rejected') {
          setErrorMsg('Your registration has been rejected by admin.');
          return;
        }
        if (userData.status === 'active') {
          const profile: UserProfile = {
            uid: userUid,
            name: userData.name || 'Staff',
            mobile: userData.phone || userData.mobile || mobile.trim(),
            city: userData.city || 'Main',
            role: (userData.role === 'sales' || userData.role === 'salesman' || userData.role === 'sales_manager') ? 'sales' : 'worker',
            status: 'active',
            createdAt:
              typeof userData.createdAt === 'number'
                ? userData.createdAt
                : typeof userData.createdAt === 'string'
                ? new Date(userData.createdAt).getTime()
                : Date.now()
          };
          onLoginSuccess(profile);
          return;
        }
      }

      setMode('pending');
    } catch (err: any) {
      setErrorMsg(friendlyError(err));
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (!name.trim() || !mobile.trim() || !pin.trim()) {
      setErrorMsg('All fields are required.');
      return;
    }
    if (mobile.trim().length !== 10) {
      setErrorMsg('Please enter a valid 10-digit mobile number.');
      return;
    }
    if (pin.trim().length !== 4) {
      setErrorMsg('PIN must be 4 digits.');
      return;
    }

    try {
      const email = getEmail(mobile);
      const password = getPassword(pin);

      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      await setDoc(doc(db, 'users', uid), {
        name: name.trim(),
        phone: mobile.trim(),
        mobile: mobile.trim(),
        pin: pin.trim(),
        status: 'pending',
        role: 'none',
        allowedCategories: [],
        createdAt: Date.now()
      });

      setMode('pending');
    } catch (err: any) {
      setErrorMsg(friendlyError(err));
    }
  };

  if (mode === 'pending') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050914] p-4">
        <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900/95 p-8 text-center shadow-2xl backdrop-blur">
          <div className="mb-6 flex justify-center">
            <ShivamLogo size="md" subtitle="Staff Portal" />
          </div>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-400 text-3xl font-bold">
            ⏳
          </div>
          <h2 className="text-xl font-bold text-white">Pending Approval</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Your account is pending admin approval.
          </p>
          <button
            onClick={() => {
              setMode('login');
              setMobile('');
              setPin('');
              setName('');
              setErrorMsg('');
            }}
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-800 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050914] p-4">
      <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900/90 p-7 shadow-2xl backdrop-blur">
        <div className="mb-6 text-center flex flex-col items-center">
          <ShivamLogo size="lg" subtitle="Staff & Sales Portal" />
        </div>

        {errorMsg && (
          <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
            {errorMsg}
          </div>
        )}

        {mode === 'register' ? (
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400">Full Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ramesh Patel"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">Mobile Number (10 Digits)</label>
              <input
                type="tel"
                required
                maxLength={10}
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="9876543210"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">4-Digit PIN</label>
              <input
                type="password"
                required
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-center text-lg tracking-widest text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="mt-2 w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500"
            >
              Register
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400">Mobile Number</label>
              <input
                type="tel"
                required
                maxLength={10}
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="9876543210"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">4-Digit PIN</label>
              <input
                type="password"
                required
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-center text-lg tracking-widest text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500"
            >
              Login
            </button>
          </form>
        )}

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setErrorMsg('');
              setMobile('');
              setPin('');
              setName('');
            }}
            className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
          >
            {mode === 'login' ? 'New Staff? Register Here' : 'Already Registered? Login'}
          </button>
        </div>
      </div>
    </div>
  );
}
