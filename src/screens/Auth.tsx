import React, { useState, useEffect } from 'react';
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

declare global {
  interface Window {
    recaptchaVerifier?: RecaptchaVerifier;
    confirmationResult?: ConfirmationResult;
  }
}

interface AuthScreenProps {
  onRegistrationDone: () => void;
}

export default function AuthScreen({ onRegistrationDone }: AuthScreenProps) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [uid, setUid] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!window.recaptchaVerifier) {
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible'
      });
    }
    return () => {
      window.recaptchaVerifier?.clear();
      delete window.recaptchaVerifier;
    };
  }, []);

  const formatPhoneNumber = (input: string) => {
    const cleaned = input.replace(/\D/g, '');
    if (cleaned.length === 10) return `+91${cleaned}`;
    if (cleaned.startsWith('91') && cleaned.length === 12) return `+${cleaned}`;
    return input.startsWith('+') ? input : `+${cleaned}`;
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);
    try {
      const formatted = formatPhoneNumber(phone);
      if (!window.recaptchaVerifier) {
        window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
          size: 'invisible'
        });
      }
      const confirmation = await signInWithPhoneNumber(auth, formatted, window.recaptchaVerifier);
      window.confirmationResult = confirmation;
      setOtpSent(true);
    } catch (err: any) {
      setErrorMsg(err.message || 'OTP bhejne me problem aayi. Number check karein.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);
    try {
      if (!window.confirmationResult) throw new Error('Session expired. OTP firse mangwayein.');
      const res = await window.confirmationResult.confirm(otp);
      const user = res.user;

      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (!userDoc.exists()) {
        setUid(user.uid);
        setIsRegistering(true);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Galat OTP hai. Kripya check karein.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !city.trim()) {
      setErrorMsg('Kripya apna naam aur city enter karein.');
      return;
    }
    setLoading(true);
    try {
      await setDoc(doc(db, 'users', uid), {
        name: name.trim(),
        mobile: formatPhoneNumber(phone),
        city: city.trim(),
        role: 'worker',
        status: 'pending',
        createdAt: Date.now()
      });
      onRegistrationDone();
    } catch (err: any) {
      setErrorMsg(err.message || 'Registration save nahi ho paya.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div id="recaptcha-container"></div>
      <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900/90 p-7 shadow-2xl backdrop-blur">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black tracking-wider text-white">SHIVAM STAFF</h1>
          <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-indigo-400">
            Staff & Sales App
          </p>
        </div>

        {errorMsg && (
          <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
            {errorMsg}
          </div>
        )}

        {isRegistering ? (
          <form onSubmit={handleCompleteRegistration} className="space-y-4">
            <h3 className="text-sm font-bold text-white">Complete Your Registration</h3>
            <div>
              <label className="text-xs text-slate-400">Pura Naam</label>
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
              <label className="text-xs text-slate-400">City / Gaon</label>
              <input
                type="text"
                required
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Deesa / Palanpur"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Submitting...' : 'Register as Worker'}
            </button>
          </form>
        ) : !otpSent ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400">Mobile Number</label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Sending OTP...' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400">Enter 6-Digit OTP</label>
              <input
                type="number"
                required
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="123456"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-center text-lg font-bold tracking-widest text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify OTP & Login'}
            </button>
            <button
              type="button"
              onClick={() => setOtpSent(false)}
              className="w-full text-center text-xs text-slate-400 hover:text-slate-300"
            >
              Change Phone Number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
