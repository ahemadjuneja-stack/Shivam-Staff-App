// ============================================================
// GEOFENCE OUTSIDE TRACKER (Boss order 2026-10-26)
// Scenario: staff net band karke shop ke 100m radius ke bahar gaya.
// GPS ko internet NAHI chahiye — app locally record karta hai ke wo
// bahar tha kitni der. Net aane par outside_logs Firestore me khud
// sync ho jata hai (persistentLocalCache offline writes queue karta hai).
// Dashboard manager NO dabaye to Home.tsx wala listener points AUTO
// cut karta hai — koi manual credit editing nahi.
// ============================================================
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { fetchLocation } from './reporting';
import { enqueueOutbox } from './sync';
import { teleportFlag, lowAccuracyFlag } from './integrity';
import { UserProfile } from '../types';

const LS_KEY = 'shivam_outside_state_v1';
export const SAMPLE_MS = 3 * 60 * 1000; // on-duty GPS sample har 3 min
const STALE_MS = 30 * 60 * 1000; // app 30+ min band tha -> open event close
export const DEFAULT_RADIUS_M = 100; // Boss: "100 mitter" (shop_config missing ho to)

interface OutsideState {
  uid: string;
  fromAt: number; // bahar jana shuru
  lastAt: number; // aakhri outside proof
  lat: number;
  lng: number;
  flags?: string[]; // integrity: gps_teleport / gps_low_accuracy
}

// Aakhri GPS fix — duty punch me real coords ke liye (GPS offline bhi chalta hai)
let lastFix: { lat: number; lng: number; at: number } | null = null;
export function lastGpsFix(): { lat: number; lng: number; at: number } | null {
  return lastFix;
}

// Shop center: DUAL SOURCE (SYNC BUG FIX 2026-10-26):
//   1. 'config/shop'  — dashboard Settings screen ("Settings & GPS") YAHI
//      save karta hai (setDoc config/shop). Ye operational path hai.
//   2. 'shop_config/default' — Task 39 ka documented path.
// PEHLE SIRF shop_config/default padhta tha — dashboard config/shop me
// likhta tha = COLLECTION MISMATCH, manager location set kare tab bhi
// geofence kabhi active nahi hota. Ab dono check hote hain.
// Missing dono -> tracking skip (false alarm nahi chahiye).
let shopCenter: { lat: number; lng: number; radius: number } | null | undefined;
async function loadShopCenter(): Promise<{ lat: number; lng: number; radius: number } | null> {
  if (shopCenter !== undefined) return shopCenter;
  const readDoc = async (coll: string, id: string) => {
    try {
      const snap = await getDoc(doc(db, coll, id));
      if (!snap.exists()) return null;
      const lat = Number(snap.data().lat);
      const lng = Number(snap.data().lng);
      const r = Number(snap.data().radius);
      const radius = Number.isFinite(r) && r > 0 ? r : DEFAULT_RADIUS_M;
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, radius };
    } catch {
      // ignore — offline pe bhi cache se aa sakta hai
    }
    return null;
  };
  shopCenter = (await readDoc('config', 'shop')) ?? (await readDoc('shop_config', 'default'));
  return shopCenter;
}

// dono points ke beech distance (meters)
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function readState(uid: string): OutsideState | null {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const st = JSON.parse(raw) as OutsideState;
    if (st && st.uid === uid && Number(st.fromAt) > 0) return st;
  } catch {
    // ignore
  }
  return null;
}

function writeState(st: OutsideState | null) {
  try {
    if (st) window.localStorage.setItem(LS_KEY, JSON.stringify(st));
    else window.localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}

// Event close -> outside_logs me write. SYNC-GUARANTEE: write se PEHLE
// outbox journal (opId ke saath) — cache evict/app data clear ho jaye to
// bhi reconcile layer is log ko Firebase tak pohnchayegi (lib/sync.ts).
async function writeOutsideLog(uid: string, name: string, st: OutsideState, toAt: number) {
  const outsideMin = Math.max(1, Math.round((toAt - st.fromAt) / 60000));
  const opId = `ol-${uid}-${st.fromAt}`;
  const payload = {
    opId,
    uid,
    name,
    fromAt: st.fromAt,
    toAt,
    outsideMin,
    lat: st.lat,
    lng: st.lng,
    status: 'pending',
    flags: st.flags || [],
    createdAt: Date.now()
  };
  enqueueOutbox('outside_log', payload, opId); // JOURNAL FIRST
  await addDoc(collection(db, 'outside_logs'), payload).catch(() => {}); // offline = cache queue
}

// Har sample: duty ON me GPS fix lo, radius check karo, state machine chalao.
// Duty OFF -> open event turant close (log likho).
export async function sampleGeofence(profile: UserProfile, isOnDuty: boolean) {
  if (!profile.uid || profile.role === 'manager') return;
  if (!isOnDuty) {
    const st = readState(profile.uid);
    if (st) {
      writeState(null);
      await writeOutsideLog(profile.uid, profile.name, st, st.lastAt).catch(() => {});
    }
    return;
  }
  const center = await loadShopCenter();
  if (!center) return; // shop location set nahi — skip, koi false record nahi
  const loc = await fetchLocation();
  if (!loc) return; // GPS fix nahi mila is sample me
  const prevFix = lastFix;
  lastFix = { lat: loc.lat, lng: loc.lng, at: loc.at };
  const flags = [...teleportFlag(prevFix, loc), ...lowAccuracyFlag(loc.accuracy)];
  const outside = haversineM(loc.lat, loc.lng, center.lat, center.lng) > center.radius;
  const st = readState(profile.uid);
  if (outside && !st) {
    writeState({ uid: profile.uid, fromAt: loc.at, lastAt: loc.at, lat: loc.lat, lng: loc.lng, flags });
  } else if (outside && st) {
    st.lastAt = loc.at;
    st.lat = loc.lat;
    st.lng = loc.lng;
    if (flags.length) st.flags = [...(st.flags || []), ...flags.filter((f) => !(st.flags || []).includes(f))];
    writeState(st);
  } else if (!outside && st) {
    // wapas shop aaya -> event close + log
    writeState(null);
    await writeOutsideLog(profile.uid, profile.name, st, loc.at).catch(() => {});
  }
}

// Mount cleanup: app band tha, event open reh gaya, sample 30+ min purana ->
// lastAt tak ka log likho (aage naya event khud khul jayega)
export async function closeStaleOutsideEvent(profile: UserProfile) {
  const st = readState(profile.uid);
  if (st && Date.now() - st.lastAt > STALE_MS) {
    writeState(null);
    await writeOutsideLog(profile.uid, profile.name, st, st.lastAt).catch(() => {});
  }
}
