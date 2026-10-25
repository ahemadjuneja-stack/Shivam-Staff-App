// ============================================================
// CREDIT POINTS ENGINE (Boss order 2026-10-25)
// 0-100 scale, account start 0, auto up/down, live display, rank-based stars.
// ============================================================
import { CreditDoc } from '../types';

// Point deltas — Boss ke rules (tune karne wale: sirf yahi numbers badlo)
export const CREDIT_POINTS = {
  TASK_EARLY: 10,     // manager YES + deadline se pehle/on-time complete
  TASK_LATE: -5,      // manager YES + deadline ke baad complete
  TASK_REJECT: -10,   // manager NO (complete hone ke baad bhi NO = down)
  HOURS_ONTRACK: 10,  // monthly duty on-track (M. row delta >= 0)
  HOURS_BEHIND: -10   // monthly duty me peeche
} as const;

// Ek manager ek staff pe max ACTIVE (pending) tasks — Boss rule
export const MAX_ACTIVE_TASKS_PER_STAFF = 5;

export const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

// Total credit = task + hours (poll baad me, jab Polls feature aayega)
export function totalOf(doc: Partial<CreditDoc> | null | undefined): number {
  const t = Number(doc?.taskScore) || 0;
  const h = Number(doc?.hoursScore) || 0;
  return clamp100(t + h);
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
