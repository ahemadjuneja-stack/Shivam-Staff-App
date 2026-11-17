import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { db } from '../firebase';
import { LocationGuard, PermStatus } from '../lib/locationGuard';
import { diagLog } from '../lib/diag';
import PrivacyPolicy from './PrivacyPolicy';

// ============================================================
// CONSENT GATE (Boss order 2026-11-17: "App installed hote staff manager
// aur sales role ko SARE permissions EK HI dialog me dikhna chahiye —
// usme sirf permission ka zikr, niche privacy policy ka link, ek check-mark
// ke terms & conditions wo manta hai aur uska data use karne ki hume
// permission hai kyunki wo hamare yaha kaam karta hai. Permission dete
// waqt wo policy padh bhi sakta hai.")
//
// FLOW: login -> ConsentGate (ek dialog: permission list + policy link +
// checkbox) -> Accept -> WIZARD (Android ke system prompts ek-ek karke —
// ye Android ka rule hai, ek hi system dialog me nahi aa sakte) -> gate -> Home.
//
// Rules:
//  - Accept ke BINA app aage nahi badhti (checkbox ke bina Accept band).
//  - Consent Firestore 'consents/{uid}' me record (policyVersion ke saath)
//    — offline ho to local pending flag, agli baar online hote hi write.
//  - Ek baar accept -> localStorage flag -> boot par SKIP (smooth, Boss rule).
//  - Wizard me koi permission reh jaye to bhi aage ja sakte ho (baad me
//    settings se dena) — sirf location LocationGate khud enforce karta hai.
// ============================================================

const consentKey = (uid: string) => `shivam_consent_v1_${uid}`;
const pendingKey = (uid: string) => `shivam_consent_pending_${uid}`;

interface ConsentGateProps {
  profile: { uid: string; name: string; mobile: string; role: 'worker' | 'sales' | 'manager' };
  children: () => ReactNode;
}

type Phase = 'consent' | 'wizard' | 'policy' | 'pass';

// Ek permission-row ka model: status wizard me poll se aata hai
interface PermRow {
  id: keyof PermStatus;
  title: string;
  why: string;
  optional?: boolean;
  // status false par kaunsa action button dikhana hai
  action?: 'request' | 'settings' | 'battery' | 'usage';
}

export default function ConsentGate({ profile, children }: ConsentGateProps) {
  const [phase, setPhase] = useState<Phase>(() => {
    try {
      return window.localStorage.getItem(consentKey(profile.uid)) ? 'pass' : 'consent';
    } catch {
      return 'consent';
    }
  });
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<PermStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  const isSales = profile.role === 'sales';
  const isWorker = profile.role === 'worker';
  const isStaffLike = isSales || isWorker; // usage-access wali rows inhi ke liye

  // ---------- Permission rows (role-wise) ----------
  const rows: PermRow[] = [
    {
      id: 'fineLocation',
      title: 'Location (GPS + network)',
      why: 'Dukan ke 100 meter ka gate, tour tracking, duty ka pata — bina location app nahi khulti',
      action: 'request',
    },
    {
      id: 'notifications',
      title: 'Notification',
      why: 'Duty aur alerts ki jankari phone par dikhe',
      action: 'request',
    },
    {
      id: 'motion',
      title: 'Motion (Activity recognition)',
      why: 'Chalne ka signal — GPS bewajah on na ho, battery bache',
      action: 'request',
    },
    {
      id: 'backgroundLocation',
      title: 'Background location (Allow all the time)',
      why: 'App band ho to bhi duty ka trail ban sake — settings se "Allow all the time" karna hai',
      action: 'settings',
    },
    {
      id: 'batteryExempt',
      title: 'Battery optimization exempt',
      why: 'Phone ka battery-saver tracking band na kar sake',
      action: 'battery',
    },
    ...(isStaffLike
      ? [
          {
            id: 'usageAccess' as keyof PermStatus,
            title: 'App usage access (optional)',
            why: 'Dukan par kaun si app kitni der khuli rahi — sirf minutes ka total, screen content kabhi nahi. Bahar ka time track nahi hota',
            optional: true,
            action: 'usage' as const,
          },
        ]
      : []),
  ];

  // ---------- Status polling ----------
  const refreshStatus = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const s = await LocationGuard.permStatus();
      setStatus(s);
    } catch {
      /* web/old native — ignore */
    }
  }, []);

  useEffect(() => {
    if (phase !== 'wizard') return;
    refreshStatus();
    pollRef.current = window.setInterval(refreshStatus, 2500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [phase, refreshStatus]);

  // Pending consent doc retry (offline-accept wala)
  const flushPendingConsent = useCallback(() => {
    try {
      if (!window.localStorage.getItem(pendingKey(profile.uid))) return;
      writeConsentDoc(profile, true);
    } catch {
      /* ignore */
    }
  }, [profile.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase === 'pass') flushPendingConsent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleAccept = async () => {
    if (!agree || saving) return;
    setSaving(true);
    try {
      window.localStorage.setItem(consentKey(profile.uid), String(Date.now()));
      diagLog('consent_accept', { role: profile.role });
    } catch {
      /* storage block — wizard phir bhi chale */
    }
    writeConsentDoc(profile, false);
    setSaving(false);
    setPhase(Capacitor.isNativePlatform() ? 'wizard' : 'pass');
  };

  // ---------- PASS: gate ko aage badho ----------
  if (phase === 'pass') return <>{children()}</>;

  // ---------- PRIVACY POLICY full-screen ----------
  if (phase === 'policy') {
    return (
      <PrivacyPolicy
        onBack={() => setPhase(agree ? 'wizard' : 'consent')}
        backLabel={agree ? 'Permissions par wapas' : 'Consent par wapas'}
      />
    );
  }

  // ---------- WIZARD (system prompts ek-ek karke) ----------
  if (phase === 'wizard') {
    const allRequiredOk = status ? !!status.fineLocation : null;
    const pending = rows.filter((r) => !r.optional && status && !status[r.id]);
    return (
      <div className="relative flex min-h-[86vh] items-center justify-center px-5 py-6 text-slate-100">
        <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-indigo-500/15" />
        <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-7">
          <h1 className="text-[19px] font-extrabold tracking-tight text-white">
            Permissions do
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">
            Android har permission ka apna popup dikhata hai (ek-ek karke). Har
            popup par <span className="font-semibold text-slate-200">Allow</span>{' '}
            dabao — main app check karti rahegi.
          </p>

          <div className="mt-4 space-y-2.5">
            {rows.map((r) => {
              const st = status ? status[r.id] : null;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-2xl bg-slate-800/50 px-3.5 py-3"
                >
                  <div
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
                      st === true
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : st === null
                          ? 'bg-slate-600/40 text-slate-400'
                          : r.optional
                            ? 'bg-slate-600/40 text-slate-300'
                            : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {st === true ? '✓' : '•'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold leading-tight text-slate-100">
                      {r.title}
                      {r.optional ? (
                        <span className="ml-1.5 rounded-full bg-slate-600/40 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                          OPTIONAL
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">{r.why}</p>
                  </div>
                  {st === false && r.action ? (
                    <button
                      onClick={async () => {
                        try {
                          if (r.action === 'request') await LocationGuard.requestPermissions();
                          else if (r.action === 'battery')
                            await LocationGuard.requestBatteryExemption();
                          else if (r.action === 'usage') await LocationGuard.requestUsageAccess();
                          else if (r.action === 'settings') await LocationGuard.openAppSettings();
                        } catch {
                          /* ignore */
                        }
                        window.setTimeout(refreshStatus, 1200);
                      }}
                      className="shrink-0 rounded-xl bg-indigo-500/25 px-3 py-2 text-[11.5px] font-bold text-indigo-200 active:scale-95"
                    >
                      {r.action === 'request' ? 'Den do' : 'Settings'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <button
            onClick={async () => {
              try {
                await LocationGuard.requestPermissions();
              } catch {
                /* ignore */
              }
            }}
            className="mt-4 w-full rounded-2xl bg-indigo-500 py-4 text-[15px] font-bold text-white active:scale-[0.98]"
          >
            Sab permissions do
          </button>

          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
            {status === null
              ? 'Permission status check ho raha hai...'
              : pending.length === 0
                ? 'Sab main permissions mil gayi — aage badho.'
                : `${pending.length} permission baki hai — abhi skip karoge to baad me bhi de sakte ho.`}
          </p>

          <button
            onClick={() => setPhase('pass')}
            className="mt-3 w-full rounded-2xl bg-slate-700/70 py-3.5 text-[13.5px] font-bold text-slate-200 active:scale-[0.98]"
          >
            {allRequiredOk === false ? 'Aage badho (location baad me)' : 'Aage badho'}
          </button>
        </div>
      </div>
    );
  }

  // ---------- CONSENT (ek hi dialog — Boss ka order) ----------
  return (
    <div className="relative flex min-h-[86vh] items-center justify-center px-5 py-6 text-slate-100">
      <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-indigo-500/15" />
      <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-7">
        <h1 className="text-center text-[20px] font-extrabold tracking-tight text-white">
          Permissions &amp; Privacy
        </h1>
        <p className="mt-1.5 text-center text-[12px] text-slate-400">
          {profile.name} — ye app chalane ke liye ye permissions chahiye
        </p>

        <div className="mt-4 space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-2xl bg-slate-800/50 px-3.5 py-3">
              <p className="text-[13.5px] font-semibold text-slate-100">
                {r.title}
                {r.optional ? (
                  <span className="ml-1.5 rounded-full bg-slate-600/40 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                    OPTIONAL
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">{r.why}</p>
            </div>
          ))}
        </div>

        <button
          onClick={() => setPhase('policy')}
          className="mt-3.5 w-full rounded-2xl border border-indigo-400/30 bg-indigo-500/10 py-3 text-[13px] font-bold text-indigo-200 active:scale-[0.98]"
        >
          Privacy Policy padho — kya data, kyun, kya nahi
        </button>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-slate-800/60 px-4 py-3.5">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded accent-indigo-500"
          />
          <span className="text-[12.5px] leading-relaxed text-slate-300">
            Main <span className="font-semibold text-slate-100">Terms &amp; Conditions</span>{' '}
            manta/manti hoon aur Privacy Policy padh li hai. Company ko mere
            upar-likhe data (location, duty, hisab, app-usage ke totals) ka use
            karne ki permission hai —{' '}
            <span className="font-semibold text-slate-100">kyunki main yahan
            kaam karta/karti hoon</span>.
          </span>
        </label>

        <button
          onClick={handleAccept}
          disabled={!agree || saving}
          className={`mt-4 w-full rounded-2xl py-4 text-[15px] font-bold transition ${
            agree && !saving
              ? 'bg-emerald-500 text-white active:scale-[0.98]'
              : 'cursor-not-allowed bg-slate-700/60 text-slate-500'
          }`}
        >
          {saving ? 'Save ho raha hai...' : 'Main manta hoon — aage badho'}
        </button>
        {!agree ? (
          <p className="mt-2 text-center text-[11px] text-slate-500">
            Checkbox tick karne ke baad hi aage badh sakte ho
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Firestore consent doc ----------
// 'consents/{uid}': consent ka record — kisne, kab, kis policy version par.
// Offline accept par pending flag set hota hai; agli open par retry (boss ko
// record MILNA chahiye — fail chupke se accept nahi hoga).
function writeConsentDoc(
  profile: { uid: string; name: string; mobile: string; role: string },
  isRetry: boolean
) {
  const payload = {
    uid: profile.uid,
    name: profile.name,
    mobile: profile.mobile || '',
    role: profile.role,
    policyVersion: 1,
    acceptedAt: Date.now(),
    userAgent: navigator.userAgent.slice(0, 180),
  };
  setDoc(doc(db, 'consents', profile.uid), payload, { merge: true })
    .then(() => {
      try {
        window.localStorage.removeItem(pendingKey(profile.uid));
      } catch {
        /* ignore */
      }
      diagLog(isRetry ? 'consent_retry_ok' : 'consent_doc_ok');
    })
    .catch(() => {
      // offline/firestore fail — pending flag; app open hote hi dobara try
      try {
        window.localStorage.setItem(pendingKey(profile.uid), String(Date.now()));
      } catch {
        /* ignore */
      }
      diagLog('consent_doc_pending');
    });
}
