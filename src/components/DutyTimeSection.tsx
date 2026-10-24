import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, DocumentSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { PunchRecord, UserProfile } from '../types';

// ============================================================
// DUTY TIME SECTION (Boss demo screenshot — TIME section only)
// Row 1: D. Overtime/Undertime (green/red) | workedToday / dailyTarget : D
// Row 2: M. Overtime/Undertime (green/red) | workedMonth / monthTarget : M
// Recovery line (month undertime pe): roz itna extra karo to target poora
//
// RULES (Boss confirmed 2026-10-25):
// - Shift start: 10:00 AM (fixed)
// - Daily OT = jaldi aana (first-in vs 10:00) + shift ke baad rukna (out/now vs shift end)
// - Daily UT = late aana (first-in vs 10:00)
// - Weekly off: KOI NAHI — saare din working (dailyTarget = monthlyTarget / daysInMonth)
// - Monthly target: dashboard/console se (duty_targets docs), fallback 235H
// - Monthly expected-by-now = dailyRate x (kal raat tak ke din)
// - Sirf worker role ko dikhta hai (sales ko nahi) — Home.tsx me gated
// ============================================================

interface DutyTimeSectionProps {
  profile: UserProfile;
  punches: PunchRecord[];
  isOnDuty: boolean;
}

const SHIFT_START_HOUR = 10; // 10:00 AM
const FALLBACK_TARGET_H = 235; // console/dashboard target na mile to

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
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [isOnDuty]);

  // --- core calculation ---
  const calc = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    const nowMs = now.getTime();

    const todayStart = new Date(y, m, d).getTime();
    const monthStart = new Date(y, m, 1).getTime();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const shiftStart = new Date(y, m, d, SHIFT_START_HOUR, 0, 0).getTime();
    const dailyRateMin = (targetH * 60) / daysInMonth; // fractional, internal exact
    const shiftEnd = shiftStart + (dailyRateMin * 60000);

    // punch pairing (asc): in->out spans; ongoing span = isOnDuty ka open 'in'
    const sorted = [...punches].sort((a, b) => a.at - b.at);
    let workedMonthMin = 0;
    let workedTodayMin = 0;
    let openIn: number | null = null;
    let firstInToday: number | null = null;
    let lastOutToday: number | null = null;

    for (const p of sorted) {
      if (p.type === 'in') {
        openIn = p.at;
        if (p.at >= todayStart && firstInToday === null) firstInToday = p.at;
      } else {
        if (openIn !== null) {
          const spanEnd = Math.max(p.at, openIn);
          const mStart = Math.max(openIn, monthStart);
          if (spanEnd > mStart) workedMonthMin += (spanEnd - mStart) / 60000;
          const dStart = Math.max(openIn, todayStart);
          if (spanEnd > dStart) workedTodayMin += (spanEnd - dStart) / 60000;
          if (p.at >= todayStart) lastOutToday = p.at;
          openIn = null;
        }
      }
    }
    // ongoing (abhi ON duty, out punch nahi hua)
    if (openIn !== null) {
      const mStart = Math.max(openIn, monthStart);
      if (nowMs > mStart) workedMonthMin += (nowMs - mStart) / 60000;
      const dStart = Math.max(openIn, todayStart);
      if (nowMs > dStart) workedTodayMin += (nowMs - dStart) / 60000;
      if (openIn < todayStart) firstInToday = firstInToday ?? todayStart; // kal se chalu span — aaj early OT nahi
    }

    // --- DAY delta: aana + jana dono (Boss rule) ---
    let dayDeltaMin = 0;
    if (firstInToday !== null) {
      if (firstInToday < shiftStart) {
        dayDeltaMin += (shiftStart - firstInToday) / 60000; // jaldi aaya = OT
      } else {
        dayDeltaMin -= (firstInToday - shiftStart) / 60000; // late = minus
      }
      if (lastOutToday !== null && lastOutToday > shiftEnd) {
        dayDeltaMin += (lastOutToday - shiftEnd) / 60000; // shift ke baad ruka = extra OT
      }
      if (isOnDuty && nowMs > shiftEnd) {
        dayDeltaMin += (nowMs - shiftEnd) / 60000; // abhi bhi shift ke baad ON hai — live extra
      }
    }

    // --- MONTH delta ---
    const expectedMin = dailyRateMin * (d - 1); // kal raat tak ka expectation
    const monthDeltaMin = workedMonthMin - expectedMin;
    const remainingMin = Math.max(0, targetH * 60 - workedMonthMin);
    const daysLeft = Math.max(1, daysInMonth - d + 1); // aaj included
    const extraPerDayMin = remainingMin / daysLeft - dailyRateMin;

    return {
      workedTodayMin,
      workedMonthMin,
      dailyRateMin,
      dayDeltaMin,
      monthDeltaMin,
      extraPerDayMin,
      daysInMonth,
      firstInToday
    };
  }, [punches, isOnDuty, targetH]);

  // --- display states ---
  const dayPositive = calc.dayDeltaMin >= 0.5;
  const dayNegative = calc.dayDeltaMin <= -0.5;
  const monthPositive = calc.monthDeltaMin >= 0.5;
  const monthNegative = calc.monthDeltaMin <= -0.5;

  const dayLabel = calc.firstInToday === null
    ? 'D. Overtime: 0M'
    : `D. ${dayPositive ? 'Overtime' : 'Undertime'}: ${fmtDur(Math.abs(calc.dayDeltaMin))}`;
  const monthLabel = `M. ${monthPositive ? 'Overtime' : 'Undertime'}: ${fmtDur(Math.abs(calc.monthDeltaMin))}`;

  const dayFraction = `${fmtH(calc.workedTodayMin)} / ${Math.round(calc.dailyRateMin / 60)}H : D`;
  const monthFraction = `${fmtH(calc.workedMonthMin)} / ${Math.round(targetH)}H : M`;

  const showRecovery = monthNegative && calc.extraPerDayMin > 1;

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

      {/* Recovery line — month undertime pe (Boss: "itna overtime karoge to target tak pohach jaoge") */}
      {showRecovery && (
        <p className="mt-2 px-0.5 text-[11px] leading-relaxed text-[#FCA5A5]/80">
          Month ke {Math.round(targetH)}H me se {fmtH(calc.workedMonthMin)} hi bhare — ab roz {fmtDur(calc.extraPerDayMin)} extra karo to target poora hoga.
        </p>
      )}
    </div>
  );
}
