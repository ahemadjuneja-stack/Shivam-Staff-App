// ============================================================
// CREDIT POINTS ENGINE (Boss order 2026-10-25)
// 0-100 scale, account start 0, auto up/down, live display, rank-based stars.
// ============================================================
import { CreditDoc, PunchRecord } from '../types';

// Point deltas — Boss ke rules (tune karne wale: sirf yahi numbers badlo)
export const CREDIT_POINTS = {
  TASK_EARLY: 10,     // manager YES + deadline se pehle/on-time complete
  TASK_LATE: -5,      // manager YES + deadline ke baad complete
  TASK_REJECT: -10,   // manager NO (complete hone ke baad bhi NO = down)
  OUTSIDE_REJECT: -10, // outside log pe manager NO (shop ke kaam se bahar tha = auto cut)
  OUTSIDE_ONTIME: 5,  // STOPWATCH order 2026-10-26: bahar gaya, bola hua time (allowedMin) se PEHLE wapas aaya = points up
  OUTSIDE_LATE: -10,  // STOPWATCH order 2026-10-26: bola hua time me wapas NAHI aaya YA BINA BATAYE gaya = points down
  HOURS_ONTRACK: 10,  // monthly duty on-track (M. row delta >= 0)
  HOURS_BEHIND: -10   // monthly duty me peeche
} as const;

// Ek manager ek staff pe max ACTIVE (pending) tasks — Boss rule
export const MAX_ACTIVE_TASKS_PER_STAFF = 5;

export const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

// Daily credit deltas — Boss order 2026-10-26 ("har roz badlega, staff time aur
// behavior ke hisab se up/down"). Time component neeche; behavior pehle se hi
// task verify points (+10/-5/-10) se flow karta hai. Tune karne wale: sirf yahi numbers badlo.
export const CREDIT_DAILY = {
  FULL_DAY: 10,   // worked >= daily target (poore din ka duty time)
  HALF_DAY: 5,    // worked >= half daily target
  SOME_WORK: 2,   // thoda kaam hua (target se kam)
  NO_WORK: 0      // us din punch nahi (neutral — monthly hoursScore shortfall pakadta hai)
} as const;

// Ek completed din ka delta (pure — koi Firebase/React nahi)
export function dailyCreditDelta(workedMin: number, dailyTargetMin: number): number {
  if (!(workedMin > 0)) return CREDIT_DAILY.NO_WORK;
  if (dailyTargetMin > 0 && workedMin >= dailyTargetMin) return CREDIT_DAILY.FULL_DAY;
  if (dailyTargetMin > 0 && workedMin >= dailyTargetMin / 2) return CREDIT_DAILY.HALF_DAY;
  return CREDIT_DAILY.SOME_WORK;
}

// Us LOCAL calendar din ('YYYY-MM-DD') me kitne minute kaam hua — punch in->out
// pairing wahi style jo lib/duty.ts me hai. Purane din ka open 'in' ignore
// (span ka end unknown), ongoing aaj ka span sirf duty calc dekhta hai.
export function workedMinutesOnDay(punches: PunchRecord[], ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = dayStart + 86400000;
  const sorted = [...punches].sort((a, b) => a.at - b.at);
  let total = 0;
  let openIn: number | null = null;
  for (const p of sorted) {
    if (p.type === 'in') {
      openIn = p.at;
    } else if (openIn !== null) {
      const s = Math.max(openIn, dayStart);
      const e = Math.min(p.at, dayEnd);
      if (e > s) total += (e - s) / 60000;
      openIn = null;
    }
  }
  return total;
}

// Total credit = task + hours + daily (poll baad me, jab Polls feature aayega)
export function totalOf(doc: Partial<CreditDoc> | null | undefined): number {
  const t = Number(doc?.taskScore) || 0;
  const h = Number(doc?.hoursScore) || 0;
  const d = Number(doc?.dailyScore) || 0;
  return clamp100(t + h + d);
}

// Stars RANK-based (Boss: sabse zyada points = 5 stars, sabse kam = 1 star).
// totals: DESC-sorted credit totals of ALL ranked staff; uid = mera.
// rank 0 (top) -> 5 stars ... rank n-1 (bottom) -> 1 star.
export function starsFor(totalsDesc: number[], myIndex: number): number {
  const n = totalsDesc.length;
  if (n <= 1) return 5;
  const rank = Math.max(0, Math.min(n - 1, myIndex));
  return 5 - Math.round((4 * rank) / (n - 1));
}
