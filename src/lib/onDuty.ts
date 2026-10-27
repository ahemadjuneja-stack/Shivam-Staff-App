// ============================================================
// MANAGER ON-DUTY LIVE BOARD (Boss order 2026-10-28):
// "Manager role me niche jitne bhi staff duty par ho unka naam aur
//  location niche showing hona chahiye — jo salesman jaha se location
//  app on kare manager ke app me GREEN TICK ke sath showing hona chahiye"
//
// DESIGN (100% READ-ONLY — koi salesman-side change nahi, battery ZERO impact):
//   Data pehle se flow kar raha hai (v75/v76 native engine):
//     - SALES: native LocationTrackService har fix par likhta hai
//         users/{uid}.lastLocation {lat,lng,at,accuracy?} + lastSeenAt
//         staff_attendance/{uid}.isOnDuty (location ON = duty ON auto)
//     - WORKER: JS reportDeviceAndLocation 5-min me lastLocation+lastSeenAt
//         likhta hai; duty manual toggle se staff_attendance.isOnDuty
//   Manager app sirf padhta hai:
//     - staff_attendance where isOnDuty==true  -> kaun duty par hai
//     - users (active worker/sales)            -> naam/DP/location/lastSeen
//     - line_schedule (is month)               -> city coords (nearest-city)
//
// GREEN TICK RULE:
//   fresh = lastLocation hai && lastSeenAt FRESH_WINDOW_MS ke andar
//   (STILL mode me native users-patch ka max gap 8 min hai — 4min STILL
//   interval x USERLOC_EVERY 2 — isliye 12 min green window: engine zinda
//   hai to GREEN hamesha, service/app band = stale (amber) — honest signal)
//
// CITY LABEL: lastLocation ko is month ke schedule cities (cityLat/cityLng,
// Nominatim-geocoded) se nearest match (<=40km) — mila to city naam, warna
// compact coords (22.30, 70.80). Ghar-city ka andaza lagana MANA hai —
// galat naam dikhana coords se bura hai.
// Pure functions — koi Firebase/React nahi (node-testable).
// ============================================================

export const FRESH_WINDOW_MS = 12 * 60 * 1000; // green tick window (upar wala logic)
export const NEAREST_CITY_RADIUS_M = 40000; // 40km — city center se itna door = nahi hai

export interface CityCoord {
  key: string; // cityKey lowercase — dedupe
  city: string;
  lat: number;
  lng: number;
}

export interface DutyUserMeta {
  uid: string;
  name: string;
  role: 'worker' | 'sales';
  photo?: string;
  city?: string; // users.city (home base — sirf fallback text, coords nahi)
  lastLocation?: { lat: number; lng: number; at?: number; accuracy?: number };
  lastSeenAt?: number;
}

export interface OnDutyRow {
  uid: string;
  name: string;
  role: 'worker' | 'sales';
  photo?: string;
  label: string;      // location line: "Bhuj" | "22.30, 70.80" | "Location nahi mili"
  matched: boolean;   // city name mila (coords fallback nahi)
  lastAt: number;     // lastSeenAt ms (0 = nahi pata)
  fresh: boolean;     // GREEN TICK
  onDuty: boolean;    // staff_attendance isOnDuty (v2: sab active staff dikhenge — Boss order 2026-10-28)
}

// minimal structural types (pure lib — Firestore/React se independent)
export interface PunchLike { type: string; at: number }
export interface OutsideLogLike {
  fromAt: number;
  toAt?: number;
  status: string;          // open | pending | approved | rejected
  allowedMin?: number;     // STOPWATCH — manager ne bola hua time = authorized errand
}

// Haversine — meters me do lat/lng ke beech distance
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// lastLocation ke sabse paas wala city (radius ke andar) — nahi to null
export function nearestCity(lat: number, lng: number, cities: CityCoord[], radiusM: number = NEAREST_CITY_RADIUS_M): CityCoord | null {
  let best: CityCoord | null = null;
  let bestD = Infinity;
  for (const c of cities) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const d = haversineM(lat, lng, c.lat, c.lng);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best && bestD <= radiusM ? best : null;
}

// "abhi" | "5m" | "1h 12m" | "3h"
export function fmtAgo(at: number, now: number): string {
  if (!at || at > now) return 'abhi';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 90) return 'abhi';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

// MAIN: SAB ACTIVE staff -> live rows (Boss order 2026-10-28: "sirf 3 nahi —
// jitne bhi staff active ho sab dikhne chahiye") — duty ON + duty OFF dono.
// Sort: pinned pehle (manager pin), phir duty-ON fresh, duty-ON stale, duty-OFF;
// andar lastSeenAt desc, phir naam.
export function computeStaffRows(
  users: DutyUserMeta[],
  dutyOnUids: Record<string, string>,
  cities: CityCoord[],
  now: number,
  excludeUid: string = '',
  pinnedUids: string[] = []
): OnDutyRow[] {
  const rows: OnDutyRow[] = [];
  for (const u of users) {
    if (!u || !u.uid || u.uid === excludeUid) continue;
    if (u.role !== 'worker' && u.role !== 'sales') continue;
    const onDuty = dutyOnUids[u.uid] !== undefined;

    const loc = u.lastLocation;
    const hasLoc = !!(loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
    const seenAt = Number(u.lastSeenAt) || (loc && loc.at ? Number(loc.at) : 0);
    const fresh = onDuty && hasLoc && seenAt > 0 && now - seenAt <= FRESH_WINDOW_MS;

    let label = 'Location nahi mili';
    let matched = false;
    if (hasLoc) {
      const c = nearestCity(loc!.lat, loc!.lng, cities);
      if (c) {
        label = c.city;
        matched = true;
      } else {
        label = `${loc!.lat.toFixed(2)}, ${loc!.lng.toFixed(2)}`;
      }
    }

    rows.push({
      uid: u.uid,
      name: (u.name || dutyOnUids[u.uid] || 'Staff').trim(),
      role: u.role,
      photo: typeof u.photo === 'string' && u.photo ? u.photo : undefined,
      label: onDuty ? label : label, // off-duty me bhi last-known dikhao (gray context)
      matched,
      lastAt: seenAt,
      fresh,
      onDuty
    });
  }
  const pinSet = new Set(pinnedUids);
  rows.sort((a, b) => {
    const ap = pinSet.has(a.uid) ? 0 : 1;
    const bp = pinSet.has(b.uid) ? 0 : 1;
    if (ap !== bp) return ap - bp; // pinned sabse upar
    const ad = a.onDuty ? 0 : 1;
    const bd = b.onDuty ? 0 : 1;
    if (ad !== bd) return ad - bd; // duty ON pehle
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1; // green tick upar
    if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt; // naya update pehle
    return a.name.localeCompare(b.name);
  });
  return rows;
}

// Sirf duty-par rows (v1 board behavior — ab computeStaffRows use hota hai,
// wrapper compatibility ke liye raha)
export function computeOnDutyRows(
  users: DutyUserMeta[],
  dutyOnUids: Record<string, string>,
  cities: CityCoord[],
  now: number,
  excludeUid: string = ''
): OnDutyRow[] {
  return computeStaffRows(users, dutyOnUids, cities, now, excludeUid).filter((r) => r.onDuty);
}

// ---------- WORKER DETAIL (Boss order 2026-10-28: "kitne baje duty par aaya,
// kab duty off ki, on duty kitni der") — aaj ke punches ka pairing summary ----------
export interface PunchSummary {
  firstIn: number | null;   // aaj ka pehla IN (kitne baje aaya)
  lastOut: number | null;   // aaj ka aakhri OUT (kab duty off ki)
  openIn: number | null;    // abhi ON hai to open IN (null = OFF)
  workedMin: number;        // aaj total on-duty minutes
}
export function summarizePunchesToday(punches: PunchLike[], now: number): PunchSummary {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const todays = punches
    .filter((p) => p && p.at >= dayStart)
    .sort((a, b) => a.at - b.at);
  let firstIn: number | null = null;
  let lastOut: number | null = null;
  let openIn: number | null = null;
  let workedMin = 0;
  for (const p of todays) {
    if (p.type === 'in') {
      if (firstIn === null) firstIn = p.at;
      openIn = p.at; // re-in pair reset (duplicate-in guard: purana open replace)
    } else {
      if (openIn !== null) {
        workedMin += Math.max(0, p.at - openIn) / 60000;
        lastOut = p.at;
        openIn = null;
      }
    }
  }
  if (openIn !== null) workedMin += Math.max(0, now - openIn) / 60000;
  return { firstIn, lastOut, openIn, workedMin };
}

// ---------- SALES BANNER (Boss: "2 din se location on nahi kiya to dikhna
// chahiye k location 2 din purana hai ya 1 din purana") — CALENDAR days ----------
export function daysSinceOn(lastOnAt: number, now: number): number {
  if (!lastOnAt || lastOnAt > now) return 0;
  const a = new Date(lastOnAt).setHours(0, 0, 0, 0);
  const b = new Date(now).setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b - a) / 86400000));
}

// "5:08 PM" — detail screen ke time labels
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

// ---------- OUTSIDE FILTER (Boss: "dukan ke kaam se gaya tha to nahi dikhna
// chahiye, agar bina bataye gaya tabhi show hona chahiye") ----------
// HIDE: approved (manager ne haan boli) YA allowedMin set (STOPWATCH — manager
// ne khud bola kitni der bahar) = dukan ke kaam / authorized errand.
// SHOW: open/pending/rejected bina allowedMin ke = bina bataye / decision wait.
export function isUnannouncedOutside(l: OutsideLogLike): boolean {
  if (!l) return false;
  if (l.status === 'approved') return false;
  if (typeof l.allowedMin === 'number' && l.allowedMin > 0) return false;
  return l.status === 'open' || l.status === 'pending' || l.status === 'rejected';
}
