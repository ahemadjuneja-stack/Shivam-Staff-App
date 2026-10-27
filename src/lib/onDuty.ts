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

// MAIN: duty par log -> live rows (fresh pehle, phir naya update, phir naam)
export function computeOnDutyRows(
  users: DutyUserMeta[],
  dutyOnUids: Record<string, string>, // uid -> attendance name (fallback)
  cities: CityCoord[],
  now: number,
  excludeUid: string = '' // manager khud board par nahi
): OnDutyRow[] {
  const rows: OnDutyRow[] = [];
  for (const u of users) {
    if (!u || !u.uid || u.uid === excludeUid) continue;
    if (u.role !== 'worker' && u.role !== 'sales') continue;
    if (dutyOnUids[u.uid] === undefined) continue; // duty OFF/absent = list me nahi

    const loc = u.lastLocation;
    const hasLoc = !!(loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
    const seenAt = Number(u.lastSeenAt) || (loc && loc.at ? Number(loc.at) : 0);
    const fresh = hasLoc && seenAt > 0 && now - seenAt <= FRESH_WINDOW_MS;

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
      label,
      matched,
      lastAt: seenAt,
      fresh
    });
  }
  rows.sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1; // green tick sabse upar
    if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt; // naya update pehle
    return a.name.localeCompare(b.name);
  });
  return rows;
}
