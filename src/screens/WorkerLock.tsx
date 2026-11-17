import { useState } from 'react';
import { addDoc, collection } from 'firebase/firestore';
import { Lock, WifiOff, Send, ShieldAlert, MapPin } from 'lucide-react';
import { db } from '../firebase';
import type { WorkerLiveDoc } from '../lib/workerLive';
import { diagLog } from '../lib/diag';

// ============================================================
// WORKER LOCK SCREEN (Boss order 2026-11-17):
// "worker 100 mitter ke andar ho tabhi app on ho... aur bahar jaye to app lock"
//
// Native engine (3-min check) OUTSIDE confirm karta hai (GPS >= 150m ya WiFi
// match fail + tower change) -> worker_live.lock=true -> YE full-screen lock.
// Worker wapas shop aaya (auto unlock) ya manager ne unlock kiya -> turant
// khul jata hai (onSnapshot live).
//
// Reason bhejne ka button: worker apni safety deta hai ("bathroom gaya tha",
// "parcel lena tha") — manager StaffDetail me dikhta hai + UNLOCK kar sakta.
// Sirf ek reason per lock period (sent flag localStorage).
// ============================================================
export default function WorkerLock({
  profileUid,
  profileName,
  live,
}: {
  profileUid: string;
  profileName: string;
  live: WorkerLiveDoc | null;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(`shivam_lock_reason_${profileUid}`) === '1';
    } catch {
      return false;
    }
  });

  const sendReason = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await addDoc(collection(db, 'worker_alerts'), {
        uid: profileUid,
        name: profileName,
        type: 'reason',
        text: t.slice(0, 200),
        at: Date.now(),
        dist: typeof live?.dist === 'number' ? live.dist : undefined,
        cellKey: live?.cellKey || '',
        city: live?.city || '',
        status: 'open',
      });
      try {
        window.localStorage.setItem(`shivam_lock_reason_${profileUid}`, '1');
      } catch {
        /* ignore */
      }
      setSent(true);
      setText('');
      diagLog('worker_reason_sent');
    } catch {
      diagLog('worker_reason_err');
    }
    setSending(false);
  };

  const at = live?.at ? new Date(live.at) : null;
  const outSide = live?.state === 'OUTSIDE';
  const locOff = live?.state === 'LOC_OFF';

  return (
    <div className="relative flex min-h-[86vh] items-center justify-center px-5 py-6 text-slate-100">
      <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-rose-500/15" />
      <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-7">
        <div className="flex flex-col items-center text-center">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-full"
            style={{ background: 'rgba(244,63,94,0.14)', boxShadow: '0 0 0 2.5px rgba(244,63,94,0.35)' }}
          >
            {locOff ? (
              <WifiOff className="h-8 w-8 text-rose-300" />
            ) : (
              <Lock className="h-8 w-8 text-rose-300" />
            )}
          </div>
          <h1 className="mt-4 text-[20px] font-extrabold tracking-tight text-white">
            {locOff ? 'Location band hai' : 'App is locked'}
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">
            {locOff
              ? 'Shop tracking ke liye location ON hona zaroori hai. Settings me location on karo aur app dobara kholo.'
              : outSide
                ? 'Aap shop ke 100 meter se bahar ho. Wapas shop me aao — app khud unlock ho jayega.'
                : 'Shop ke bahar hone ki wajah se app band hai. Wapas shop me aao.'}
          </p>
        </div>

        {/* last check info */}
        <div className="mt-4 rounded-2xl bg-slate-800/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="text-[12.5px] font-semibold text-slate-200">
              {typeof live?.dist === 'number' && live.dist >= 0
                ? `Shop se ${Math.round(live.dist)} m door`
                : locOff
                  ? 'Location signal nahi mil raha'
                  : 'Last check poora hua tha'}
            </span>
          </div>
          {at ? (
            <p className="mt-1 text-[11px] text-slate-500">
              Last update: {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          ) : null}
        </div>

        {/* reason send */}
        {!sent ? (
          <div className="mt-4">
            <label className="flex items-center gap-2 text-[11px] font-extrabold tracking-[0.14em] text-slate-400">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-300" /> MANAGER KO BATAYE
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="Kaha gaye the / kyu? (jaise: parcel lene gaya tha)"
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-slate-800/60 px-4 py-3 text-[13px] text-slate-100 placeholder:text-slate-500 focus:border-indigo-400/40 focus:outline-none"
            />
            <button
              onClick={sendReason}
              disabled={!text.trim() || sending}
              className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[14px] font-bold transition ${
                text.trim() && !sending
                  ? 'bg-indigo-500 text-white active:scale-[0.98]'
                  : 'cursor-not-allowed bg-slate-700/60 text-slate-500'
              }`}
            >
              <Send className="h-4 w-4" />
              {sending ? 'Sending...' : 'Send to Manager'}
            </button>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-emerald-300/25 bg-emerald-400/10 px-4 py-3 text-[12.5px] font-semibold text-emerald-300">
            Aapka message manager ko pahunch gaya. Wapas shop me aao — app khud unlock hoga.
          </div>
        )}

        <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Manager bhi app se unlock kar sakta hai. Shop me wapas aate hi app normal chalega.
        </p>
      </div>
    </div>
  );
}
