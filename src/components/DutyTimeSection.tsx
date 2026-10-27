import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, DocumentSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { PunchRecord, UserProfile } from '../types';
import { computeDutyMin, FALLBACK_TARGET_H } from '../lib/duty';

// ============================================================
// DUTY TIME SECTION (Boss demo screenshot — TIME section only)
// Row 1: D. Overtime/Undertime (green/red) | workedToday / dailyTarget : D
// Row 2: M. Overtime/Undertime (green/red) | workedMonth / monthTarget : M
// Recovery line: REMOVED per Boss order 2026-10-25 (calculation intact rahegi)
//
// RULES (Boss confirmed 2026-10-25):
// - Shift start: 10:00 AM (fixed)
// - Daily OT = jaldi aana (first-in vs 10:00) + shift ke baad rukna (out/now vs shift end)
// - Daily UT = late aana (first-in vs 10:00)
// - Weekly off: KOI NAHI — saare din working (dailyTarget = monthlyTarget / daysInMonth)
// - Monthly target: dashboard/console se (duty_targets docs), fallback 235H
// - Monthly expected-by-now = dailyRate x (kal raat tak ke din, BASELINE SE)
// - BASELINE RULE (Boss order 2026-10-25, 181H bug fix): expected din ginna
//   worker ke apne system-life se — registration (createdAt) ya uske baad —
//   month start se NAHI. Punch system Oct 20 ko live hua tha; month-start
//   counting se 100% perfect worker ko bhi ~144H+ bogas undertime dikh raha
//   tha (23 din aise jab punch system exist hi nahi karta tha). Zero-punch
//   worker ke liye registration date se count hota hai — koi gunjaish nahi:
//   jis din se staff system me hai, us din se har din count hai.
// - Sirf worker role ko dikhta hai (sales ko nahi) — Home.tsx me gated
// ============================================================

interface DutyTimeSectionProps {
  profile: UserProfile;
  punches: PunchRecord[];
  isOnDuty: boolean;
}

// SHIFT_START_HOUR + FALLBACK_TARGET_H ab lib/duty.ts me hain (single source)

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// "15M" | "2H 30M" | "4H"
function fmtDur(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}H ${rm}M` : `${h}H`;
}

// floor hours for fraction display: "145H"
const fmtH = (min: number): string => `${Math.floor(min / 60)}H`;

export default function DutyTimeSection({ profile, punches, isOnDuty }: DutyTimeSectionProps) {
  const [targetH, setTargetH] = useState<number>(FALLBACK_TARGET_H);
  const [, setTick] = useState(0);

  // --- duty_targets subscribe: personal > default_{month} > default ---
  useEffect(() => {
    const mk = monthKeyOf(new Date());
    let personal: number | null = null;
    let defMonth: number | null = null;
    let defAny: number | null = null;
    const apply = () => {
      const v = personal ?? defMonth ?? defAny;
      setTargetH(v !== null && v > 0 ? v : FALLBACK_TARGET_H);
    };
    const onVal = (setter: (n: number | null) => void) => (snap: DocumentSnapshot) => {
      const data = snap.data();
      const th = data ? Number(data.targetHours) : NaN;
      setter(snap.exists() && Number.isFinite(th) && th > 0 ? th : null);
      apply();
    };
    const noopErr = () => {};
    const unsubs = [
      onSnapshot(doc(db, 'duty_targets', `${profile.uid}_${mk}`), onVal((n) => { personal = n; }), noopErr),
      onSnapshot(doc(db, 'duty_targets', `default_${mk}`), onVal((n) => { defMonth = n; }), noopErr),
      onSnapshot(doc(db, 'duty_targets', 'default'), onVal((n) => { defAny = n; }), noopErr)
    ];
    return () => unsubs.forEach((u) => u());
  }, [profile.uid]);

  // --- live tick: ON duty me chalu span har 30s me badhega ---
  useEffect(() => {
    if (!isOnDuty) return;
    // BATTERY SAVER: hidden me UI tick skip (re-render 0) — wapas visible
    // aate hi clock sahi ho jata hai.
    const t = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, 30000);
    return () => clearInterval(t);
  }, [isOnDuty]);

  // --- core calculation (lib/duty.js — ek hi source of truth, credit engine bhi isi se) ---
  const calc = useMemo(
    () => computeDutyMin(punches, isOnDuty, targetH, profile.createdAt),
    [punches, isOnDuty, targetH, profile.createdAt]
  );

  // --- display states ---
  const dayPositive = calc.dayDeltaMin >= 0.5;
  const dayNegative = calc.dayDeltaMin <= -0.5;
  const monthPositive = calc.monthDeltaMin >= 0.5;
  const monthNegative = calc.monthDeltaMin <= -0.5;

  const dayLabel = calc.firstInToday === null
    ? 'D. Overtime: 0M'
    : `D. ${dayPositive ? 'Overtime' : 'Undertime'}: ${fmtDur(Math.abs(calc.dayDeltaMin))}`;
  // zero-state bhi 'Overtime: 0M' neutral dikhe (day row jaisa) — kabhi
  // 'Undertime: 0M' nahi; red sirf REAL deficit pe
  const monthLabel = `M. ${monthNegative ? 'Undertime' : 'Overtime'}: ${fmtDur(Math.abs(calc.monthDeltaMin))}`;

  const dayFraction = `${fmtH(calc.workedTodayMin)} / ${Math.round(calc.dailyRateMin / 60)}H : D`;
  const monthFraction = `${fmtH(calc.workedMonthMin)} / ${Math.round(targetH)}H : M`;

  return (
    <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] px-5 py-4 shadow-[0_8px_24px_rgba(0,0,0,0.4)] mb-5">
      {/* Row 1 — DAY */}
      <div className="flex items-center justify-between py-1.5">
        <span className={`text-[15px] font-extrabold tracking-tight ${dayPositive ? 'text-[#34D399]' : dayNegative ? 'text-[#FB7185]' : 'text-[#8A93A6]'}`}>
          {dayLabel}
        </span>
        <span className="text-[15px] font-extrabold text-[#38BDF8]">{dayFraction}</span>
      </div>

      <div className="h-px bg-[#1D2B47]/70 my-1.5" />

      {/* Row 2 — MONTH */}
      <div className="flex items-center justify-between py-1.5">
        <span className={`text-[15px] font-extrabold tracking-tight ${monthPositive ? 'text-[#34D399]' : monthNegative ? 'text-[#FB7185]' : 'text-[#8A93A6]'}`}>
          {monthLabel}
        </span>
        <span className="text-[15px] font-extrabold text-[#38BDF8]">{monthFraction}</span>
      </div>
    </div>
  );
}
