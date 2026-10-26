// ============================================================
// CREDIT HISTORY (Boss order 2026-10-26, Task 51):
// "dashboard staff inventory me har naam ke sath history lagao
//  kon kon se kaam se uske points up down huwe hai"
//
// credit_points/{uid}/history subcollection — har credit event ki ek entry:
//   { type: 'task'|'outside'|'daily'|'hourly'|'hours', label, delta, at }
// Dashboard staff detail panel isi se list dikhata hai. Labels 100% English
// (dashboard pe visible). Fire-and-forget — history fail ho to score flow
// RUKNA nahi chahiye.
// ============================================================
import { addDoc, collection, doc, type Transaction } from 'firebase/firestore';
import { db } from '../firebase';

export interface CreditHistoryEntry {
  type: 'task' | 'outside' | 'daily' | 'hourly' | 'hours';
  label: string;
  delta: number;
  at: number;
}

export const historyCol = (uid: string) => collection(db, 'credit_points', uid, 'history');

// Normal (non-transaction) entry — score write ke saath parallel, fail-safe
export function logCreditHistory(uid: string, type: CreditHistoryEntry['type'], label: string, delta: number) {
  addDoc(historyCol(uid), { type, label, delta, at: Date.now() }).catch(() => {});
}

// Transaction ke andar entry — tx.set with pre-built doc ref (auto-id):
// score change aur history entry ATOMIC — ek ke bina dusra nahi.
export function txHistoryEntry(tx: Transaction, uid: string, type: CreditHistoryEntry['type'], label: string, delta: number) {
  tx.set(doc(historyCol(uid)), { type, label, delta, at: Date.now() } as CreditHistoryEntry);
}
