import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { db } from '../firebase';
import { LocationGuard, PermStatus } from '../lib/locationGuard';
import { diagLog } from '../lib/diag';
import PrivacyPolicy, { POLICY_VERSION } from './PrivacyPolicy';

// ============================================================
// CONSENT GATE (Boss order 2026-11-17, v2 feedback: "Itna sara heavy
// dikhane ki zaroorat nahi — bas zaroori permission jaise notifications aur
// location dikha, baaki Terms & Conditions ke andar likh do ki kya-kya
// permission li gayi hai. Sab kuch short aur ENGLISH me likho.")
//
// FLOW: login -> CONSENT DIALOG (sirf 2 cards: Location + Notifications;
// baaki permissions T&C text ke andar; privacy policy link; checkbox; accept)
// -> WIZARD (Android system prompts ek-ek karke — Android ka rule, system
// dialogs combine nahi hote) -> LOCATION GATE -> Home.
//
// Rules:
//  - Accept ke bina app aage nahi badhti (checkbox ke bina Accept band).
//  - Consent Firestore 'consents/{uid}' me record — offline par pending flag,
//    agli open par silent retry.
//  - Ek baar accept -> localStorage flag -> boot par SKIP (smooth, Boss rule).
//  - Wizard me permission reh jaye to bhi aage ja sakte ho (baad me settings
//    se dena) — sirf location LocationGate khud enforce karta hai.
// ============================================================

// Consent key policy-version-aware (v3: WiFi/silent-tracking disclosures
// judne par staff ko EK baar naya dialog dikhega — DPDP-compliant re-consent,
// accept ke baad phir smooth skip).
const consentKey = (uid: string) => `shivam_consent_${POLICY_VERSION}_${uid}`;
const pendingKey = (uid: string) => `shivam_consent_pending_${uid}`;

interface ConsentGateProps {
  profile: { uid: string; name: string; mobile: string; role: 'worker' | 'sales' | 'manager' };
  children: () => ReactNode;
}

type Phase = 'consent' | 'wizard' | 'policy' | 'pass';

// Wizard rows (full list — Android prompts inhi ke against aate hain)
interface PermRow {
  id: keyof PermStatus;
  title: string;
  why: string;
  optional?: boolean;
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
  const isStaffLike = isSales || isWorker; // usage-access row inhi ke liye

  // ---------- Wizard rows (dialog par sirf pehli 2 dikhti hain — Boss v2) ----------
  const rows: PermRow[] = [
    {
      id: 'fineLocation',
      title: 'Location (GPS)',
      why: 'Shop check-in and duty tracking',
      action: 'request',
    },
    {
      id: 'notifications',
      title: 'Notifications',
      why: 'Duty and alert messages',
      action: 'request',
    },
    {
      id: 'motion',
      title: 'Motion (Activity recognition)',
      why: 'Keeps GPS off when you are still — saves battery',
      action: 'request',
    },
    {
      id: 'backgroundLocation',
      title: 'Background location (Allow all the time)',
      why: 'Duty trail keeps recording when the app is closed',
      action: 'settings',
    },
    {
      id: 'batteryExempt',
      title: 'Battery optimization exempt',
      why: 'Phone battery-saver cannot stop tracking',
      action: 'battery',
    },
    ...(isStaffLike
      ? [
          {
            id: 'usageAccess' as keyof PermStatus,
            title: 'App usage access (optional)',
            why: 'Minutes only — screen content is never read. Shop time only',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.uid]);

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
        backLabel={agree ? 'Back to permissions' : 'Back'}
      />
    );
  }

  // ---------- WIZARD (system prompts ek-ek karke) ----------
  if (phase === 'wizard') {
    const pending = rows.filter((r) => !r.optional && status && !status[r.id]);
    return (
      <div className="relative flex min-h-[86vh] items-center justify-center px-5 py-6 text-slate-100">
        <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-indigo-500/15" />
        <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-7">
          <h1 className="text-[19px] font-extrabold tracking-tight text-white">Allow permissions</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">
            Android shows its own popup for each permission. Tap{' '}
            <span className="font-semibold text-slate-200">Allow</span> on each one.
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
                      {r.action === 'request' ? 'Allow' : 'Settings'}
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
            Allow all permissions
          </button>

          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
            {status === null
              ? 'Checking permission status...'
              : pending.length === 0
                ? 'All main permissions granted.'
                : `${pending.length} pending — you can allow them later.`}
          </p>

          <button
            onClick={() => setPhase('pass')}
            className="mt-3 w-full rounded-2xl bg-slate-700/70 py-3.5 text-[13.5px] font-bold text-slate-200 active:scale-[0.98]"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // ---------- CONSENT (ek hi dialog — Boss v2: light, English) ----------
  return (
    <div className="relative flex min-h-[86vh] items-center justify-center px-5 py-6 text-slate-100">
      <div className="ambient-orb -top-10 -right-14 h-56 w-56 bg-indigo-500/15" />
      <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-7">
        <h1 className="text-center text-[20px] font-extrabold tracking-tight text-white">
          Permissions &amp; Privacy
        </h1>
        <p className="mt-1.5 text-center text-[12px] text-slate-400">
          This app needs these permissions
        </p>

        <div className="mt-4 space-y-2">
          <div className="rounded-2xl bg-slate-800/50 px-3.5 py-3">
            <p className="text-[13.5px] font-semibold text-slate-100">Location access (GPS)</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">
              Shop check-in, duty tracking and tour records
            </p>
          </div>
          <div className="rounded-2xl bg-slate-800/50 px-3.5 py-3">
            <p className="text-[13.5px] font-semibold text-slate-100">Notifications</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-slate-400">
              Duty and alert messages
            </p>
          </div>
        </div>

        <button
          onClick={() => setPhase('policy')}
          className="mt-3.5 w-full rounded-2xl border border-indigo-400/30 bg-indigo-500/10 py-3 text-[13px] font-bold text-indigo-200 active:scale-[0.98]"
        >
          Read Privacy Policy
        </button>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-slate-800/60 px-4 py-3.5">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded accent-indigo-500"
          />
          <span className="text-[12.5px] leading-relaxed text-slate-300">
            <span className="font-semibold text-slate-100">Terms &amp; Conditions:</span> I
            accept them. The app also uses background location, motion detection,
            battery-optimization exemption, nearby Wi-Fi network IDs (shop presence
            detection only — router IDs and signal strength, never their traffic) and
            app usage time (shop staff, shop time only) — all listed in the Privacy
            Policy. The company may use my work data for duty, accounts and alerts,
            because I work here.
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
          {saving ? 'Saving...' : 'I Agree — Continue'}
        </button>
        {!agree ? (
          <p className="mt-2 text-center text-[11px] text-slate-500">
            Tick the checkbox to continue
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
    policyVersion: POLICY_VERSION,
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
