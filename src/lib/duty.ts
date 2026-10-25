// ============================================================
// DUTY TIME CORE CALC (extracted 2026-10-25 from DutyTimeSection)
// Ek hi source of truth: TIME section UI + credit hoursScore dono isi se.
// Pure function — koi Firebase/React nahi.
// ============================================================
import { PunchRecord } from '../types';

export const SHIFT_START_HOUR = 10; // 10:00 AM
export const FALLBACK_TARGET_H = 235; // console/dashboard target na mile to

export interface DutyCalc {
  workedTodayMin: number;
  workedMonthMin: number;
  dailyRateMin: number;
  dayDeltaMin: number;
  monthDeltaMin: number;
  expectedMin: number;
  daysInMonth: number;
  firstInToday: number | null;
}

// BASELINE RULE (Boss order 2026-10-25, 181H bug fix): expected din sirf worker
// ke system-life se (createdAt/registration), month start se NAHI. Purane
// mahine se active worker pe clamp monthStart — koi loophole nahi.
export function computeDutyMin(
  punches: PunchRecord[],
  isOnDuty: boolean,
  targetH: number,
  createdAtMs: number,
  now: Date = new Date()
): DutyCalc {
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

  // --- MONTH delta (baseline = system-life start) ---
  const createdAt = Number(createdAtMs) || 0;
  const regDayStart = createdAt > 0 ? new Date(createdAt).setHours(0, 0, 0, 0) : monthStart;
  const effBaseline = Math.max(monthStart, regDayStart);
  const expectedDays = Math.max(0, Math.round((todayStart - effBaseline) / 86400000));
  const expectedMin = dailyRateMin * expectedDays; // kal raat tak ka expectation (baseline se)
  const monthDeltaMin = workedMonthMin - expectedMin;

  return {
    workedTodayMin,
    workedMonthMin,
    dailyRateMin,
    dayDeltaMin,
    monthDeltaMin,
    expectedMin,
    daysInMonth,
    firstInToday
  };
}
