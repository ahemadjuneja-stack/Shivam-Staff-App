// ============================================================
// TOUR HISAB — SALESMAN SIDE (Task 93, Boss order 2026-10-28)
// "Dashboard se tour paste hoga... Line Schedule ke niche box
//  dikhna chahiye jiske niche Porbandar likha hoga... click krega
//  to new screen khulegi jisme sare city ke names hoge aur Salesman
//  waha se hisab likhega — GR, less, kitna paisa diya... aur jama
//  bhi usi ke hone chahiye jisme salesman ne jama kiye ho."
//
// DATA:
//   tours/{tourId}            — dashboard se bana (parseTourPaste)
//   tours/{tourId}/hisab/{uid}— salesman ka bhara hisab (YE FILE likhti hai)
//     entries.{shopKey} = { shopKey, cityName, shopCode, shopName,
//                           grP, lessP, paidP, mode, note?, at }
//     deposits[] = { at, amtP, mode, place, note? }  (arrayUnion — atomic)
//
// MONEY: real ₹ input -> integer paise (Boss rule: Tour Hisab = real rupees).
// Pure functions node-testable: totalsOf / parseMoneyInput / fmtMoney /
// tourLiteOf (scripts/test_tourHisab.ts).
// ============================================================
import { arrayUnion, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export interface TourCityLite {
  name: string;
  shops: number;
}
export interface TourLite {
  id: string;
  name: string;
  date?: string;
  cities: TourCityLite[];
  shopCount: number;
  createdAt: number;
}

// shop-wise hisab entry (salesman bharta hai)
export interface TourShopEntry {
  shopKey: string;
  cityName: string;
  shopCode: string;
  shopName: string;
  grP: number;    // GR / R.Goods (return goods value)
  lessP: number;  // less / discount diya
  paidP: number;  // kitna paisa diya
  mode: number;   // 1=Cash 2=UPI 3=Cheque
  note?: string;
  at: number;
}

// jama (deposit) — "jama bhi usi ke hone chahiye jisme salesman ne jama kiye ho"
export interface TourDeposit {
  at: number;
  amtP: number;
  mode: number;   // 1=Cash 2=UPI 3=Cheque
  place: string;  // KAHA jama kiya ('JND T. T shop')
  note?: string;
}

export interface TourHisabDoc {
  uid: string;
  name: string;
  updatedAt: number;
  entries?: Record<string, TourShopEntry>;
  deposits?: TourDeposit[];
}

export const MODES: { id: number; label: string }[] = [
  { id: 1, label: 'Cash' },
  { id: 2, label: 'UPI' },
  { id: 3, label: 'Cheque' }
];
export const modeLabel = (m: number): string =>
  MODES.find((x) => x.id === m)?.label || '—';

// ---------- money (real ₹) ----------

/** "3456" / "3,456.50" -> paise ; galat -> null */
export function parseMoneyInput(s: string): number | null {
  const t = (s || '').trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}

/** paise -> "₹12,450" (paise ho to 2 decimal) */
export function fmtMoney(p: number): string {
  if (!Number.isFinite(p)) return '₹0';
  const sign = p < 0 ? '-' : '';
  const a = Math.abs(p);
  const hasP = a % 100 !== 0;
  return (
    sign +
    '₹' +
    (a / 100).toLocaleString('en-IN', {
      minimumFractionDigits: hasP ? 2 : 0,
      maximumFractionDigits: 2
    })
  );
}

// ---------- writes ----------

/** ek shop ki hisab save (upsert) — deterministic path entries.{shopKey} */
export async function saveShopEntry(
  tourId: string,
  uid: string,
  name: string,
  e: TourShopEntry
): Promise<void> {
  await setDoc(
    doc(db, 'tours', tourId, 'hisab', uid),
    {
      uid,
      name,
      updatedAt: Date.now(),
      [`entries.${e.shopKey}`]: JSON.parse(JSON.stringify(e))
    },
    { merge: true }
  );
}

/** jama add — arrayUnion = atomic append (do device se bhi safe) */
export async function addDeposit(
  tourId: string,
  uid: string,
  name: string,
  d: TourDeposit
): Promise<void> {
  await setDoc(
    doc(db, 'tours', tourId, 'hisab', uid),
    {
      uid,
      name,
      updatedAt: Date.now(),
      deposits: arrayUnion(JSON.parse(JSON.stringify(d)))
    },
    { merge: true }
  );
}

// ---------- pure aggregation ----------

export interface HisabTotals {
  paidP: number;
  cashP: number;
  upiP: number;
  cheqP: number;
  grP: number;
  lessP: number;
  jamaP: number;
  haathP: number; // cash - jama (haath me bacha)
  filled: number; // kitni shops ki hisab bhari
}

export function totalsOf(
  entries: Record<string, TourShopEntry> | undefined,
  deposits: TourDeposit[] | undefined
): HisabTotals {
  let paidP = 0, cashP = 0, upiP = 0, cheqP = 0, grP = 0, lessP = 0, filled = 0;
  const es = entries || {};
  for (const k of Object.keys(es)) {
    const e = es[k];
    if (!e) continue;
    filled++;
    paidP += e.paidP || 0;
    grP += e.grP || 0;
    lessP += e.lessP || 0;
    if (e.mode === 2) upiP += e.paidP || 0;
    else if (e.mode === 3) cheqP += e.paidP || 0;
    else cashP += e.paidP || 0;
  }
  let jamaP = 0;
  for (const d of deposits || []) jamaP += d.amtP || 0;
  return { paidP, cashP, upiP, cheqP, grP, lessP, jamaP, haathP: cashP - jamaP, filled };
}

/** dashboard ka tour doc -> Home box ke liye lite (kisi bhi shape pe tolerant) */
export function tourLiteOf(id: string, v: Record<string, unknown> | undefined): TourLite | null {
  if (!v) return null;
  if (v.active === false) return null;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) return null;
  const citiesRaw = Array.isArray(v.cities) ? v.cities : [];
  const cities: TourCityLite[] = [];
  for (const c of citiesRaw as Array<Record<string, unknown>>) {
    const cn = typeof c?.name === 'string' ? c.name : '';
    if (!cn) continue;
    cities.push({ name: cn, shops: Array.isArray(c?.shops) ? c.shops.length : 0 });
  }
  return {
    id,
    name,
    date: typeof v.date === 'string' ? v.date : undefined,
    cities,
    shopCount: cities.reduce((a, c) => a + c.shops, 0),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0
  };
}
