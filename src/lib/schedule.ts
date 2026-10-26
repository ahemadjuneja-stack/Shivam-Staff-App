// ============================================================
// LINE SCHEDULE (Boss order 2026-10-27):
// "salesman apne LINE SCHEDULE likh sake usme City ka naam aur ek side date
//  likhni hogi... dashboard se monthly SCHEDULE diye jayge home page par
//  apne aap city names showing hone chahiye"
//
// DATA MODEL — collection `line_schedule` (dashboard Tours page bhi isi ko
// padhta hai + likhta hai):
//   id:   lsch-{uid}-{date}-{citykey}  (deterministic — same date+city ka
//         duplicate IMPOSSIBLE, re-upload = overwrite)
//   data: { uid, name, phone?, date:'YYYY-MM-DD', city, cityKey, month,
//           source:'self'|'dashboard', createdBy?, createdAt, updatedAt?,
//           cityLat?, cityLng? }
// Rules open hain (Task 49) — staff app + dashboard dono likh sakte hain.
// ============================================================
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export const cityKeyOf = (city: string): string =>
  (city || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const monthOfDate = (date: string): string => (date || '').slice(0, 7);

export const scheduleDocId = (uid: string, date: string, cityKey: string): string =>
  `lsch-${uid}-${date}-${cityKey.replace(/[^a-z0-9]+/g, '')}`.slice(0, 140);

export interface UpsertScheduleInput {
  uid: string;
  name: string;
  phone?: string;
  date: string; // 'YYYY-MM-DD'
  city: string;
  source: 'self' | 'dashboard';
  createdBy?: string;
  cityLat?: number;
  cityLng?: number;
}

// Deterministic id = upsert (duplicate entry kabhi nahi banti)
export async function upsertScheduleEntry(inp: UpsertScheduleInput): Promise<string> {
  const cityKey = cityKeyOf(inp.city);
  const id = scheduleDocId(inp.uid, inp.date, cityKey);
  const payload: Record<string, unknown> = {
    uid: inp.uid,
    name: inp.name,
    date: inp.date,
    city: inp.city.trim(),
    cityKey,
    month: monthOfDate(inp.date),
    source: inp.source,
    createdAt: Date.now()
  };
  if (inp.phone) payload.phone = inp.phone;
  if (inp.createdBy) payload.createdBy = inp.createdBy;
  if (typeof inp.cityLat === 'number') payload.cityLat = inp.cityLat;
  if (typeof inp.cityLng === 'number') payload.cityLng = inp.cityLng;
  await setDoc(doc(db, 'line_schedule', id), payload, { merge: true });
  return id;
}

export async function removeScheduleEntry(id: string): Promise<void> {
  await deleteDoc(doc(db, 'line_schedule', id));
}
