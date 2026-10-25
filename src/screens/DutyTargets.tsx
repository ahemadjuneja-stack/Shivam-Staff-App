import { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from '../types';

// ============================================================
// DUTY TARGETS — PC dashboard section (Boss order 2026-10-25):
// "Kis month me kitne hrs duty karni hai — jo dashboard me likhu
//  wo automatically app me update ho jaye"
//
// - Har month ka target: duty_targets/default_{YYYY-MM} doc (targetHours field)
// - App ka TIME section (DutyTimeSection) isi doc pe onSnapshot listener hai
//   -> SAVE karte hi sab staff ke app me LIVE update, restart nahi chahiye
// - Kisi month ka target set nahi -> app fallback 235H use karta hai
// - Sirf admin role ko dikhta hai (gate Home.tsx me)
// ============================================================

interface DutyTargetsProps {
  profile: UserProfile;
}

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (mk: string): string => {
  const [y, m] = mk.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
};

interface TargetRow {
  month: string;
  hours: number;
  updatedBy?: string;
}

export default function DutyTargets({ profile }: DutyTargetsProps) {
  const [month, setMonth] = useState<string>(monthKeyOf(new Date()));
  const [hours, setHours] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [rows, setRows] = useState<TargetRow[]>([]);

  // Live list — sab default_{month} targets
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'duty_targets'),
      (snap) => {
        const list: TargetRow[] = snap.docs
          .filter((d) => d.id.startsWith('default_'))
          .map((d) => {
            const v = d.data() as { targetHours?: unknown; updatedBy?: unknown };
            return {
              month: d.id.replace('default_', ''),
              hours: Number(v.targetHours) || 0,
              updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : undefined
            };
          })
          .filter((r) => r.month && r.hours > 0)
          .sort((a, b) => b.month.localeCompare(a.month));
        setRows(list);
      },
      () => setErrMsg('Could not load targets (permission denied). Check Firestore rules.')
    );
    return () => unsub();
  }, []);

  const handleSave = async () => {
    setOkMsg(null);
    setErrMsg(null);
    const h = Number(hours);
    if (!month) {
      setErrMsg('Please pick a month.');
      return;
    }
    if (!Number.isFinite(h) || h <= 0 || h > 1000) {
      setErrMsg('Please enter valid duty hours (1-1000).');
      return;
    }
    try {
      setSaving(true);
      await setDoc(
        doc(db, 'duty_targets', `default_${month}`),
        {
          targetHours: h,
          month,
          updatedBy: profile.name,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      setOkMsg(`${monthLabel(month)} target set to ${h}H — live update sent to all staff apps.`);
      setHours('');
    } catch (e: any) {
      const code = e?.code || '';
      if (code === 'permission-denied') {
        setErrMsg('Permission denied — Firestore rules are blocking this write.');
      } else {
        setErrMsg('Save failed: ' + (e?.message || 'unknown error'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Set / Edit target card */}
      <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] mb-5 space-y-4">
        <div>
          <label className="text-xs font-semibold text-[#8A93A6]">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-sm text-white [color-scheme:dark] focus:border-[#F59300] focus:outline-none"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-[#8A93A6]">Total Duty Hours for the Month</label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="e.g., 235"
            className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-sm text-white placeholder-slate-500 focus:border-[#F59300] focus:outline-none"
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-xl bg-[#F59300] py-3 text-xs font-black uppercase tracking-wider text-slate-950 shadow-lg hover:bg-[#fbaa33] disabled:opacity-50 transition active:scale-95"
        >
          {saving ? 'Saving...' : 'Save Target'}
        </button>

        {okMsg && (
          <p className="text-[11px] leading-relaxed text-[#34D399]">{okMsg}</p>
        )}
        {errMsg && (
          <p className="text-[11px] leading-relaxed text-[#FB7185]">{errMsg}</p>
        )}

        <p className="text-[11px] leading-relaxed text-[#5B677D]">
          Saved target applies live in every staff app (TIME section) — no restart needed. Months without a target fall back to 235H.
        </p>
      </div>

      {/* Live list */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-[#5B677D] uppercase tracking-[2.4px] px-1">Set Targets</h3>
        {rows.length === 0 ? (
          <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-6 text-center text-xs text-[#8A93A6]">
            No monthly targets set yet.
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.month}
              className={`bg-[#0C1628] border rounded-[22px] p-4 flex items-center justify-between shadow-[0_4px_16px_rgba(0,0,0,0.3)] ${
                r.month === monthKeyOf(new Date()) ? 'border-[#F59300]/50' : 'border-[#1D2B47]'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F59300]/13 text-[#F59300]">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">{monthLabel(r.month)}</h4>
                  {r.updatedBy && (
                    <p className="text-[11px] text-[#8A93A6] mt-0.5">by {r.updatedBy}</p>
                  )}
                </div>
              </div>
              <span className="text-[15px] font-extrabold text-[#38BDF8]">{r.hours}H</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
