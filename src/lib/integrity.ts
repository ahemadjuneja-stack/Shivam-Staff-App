// ============================================================
// INTEGRITY / ANTI-TAMPER ENGINE (Boss order 2026-10-26)
// "Staff har tarha ki koshish kar sakta hai app ka timing bypass karne
//  ke liye aur hume bhi security me har tarha tayar rehna hai."
//
// TRICKS YE LAYER PAKADTI HAI:
//   1. DEVICE CLOCK CHANGE (clock aage/peeche karke fake duty time)
//      -> server offset calibration (serverTimestamp se real time anchor)
//      -> punch me clockOffsetMs + clockSuspect flag embed
//      -> monotonic watchdog (performance.now vs Date.now — clock jump
//         pakda jata hai chahe User wapas purana time laga de)
//   2. APP FORCE-CLOSE DURING DUTY (app band karke ghar baith gaya,
//      duty ON reh gayi = free minutes)
//      -> heartbeat har 60s (localStorage, net nahi chahiye)
//      -> reopen par gap detect (20 min+ ka silence = duty_gaps log)
//   3. FAKE GPS (teleport — fake location app)
//      -> consecutive fixes ka speed check (250 km/h+ = teleport flag)
//      -> low accuracy fix flag (150m+ = low confidence)
//   4. OVERNIGHT DUTY (OFF karna bhool gaya / jaan boojh ke ON chhoda)
//      -> 16h max shift cap — auto out punch + autoClosed flag
//
// SAB KUCH SIRF RECORD KARTA HAI — credit/points ka auto deduct sirf
// manager ke NO decision se hota hai (outside_logs wala flow). Flags
// dashboard ko EVIDENCE dete hain, decision manager ka.
// ============================================================
import { PunchRecord } from '../types';

const CLOCK_KEY = 'shivam_clock_v1';
const MONO_KEY = 'shivam_mono_v1';
const BEAT_KEY = 'shivam_beat_v1';
const GAPS_KEY = 'shivam_gaps_v1';
const AUTO_KEY = 'shivam_autoclose_v1';

export const CLOCK_SUSPECT_MS = 2 * 60 * 1000;   // 2 min+ offset = suspect
export const MONO_JUMP_MS = 90 * 1000;           // 90s clock jump = tamper hint
export const GAP_AFTER_MS = 20 * 60 * 1000;      // 20 min+ app silence = gap
export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000; // 16h max shift cap
export const GPS_TELEPORT_KMH = 250;             // fake GPS teleport threshold
export const GPS_LOW_ACCURACY_M = 150;           // low-confidence fix

// ---------- 1a. Server clock calibration ----------
// staff_attendance.updatedAt (serverTimestamp) snapshot se aata hai —
// server-resolved docs par hi (hasPendingWrites false).
interface ClockCal { offsetMs: number; at: number }

export function calibrateFromServer(serverMs: number) {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  const offsetMs = serverMs - Date.now();
  try {
    const prev = readJson<ClockCal>(CLOCK_KEY);
    // kalibration ka time anchor bhi rakho — purana data purane offset se
    window.localStorage.setItem(CLOCK_KEY, JSON.stringify({ offsetMs, at: Date.now() } as ClockCal & { at: number }));
    if (!prev) return;
  } catch {
    // ignore
  }
}

export function clockSnapshot(): { offsetMs: number; suspect: boolean } {
  const cal = readJson<ClockCal>(CLOCK_KEY);
  const offsetMs = cal && Number.isFinite(cal.offsetMs) ? cal.offsetMs : 0;
  return { offsetMs, suspect: Math.abs(offsetMs) > CLOCK_SUSPECT_MS };
}

// ---------- 1b. Monotonic watchdog (clock jump mid-session) ----------
interface MonoAnchor { perf: number; date: number }

export function clockJumped(): boolean {
  try {
    const prev = readJson<MonoAnchor>(MONO_KEY);
    const nowPair: MonoAnchor = { perf: performance.now(), date: Date.now() };
    window.localStorage.setItem(MONO_KEY, JSON.stringify(nowPair));
    if (!prev || !Number.isFinite(prev.perf) || !Number.isFinite(prev.date)) return false;
    const wallDelta = nowPair.date - prev.date;
    const perfDelta = nowPair.perf - prev.perf;
    const jump = wallDelta - perfDelta; // wall clock ne extra kood = tampering
    return Math.abs(jump) > MONO_JUMP_MS;
  } catch {
    return false;
  }
}

// ---------- 3. GPS anomaly ----------
export function gpsSpeedKmh(
  a: { lat: number; lng: number; at: number },
  b: { lat: number; lng: number; at: number }
): number {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distM = 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  const dtH = Math.max(1 / 3600, Math.abs(b.at - a.at) / 3600000);
  return (distM / 1000) / dtH;
}

export function teleportFlag(prev: { lat: number; lng: number; at: number } | null, cur: { lat: number; lng: number; at: number }): string[] {
  if (!prev) return [];
  try {
    if (gpsSpeedKmh(prev, cur) > GPS_TELEPORT_KMH) return ['gps_teleport'];
  } catch {
    // ignore
  }
  return [];
}

export function lowAccuracyFlag(accM?: number | null): string[] {
  return typeof accM === 'number' && accM > GPS_LOW_ACCURACY_M ? ['gps_low_accuracy'] : [];
}

// ---------- 2. Heartbeat + app-close gap ----------
interface Beat { uid: string; at: number }

export function heartbeatTouch(uid: string) {
  try {
    window.localStorage.setItem(BEAT_KEY, JSON.stringify({ uid, at: Date.now() } as Beat));
  } catch {
    // ignore
  }
}

// ON duty me app 20 min+ silent raha (kill/background) -> gap return
// (ek gap sirf EK baar log hota — GAPS_KEY me fromAt marker)
export function detectDutyGap(uid: string, isOnDuty: boolean): { fromAt: number; toAt: number } | null {
  if (!isOnDuty) return null;
  const beat = readJson<Beat>(BEAT_KEY);
  if (!beat || beat.uid !== uid) {
    heartbeatTouch(uid);
    return null;
  }
  if (Date.now() - beat.at <= GAP_AFTER_MS) return null;
  const gap = { fromAt: beat.at, toAt: Date.now() };
  try {
    const logged = readJson<string[]>(GAPS_KEY) || [];
    const id = `${uid}-${gap.fromAt}`;
    if (!logged.includes(id)) {
      logged.push(id);
      window.localStorage.setItem(GAPS_KEY, JSON.stringify(logged.slice(-50)));
      heartbeatTouch(uid); // reset — same gap dobara report na ho
      return gap;
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------- 4. Max shift cap helpers ----------
export function openInOf(punches: PunchRecord[]): number | null {
  const sorted = [...punches].sort((a, b) => a.at - b.at);
  let openIn: number | null = null;
  for (const p of sorted) {
    if (p.type === 'in') openIn = p.at;
    else openIn = null; // out punch ne span band kiya
  }
  return openIn;
}

export function overMaxShift(openIn: number, now: number): boolean {
  return Number.isFinite(openIn) && openIn > 0 && now - openIn > MAX_SHIFT_MS;
}

export function autoCloseDone(openIn: number): boolean {
  const arr = readJson<number[]>(AUTO_KEY) || [];
  return arr.includes(openIn);
}

export function markAutoCloseDone(openIn: number) {
  try {
    const arr = readJson<number[]>(AUTO_KEY) || [];
    arr.push(openIn);
    window.localStorage.setItem(AUTO_KEY, JSON.stringify(arr.slice(-30)));
  } catch {
    // ignore
  }
}

// ---------- helpers ----------
function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
