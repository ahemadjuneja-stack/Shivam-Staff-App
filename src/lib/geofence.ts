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
}

// Aakhri GPS fix — duty punch me real coords ke liye (GPS offline bhi chalta hai)
let lastFix: { lat: number; lng: number } | null = null;
export function lastGpsFix(): { lat: number; lng: number } | null {
  return lastFix;
}

// Shop center: shop_config/default (lat, lng, radius). Manager dashboard se
// set karega. Missing -> tracking skip (false alarm nahi chahiye).
let shopCenter: { lat: number; lng: number; radius: number } | null | undefined;
async function loadShopCenter(): Promise<{ lat: number; lng: number; radius: number } | null> {
  if (shopCenter !== undefined) return shopCenter;
  try {
    const snap = await getDoc(doc(db, 'shop_config', 'default'));
    if (snap.exists()) {
      const lat = Number(snap.data().lat);
      const lng = Number(snap.data().lng);
      const r = Number(snap.data().radius);
      const radius = Number.isFinite(r) && r > 0 ? r : DEFAULT_RADIUS_M;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        shopCenter = { lat, lng, radius };
        return shopCenter;
      }
    }
  } catch {
    // ignore — offline pe bhi cache se aa sakta hai
  }
  shopCenter = null;
  return null;
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

// Event close -> outside_logs me write (persistent cache: offline me bhi
// queue hota hai, net aate hi dashboard ko dikhega — koi throw nahi)
async function writeOutsideLog(uid: string, name: string, st: OutsideState, toAt: number) {
  const outsideMin = Math.max(1, Math.round((toAt - st.fromAt) / 60000));
  await addDoc(collection(db, 'outside_logs'), {
    uid,
    name,
    fromAt: st.fromAt,
    toAt,
    outsideMin,
    lat: st.lat,
    lng: st.lng,
    status: 'pending',
    createdAt: Date.now()
  });
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
  lastFix = { lat: loc.lat, lng: loc.lng };
  const outside = haversineM(loc.lat, loc.lng, center.lat, center.lng) > center.radius;
  const st = readState(profile.uid);
  if (outside && !st) {
    writeState({ uid: profile.uid, fromAt: loc.at, lastAt: loc.at, lat: loc.lat, lng: loc.lng });
  } else if (outside && st) {
    st.lastAt = loc.at;
    st.lat = loc.lat;
    st.lng = loc.lng;
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
