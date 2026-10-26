import { useEffect, useRef, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from '../types';
import Avatar from '../components/Avatar';
import { ChevronLeft, Camera, Loader2, CheckCircle2 } from 'lucide-react';

// ============================================================
// PROFILE SCREEN (Boss order 2026-10-27): "har salesman staff manager sabke
// upar jaha naam showing hota hai us naam par click karne par profile khulni
// chahiye aur waha ek profile photo add karne ka option do"
// - Photo users/{uid}.photo me compressed JPEG dataURL (~256px, q 0.82) —
//   Firestore doc hi kaafi hai, Storage ki zaroorat nahi.
// - Upload ke baad App.tsx ka live users watcher profile.photo update karta
//   hai -> header avatar HAR screen par turant badal jata hai.
// ============================================================
export default function ProfileScreen({
  profile,
  onBack
}: {
  profile: UserProfile;
  onBack: () => void;
}) {
  const [photo, setPhoto] = useState<string | undefined>(profile.photo);
  const [busy, setBusy] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // users doc live — dashboard/ dusre device se badle photo to bhi sync
  useEffect(() => {
    const unsub = (async () => {})();
    let alive = true;
    getDoc(doc(db, 'users', profile.uid))
      .then((s) => {
        if (!alive || !s.exists()) return;
        const p = s.data()?.photo;
        if (typeof p === 'string' && p) setPhoto(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
      void unsub;
    };
  }, [profile.uid]);

  // Canvas cover-crop 256x256 JPEG — poora album-size photo kabhi doc me nahi jata
  const handleFile = (file: File | null | undefined) => {
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) {
      window.alert('Please choose an image file.');
      return;
    }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const SIZE = 256;
          const canvas = document.createElement('canvas');
          canvas.width = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas');
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          if (dataUrl.length > 900_000) {
            throw new Error('size');
          }
          setDoc(doc(db, 'users', profile.uid), { photo: dataUrl, photoAt: Date.now() }, { merge: true })
            .then(() => {
              setPhoto(dataUrl);
              setSavedTick(true);
              window.setTimeout(() => setSavedTick(false), 2500);
            })
            .catch((e) => window.alert('Could not save photo: ' + String(e?.message || e)))
            .finally(() => setBusy(false));
        } catch {
          window.alert('Could not process this photo. Please try another image.');
          setBusy(false);
        }
      };
      img.onerror = () => {
        window.alert('Could not read this image. Please try another photo.');
        setBusy(false);
      };
      img.src = String(reader.result || '');
    };
    reader.onerror = () => {
      window.alert('Could not read the file.');
      setBusy(false);
    };
    reader.readAsDataURL(file);
  };

  const roleLabel =
    profile.role === 'manager' ? 'Manager' : profile.role === 'sales' ? 'Salesman' : 'Staff';

  return (
    <div className="relative min-h-screen text-slate-100 px-4 pb-28">
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-indigo-500/15" />
      <div className="ambient-orb top-[45%] -left-20 h-56 w-56 bg-amber-400/10" />

      <div className="relative z-10 mb-4 flex items-center gap-3 pt-2">
        <button
          onClick={onBack}
          className="glass-card flex items-center gap-1.5 rounded-full px-4 py-2.5 text-[12px] font-extrabold text-slate-200 transition active:scale-95"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <h2 className="text-[16px] font-semibold text-[#B7C5F0]">My Profile</h2>
      </div>

      <div className="glass-card intro-rise relative z-10 rounded-[26px] px-5 py-6">
        <div className="flex flex-col items-center">
          <div className="relative">
            <Avatar photo={photo} name={profile.name} size={112} className="shadow-2xl" />
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55">
                <Loader2 className="h-7 w-7 animate-spin text-white" />
              </div>
            )}
          </div>
          {savedTick && (
            <div className="mt-2 flex items-center gap-1 rounded-full border border-emerald-300/25 bg-emerald-400/10 px-3 py-1 text-[10px] font-extrabold text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Photo saved
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.currentTarget.value = '';
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="mt-4 flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 px-5 py-2.5 text-[12px] font-extrabold text-slate-950 shadow-lg shadow-sky-500/25 transition active:scale-95 disabled:opacity-50"
          >
            <Camera className="h-4 w-4" />
            {photo ? 'Change Profile Photo' : 'Add Profile Photo'}
          </button>
          <p className="mt-2 text-center text-[10.5px] leading-relaxed text-slate-500">
            Your photo appears next to your name everywhere in the app.
          </p>
        </div>

        <div className="mt-6 space-y-2">
          <div className="glass-inset flex items-center justify-between rounded-xl px-4 py-3">
            <span className="text-[11px] font-medium text-slate-500">Name</span>
            <span className="text-[13px] font-bold text-slate-100">{profile.name}</span>
          </div>
          <div className="glass-inset flex items-center justify-between rounded-xl px-4 py-3">
            <span className="text-[11px] font-medium text-slate-500">Role</span>
            <span className="text-[13px] font-bold text-slate-100">{roleLabel}</span>
          </div>
          <div className="glass-inset flex items-center justify-between rounded-xl px-4 py-3">
            <span className="text-[11px] font-medium text-slate-500">Mobile</span>
            <span className="text-[13px] font-bold tabular-nums text-slate-100">{profile.mobile || '—'}</span>
          </div>
          <div className="glass-inset flex items-center justify-between rounded-xl px-4 py-3">
            <span className="text-[11px] font-medium text-slate-500">City</span>
            <span className="text-[13px] font-bold text-slate-100">{profile.city || '—'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
