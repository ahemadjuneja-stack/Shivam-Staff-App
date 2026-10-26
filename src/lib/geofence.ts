// ============================================================
// GEOFENCE OUTSIDE TRACKER (Boss order 2026-10-26)
// Scenario: staff net band karke shop ke 100m radius ke bahar gaya.
// GPS ko internet NAHI chahiye — app locally record karta hai ke wo
// bahar tha kitni der. Net aane par outside_logs Firestore me khud
// sync ho jata hai (persistentLocalCache offline writes queue karta hai).
// Dashboard manager NO dabaye to Home.tsx wala listener points AUTO
// cut karta hai — koi manual credit editing nahi.
// ============================================================
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { fetchLocation } from './reporting';
import { enqueueOutbox } from './sync';
import { teleportFlag, lowAccuracyFlag } from './integrity';
import { UserProfile } from '../types';

const LS_KEY = 'shivam_outside_state_v1';
export const SAMPLE_MS = 3 * 60 * 1000; // on-duty GPS sample har 3 min
const STALE_MS = 30 * 60 * 1000; // app 30+ min band tha -> open event close
export const DEFAULT_RADIUS_M = 100; // Boss: "100 mitter"

// ============================================================
// BOSS-LOCKED SHOP CENTER (2026-10-26) — "Hamare shop ka exect location
// ye hai... Aur koi nahi dena" — Google Maps link se exact coords:
// Shivam Store, Pushpak Plaza, Shopping Centre, Mangnath Rd, near
// Shriram Temple, Junagadh, Gujarat 362001.
// YE AUTHORITATIVE CENTER HAI — remote config ka lat/lng AB IGNORE
// (kisi aur location se geofence nahi chalega, galti/chaal dono band).
// Radius hi config se aa sakta hai (operational tuning), center kabhi nahi.
// ============================================================
export const SHOP_CENTER_LOCKED = { lat: 21.5191279, lng: 70.4621545 } as const;
export const SHOP_ADDRESS_LOCKED = 'Shivam Store, Pushpak Plaza, Mangnath Rd, Junagadh, Gujarat 362001';

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

// Shop center: BOSS-LOCKED coords (SHOP_CENTER_LOCKED) — hamesha available,
// OFFLINE me bhi. ZERO-NET (Boss order 2026-10-26: "net slowly chal raha ho
// tab bhi open hona chahiye"): center + default radius TURANT return hote
// hain — location gate kabhi Firestore ka wait NAHI karta (pehle radius
// getDoc await gate ko slow net par rok deta tha). Config radius BACKGROUND
// me aata hai — wahi object mutate hota hai, isliye gate ka centerRef bhi
// fresh radius khud dekh leta hai (koi re-fetch nahi). Lat/lng config se
// KABHI nahi leta (Boss: "Aur koi nahi dena" — center permanently locked).
let shopCenter: { lat: number; lng: number; radius: number } | undefined;
async function loadShopCenter(): Promise<{ lat: number; lng: number; radius: number }> {
  if (shopCenter !== undefined) return shopCenter;
  shopCenter = { lat: SHOP_CENTER_LOCKED.lat, lng: SHOP_CENTER_LOCKED.lng, radius: DEFAULT_RADIUS_M };
  getDoc(doc(db, 'config', 'shop'))
    .then((snap) => {
      if (!snap.exists() || !shopCenter) return;
      const r = Number(snap.data().radius);
      if (Number.isFinite(r) && r >= 20 && r <= 1000) shopCenter.radius = r;
    })
    .catch(() => {
      /* offline / slow net — locked center + default radius se kaam chalta hai */
    });
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

// OUTSIDE EVENT = TWO-PHASE Firestore write (LIVE POPUP order 2026-10-26):
//   OPEN  -> doc 'ol-{uid}-{fromAt}' {status:'open', fromAt, lat, lng} — dashboard
//            manager ko REAL-TIME popup + per-staff LIVE stopwatch (inventory me)
//   CLOSE -> same doc merge {toAt, outsideMin, status:'pending'} — auto points
//            compare (allowedMin) staff app listener me hota hai
// Custom doc ID se dono phases idempotent — offline queue/retry se duplicate
// kabhi nahi banega. SYNC-GUARANTEE: dono phases outbox journal me PEHLE
// (opId ke saath) — cache evict/app clear par bhi reconcile Firebase tak
// pohnchayega (lib/sync.ts).
const openDocId = (uid: string, fromAt: number) => `ol-${uid}-${fromAt}`;

function openOutsideEvent(uid: string, name: string, st: OutsideState) {
  const docId = openDocId(uid, st.fromAt);
  const payload = {
    opId: `open-${docId}`,
    uid,
    name,
    fromAt: st.fromAt,
    lat: st.lat,
    lng: st.lng,
    status: 'open' as const,
    flags: st.flags || [],
    createdAt: Date.now()
  };
  enqueueOutbox('outside_log', payload, `open-${docId}`); // JOURNAL FIRST
  setDoc(doc(db, 'outside_logs', docId), payload, { merge: true }).catch(() => {});
}

async function closeOutsideEvent(uid: string, name: string, st: OutsideState, toAt: number) {
  const docId = openDocId(uid, st.fromAt);
  const outsideMin = Math.max(1, Math.round((toAt - st.fromAt) / 60000));
  const payload = {
    opId: `close-${docId}`,
    uid,
    name,
    fromAt: st.fromAt,
    toAt,
    outsideMin,
    lat: st.lat,
    lng: st.lng,
    status: 'pending' as const,
    flags: st.flags || [],
    closedAt: Date.now()
  };
  enqueueOutbox('outside_log', payload, `close-${docId}`); // JOURNAL FIRST
  await setDoc(doc(db, 'outside_logs', docId), payload, { merge: true }).catch(() => {}); // offline = cache queue
}

// ---- LOCATION GATE helpers (Boss order: app open par 100m check) ----
// Gate ka GPS fix bhi punch coords ke liye lastFix me note hota hai
export function noteGpsFix(lat: number, lng: number, at: number) {
  lastFix = { lat, lng, at };
}

export async function getShopCenter(): Promise<{ lat: number; lng: number; radius: number }> {
  return loadShopCenter(); // LOCKED center + config radius — kabhi null nahi
}

export function distanceToShopM(lat: number, lng: number, center: { lat: number; lng: number }): number {
  return haversineM(lat, lng, center.lat, center.lng);
}

// Har sample: duty ON me GPS fix lo, radius check karo, state machine chalao.
// Bahar open event ka FireStore doc TURANT likha jata hai (status 'open') —
// dashboard popup + stopwatch live. Duty OFF -> open event turant close.
export async function sampleGeofence(profile: UserProfile, isOnDuty: boolean) {
  if (!profile.uid || profile.role === 'manager') return;
  if (!isOnDuty) {
    const st = readState(profile.uid);
    if (st) {
      writeState(null);
      await closeOutsideEvent(profile.uid, profile.name, st, st.lastAt).catch(() => {});
    }
    return;
  }
  const center = await loadShopCenter(); // LOCKED center — kabhi null nahi
  const loc = await fetchLocation();
  if (!loc) return; // GPS fix nahi mila is sample me
  const prevFix = lastFix;
  lastFix = { lat: loc.lat, lng: loc.lng, at: loc.at };
  const flags = [...teleportFlag(prevFix, loc), ...lowAccuracyFlag(loc.accuracy)];
  const outside = haversineM(loc.lat, loc.lng, center.lat, center.lng) > center.radius;
  const st = readState(profile.uid);
  if (outside && !st) {
    const fresh = { uid: profile.uid, fromAt: loc.at, lastAt: loc.at, lat: loc.lat, lng: loc.lng, flags };
    writeState(fresh);
    openOutsideEvent(profile.uid, profile.name, fresh); // LIVE popup doc
  } else if (outside && st) {
    st.lastAt = loc.at;
    st.lat = loc.lat;
    st.lng = loc.lng;
    if (flags.length) st.flags = [...(st.flags || []), ...flags.filter((f) => !(st.flags || []).includes(f))];
    writeState(st);
  } else if (!outside && st) {
    // wapas shop aaya -> event close + log
    writeState(null);
    await closeOutsideEvent(profile.uid, profile.name, st, loc.at).catch(() => {});
  }
}

// Mount cleanup: app band tha, event open reh gaya, sample 30+ min purana ->
// lastAt tak ka log likho (aage naya event khud khul jayega)
export async function closeStaleOutsideEvent(profile: UserProfile) {
  const st = readState(profile.uid);
  if (st && Date.now() - st.lastAt > STALE_MS) {
    writeState(null);
    await closeOutsideEvent(profile.uid, profile.name, st, st.lastAt).catch(() => {});
  }
}
