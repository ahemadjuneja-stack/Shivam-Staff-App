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

// ---------- SALES DATE-WISE HISTORY (Boss order 2026-10-28: "Salesmen ka
// data Date aur din ke hisab se karo — DP par click ho aaj kaha gaya, uske
// bad kis date me kaha gaya kitne baje location on kiya us din ka khatam,
// uske niche purani date 8 din ka data") ----------
// Har LOCAL CALENDAR DAY ka apna bucket: [raat 12, agle raat 12) — sessions ke
// points + on/off events us din me daale jate hain. Aaj pehle, phir pichle
// 8 din (naye purane). Empty din bhi row banega ("Location ON nahi ki") —
// Boss ko non-compliance dikhna zaroori hai.
export interface RawPointLike { at: number; lat?: number; lng?: number }
export interface RawSessionLike {
  startedAt?: number;
  status?: string;      // 'open' | 'closed'
  endedAt?: number;
  points?: RawPointLike[];
}
export interface RawLocEventLike { type?: string; at: number; lat?: number; lng?: number }

export interface DayStop { at: number; label: string }
export interface DayTrack {
  dateKey: string;   // '2026-10-28' (expand-state key)
  dayLabel: string;  // '28 Oct · Tue' (date + DIN — Boss: "Date aur din ke hisab se")
  onAt: number;      // kitne baje location ON kiya (0 = nahi)
  lastAt: number;    // us din ka khatam — aakhri activity (0 = koi data nahi)
  endOpen: boolean;  // open session aaj ACTIVE (din abhi khatam nahi hua)
  stops: DayStop[];  // kaha kaha gaya (chronological, city labels)
  hasData: boolean;
}

const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS_S = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "28 Oct · Tue" — Line Schedule wala hi compact format
export function fmtDayLabel(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS_S[d.getMonth()]} · ${WDAYS_S[d.getDay()]}`;
}

// local midnight — dayOffset din shift karke (month/year rollback safe:
// setDate khud sambhalta hai, ms-arithmetic DST/month-edge par slip karta hai)
function localMidnight(now: number, dayOffset: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildDayTracks(
  sessions: RawSessionLike[],
  events: RawLocEventLike[],
  cities: CityCoord[],
  now: number,
  opts?: { pastDays?: number; labeler?: (lat: number, lng: number) => string }
): { today: DayTrack; past: DayTrack[] } {
  const pastDays = Math.max(1, opts?.pastDays ?? 8);
  const labeler =
    opts?.labeler ??
    ((lat: number, lng: number) => {
      const c = nearestCity(lat, lng, cities);
      return c ? c.city : `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    });

  interface Bucket {
    start: number;
    end: number;
    onAt: number;
    lastAt: number;
    pts: DayStop[];
    openActive: boolean; // open session ka activity/started isi bucket me
  }
  const buckets: Bucket[] = [];
  const mkBucket = (start: number, end: number): Bucket => ({ start, end, onAt: 0, lastAt: 0, pts: [], openActive: false });
  const todayStart = localMidnight(now, 0);
  buckets.push(mkBucket(todayStart, localMidnight(now, 1))); // aaj (index 0)
  for (let i = 1; i <= pastDays; i++) {
    buckets.push(mkBucket(localMidnight(now, -i), localMidnight(now, -i + 1)));
  }
  const inB = (at: number): Bucket | null => {
    if (!Number.isFinite(at) || at <= 0 || at > now) return null; // future guard
    for (const b of buckets) if (at >= b.start && at < b.end) return b;
    return null;
  };

  // (1) SESSIONS — points (kaha gaya) + startedAt (ON moment) + endedAt (khatam)
  for (const s of sessions) {
    if (!s) continue;
    const isOpen = s.status === 'open';
    const st = Number(s.startedAt) || 0;
    const stB = inB(st);
    if (stB) {
      if (stB.onAt === 0 || st < stB.onAt) stB.onAt = st;
      if (isOpen) stB.openActive = true;
    }
    const ed = Number(s.endedAt) || 0;
    const edB = inB(ed);
    if (edB) edB.lastAt = Math.max(edB.lastAt, ed);
    for (const p of Array.isArray(s.points) ? s.points : []) {
      const at = Number(p?.at) || 0;
      const b = inB(at);
      if (!b) continue;
      const lat = Number(p?.lat);
      const lng = Number(p?.lng);
      b.pts.push({ at, label: Number.isFinite(lat) && Number.isFinite(lng) ? labeler(lat, lng) : '—' });
      // resume-session edge: ON event kal ka, aaj ki pehli activity = aaj ka ON moment
      if (b.onAt === 0 || at < b.onAt) b.onAt = at;
      if (isOpen) b.openActive = true;
    }
  }
  // (2) EVENTS — 'on' (ON moment, session start se pehle bhi ho sakta hai)
  //     + 'off' (khatam ka precise moment — aakhri point ke baad bhi)
  for (const e of events) {
    if (!e) continue;
    const at = Number(e.at) || 0;
    const b = inB(at);
    if (!b) continue;
    if (e.type === 'on') {
      if (b.onAt === 0 || at < b.onAt) b.onAt = at;
    } else if (e.type === 'off') {
      b.lastAt = Math.max(b.lastAt, at);
    }
  }

  const toTrack = (b: Bucket, isToday: boolean): DayTrack => {
    const d = new Date(b.start);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    b.pts.sort((x, y) => x.at - y.at);
    return {
      dateKey,
      dayLabel: fmtDayLabel(b.start),
      onAt: b.onAt,
      lastAt: Math.max(b.lastAt, b.pts.length ? b.pts[b.pts.length - 1].at : 0),
      endOpen: isToday && b.openActive,
      stops: b.pts,
      hasData: b.onAt > 0 || b.lastAt > 0 || b.pts.length > 0
    };
  };

  const today = toTrack(buckets[0], true);
  const past = buckets.slice(1).map((b) => toTrack(b, false));
  return { today, past };
}

// Open session ka aakhri activity — zombie-session guard ke liye (banner:
// open session par bhi agar 12h se koi activity nahi to "abhi ON hai" MAT
// dikhao — locTrack ka apna 12h stale-close window isi se match hota hai)
export function openSessionLastActive(sessions: RawSessionLike[], now: number): number {
  let best = 0;
  for (const s of sessions) {
    if (!s || s.status !== 'open') continue;
    const pts = Array.isArray(s.points) ? s.points : [];
    const lastPt = pts.length ? Number(pts[pts.length - 1]?.at) || 0 : 0;
    const cand = Math.max(lastPt, Number(s.startedAt) || 0);
    if (cand > best && cand <= now) best = cand;
  }
  return best;
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
