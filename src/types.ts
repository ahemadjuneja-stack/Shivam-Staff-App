// 'manager' = dashboard se manager access mila (Boss order 2026-10-25: tasks assign/verify).
// Firestore 'manager' | 'admin' dono is role me normalize hote hain (Auth/App maps).
export type UserRole = 'worker' | 'sales' | 'manager';
export type UserStatus = 'pending' | 'active' | 'rejected';

export interface UserProfile {
  uid: string;
  name: string;
  mobile: string;
  city: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  approvedAt?: number;
}

// TASK SYSTEM (Boss order 2026-10-25):
// - Manager dashboard se manager access lekar tasks assign karta hai
// - Task SIRF usi staff ko dikhta hai jisko diya (toUid query); verify SIRF wahi manager (byUid)
// - Ek manager ek staff ko max 5 ACTIVE task de sakta hai (pending count se block, popup)
// - Verify tap -> English dialog "Is this task complete?" Yes/No
//   Yes + deadline se pehle/on-time -> +10 | Yes + late -> -5 | No -> -10 (credit)
export interface Task {
  id?: string;
  title: string;
  byUid: string;        // kisne diya (manager uid)
  byName: string;
  toUid: string;        // kisko diya (staff uid)
  toName: string;
  startAt: number;      // start date (local midnight ms)
  days: number;         // kitne din me khatam hoga
  deadlineAt: number;   // end-of-day ms (start + days)
  status: 'pending' | 'completed' | 'rejected';
  createdAt: number;    // assign time
  verifiedAt?: number;  // manager verify time (= completion proxy)
  pointsDelta?: number; // credit me gaya delta (+10/-5/-10)
}

// CREDIT POINTS (Boss order 2026-10-25): 0-100, account banne par 0.
// taskScore: verify deltas ka sum (transaction se atomic). hoursScore: monthly
// duty on-track (+10) / peeche (-10) — staff ke apne app se update hota hai.
// dailyScore: har completed din ka duty-time delta (Boss order 2026-10-26) —
// catch-up accrual lastCreditDay ke through dedupe hota hai ('YYYY-MM-DD').
// Total = clamp(taskScore + hoursScore + dailyScore, 0, 100), live dikhta hai.
// Stars RANK-based: sabse zyada total = 5 stars, sabse kam = 1 star.
export interface CreditDoc {
  uid?: string;
  taskScore: number;
  hoursScore: number;
  dailyScore?: number;
  lastCreditDay?: string;
  updatedAt?: number;
}

export interface ShopConfig {
  name: string;
  lat: number;
  lng: number;
  radius: number;
  shiftStart: string;
}

// Monthly duty target — dashboard/console se set hota hai (Boss order: TIME section)
// Doc ids: duty_targets/{uid}_{YYYY-MM} | duty_targets/default_{YYYY-MM} | duty_targets/default
export interface DutyTarget {
  uid?: string;
  month?: string;
  targetHours: number;
  updatedAt?: number;
}

export interface PunchRecord {
  id?: string;
  uid: string;
  name: string;
  type: 'in' | 'out';
  at: number;
  lat: number;
  lng: number;
  dist: number;
}

export interface WorkLog {
  id?: string;
  uid: string;
  name: string;
  date: string;
  text: string;
  status: 'pending' | 'approved' | 'rejected';
  at: number;
  verifiedAt?: number;
}

export type StarEventType = 'verify' | 'reject' | 'manual' | 'violation' | 'full-week' | 'on-time' | 'late';

export interface StarEvent {
  id?: string;
  uid: string;
  type: StarEventType;
  delta: number;
  note: string;
  at: number;
}

export interface ViolationRecord {
  id?: string;
  uid: string;
  at: number;
  kind: 'location-off';
  reason: string;
}

export interface Sheet {
  id: string;
  month: string;
  city: string;
  assignedTo: string;
  assignedName: string;
  status: 'active' | 'closed';
  createdAt: number;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  opening: number;
  balance: number;
  updatedAt?: number;
}

export interface CustomerBill {
  id: string;
  date: string;
  no: string;
  amount: number;
}

export type EntryKind = 'jama' | 'kharcha';
export type PaymentMode = 1 | 2 | 3; // 1 = Cash, 2 = UPI, 3 = Cheque

export interface LedgerEntry {
  id?: string;
  kind: EntryKind;
  cid?: string;
  cname?: string;
  amount: number;
  cash?: number;
  less?: number;
  rgoods?: number;
  mode: PaymentMode;
  note?: string;
  byUid: string;
  byName: string;
  at: number;
  lat?: number;
  lng?: number;
  miracle: boolean;
}
