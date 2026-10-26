// ============================================================
// CREDIT POINTS ENGINE (Boss order 2026-10-25 + TUNE 2026-10-26)
// "points 3-4 ya 5 hi down ya up karo, 10/10 points nahi kaat sakte"
// "1 se 100 me points adjust rahe" — ek din me 10 galtiyan bhi score 0
// NAHI karega (floor 1). Scale 1-100, auto up/down, rank-based stars.
// ============================================================
import { CreditDoc, PunchRecord } from '../types';

// Point deltas — Boss rule 2026-10-26: SIRF 3-5 range me koi bhi up/down.
// (tune karne wale: sirf yahi numbers badlo, 3-5 se bahar mat jao)
export const CREDIT_POINTS = {
  TASK_EARLY: 5,      // manager YES + deadline se pehle/on-time complete = +5
  TASK_LATE: -3,      // manager YES + deadline ke baad complete = -3
  TASK_REJECT: -5,    // manager NO (complete hone ke baad bhi NO = down) = -5
  OUTSIDE_REJECT: -5, // outside log pe manager NO (shop ke kaam se bahar tha) = -5
  OUTSIDE_ONTIME: 5,  // STOPWATCH: bola hua time (allowedMin) se PEHLE wapas aaya = +5
  OUTSIDE_LATE: -4,   // STOPWATCH: bola hua time me wapas NAHI aaya = -4
  OUTSIDE_NO_NOTICE: -5, // bina bataye gaya (allowedMin set hi nahi hua) = -5
  HOURS_ONTRACK: 5,   // monthly duty on-track (M. row delta >= 0) = +5
  HOURS_BEHIND: -4    // monthly duty me peeche = -4
} as const;

// Ek manager ek staff pe max ACTIVE (pending) tasks — Boss rule
export const MAX_ACTIVE_TASKS_PER_STAFF = 5;

// BOSS RULE 2026-10-26 (Task 51): ON DUTY par har ghante ke 2 points cut.
// "On duty par har ghante ke 2 points cut karo" — sirf duty lagne se credit
// nahi badhna chahiye, kaam (tasks) karne se badhna chahiye. Deduction
// DAILY accrual me fold hota hai (punch-based workedMin se — reliable,
// app band ho to bhi hours count hote hain). Floor 1 clamp pehle jaisa hi.
export const HOURLY_ON_DUTY_CUT = -2;

// Ek completed din ke on-duty hours ka cut: floor(hours) * HOURLY_ON_DUTY_CUT
export function hourlyCutFor(workedMin: number): { delta: number; hours: number } {
  const hours = Math.floor(Math.max(0, workedMin) / 60);
  return { delta: hours * HOURLY_ON_DUTY_CUT, hours };
}

// BOSS rule 2026-10-26: score kabhi 0 nahi gir sakta — floor 1 (1-100 range).
// "Ek hi din me 10 galatiya ki to credit points 0 ho jayega — aise mat karo"
export const clamp100 = (n: number): number => Math.max(1, Math.min(100, Math.round(n)));

// Daily credit deltas — Boss order 2026-10-26 ("har roz badlega, staff time aur
// behavior ke hisab se up/down"). Time component neeche; behavior pehle se hi
// task verify points (3-5 range, Boss tune) se flow karta hai. Tune karne wale: sirf yahi numbers badlo.
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
