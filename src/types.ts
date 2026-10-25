// 'admin' = Boss — dashboard features (Duty Targets set etc.) sirf isko dikhte hain
export type UserRole = 'worker' | 'sales' | 'admin';
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
