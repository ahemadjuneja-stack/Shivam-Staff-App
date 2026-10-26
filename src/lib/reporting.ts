import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { outboxPendingCount, outboxFailedCount } from './sync';

export function parseDeviceInfo(): { deviceModel: string; osVersion: string } {
  const ua = navigator.userAgent || '';
  let osVersion = 'Android';
  let deviceModel = 'Android device';

  // Android version extraction
  const androidMatch = ua.match(/Android\s+([0-9\.]+)/i);
  if (androidMatch) {
    osVersion = `Android ${androidMatch[1].split('.')[0]}`;
  }

  // Device model extraction from userAgent parentheses
  const match = ua.match(/\(([^)]+)\)/);
  if (match && match[1]) {
    const parts = match[1].split(';').map(p => p.trim());
    const candidate = parts.find(p => 
      !p.toLowerCase().includes('linux') &&
      !p.toLowerCase().includes('android') &&
      !p.toLowerCase().includes('mobile') &&
      !p.toLowerCase().includes('applewebkit') &&
      !p.toLowerCase().includes('safari') &&
      !p.toLowerCase().includes('k') &&
      !p.toLowerCase().includes('version') &&
      !p.includes('Build/') &&
      p.length > 1
    );
    if (candidate) {
      deviceModel = candidate.split('Build/')[0].trim();
    } else {
      const buildIdx = parts.findIndex(p => p.includes('Build/'));
      if (buildIdx > 0) {
        deviceModel = parts[buildIdx - 1].trim();
      }
    }
  }
  if (!deviceModel || deviceModel === 'Android' || deviceModel.length < 2) {
    deviceModel = 'Android device';
  }
  return { deviceModel, osVersion };
}

let cachedVersionInfo: { appVersion: string; appVersionCode: number } | null = null;

export async function fetchAppVersionInfo(): Promise<{ appVersion: string; appVersionCode: number }> {
  if (cachedVersionInfo) return cachedVersionInfo;
  try {
    const res = await fetch(`./app-version.json?t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      cachedVersionInfo = {
        appVersion: data.versionName || (data.versionCode ? `1.0.${data.versionCode}` : '1.0.0'),
        appVersionCode: typeof data.versionCode === 'number' ? data.versionCode : 1
      };
      return cachedVersionInfo;
    }
  } catch (e) {
    // ignore
  }
  return { appVersion: '1.0.0', appVersionCode: 1 };
}

// STRICT FRESH FIX (Boss order 2026-10-26: "bina location on nahi hona chahiye,
// koi bhi cache local me save mat karna"): maximumAge:0 — CACHED GPS fix se
// gate KABHI pass nahi hota, har baar device se taaza fix. Weak-signal
// (TIMEOUT code 3) par ek retry — PERMISSION_DENIED (code 1) / POSITION_
// UNAVAILABLE (code 2 = location service band) par TURANT fail (retry bekaar).
// GPS ko net nahi chahiye — slow internet par bhi ye chalta hai.
export function fetchLocation(opts?: { timeoutMs?: number; retries?: number }): Promise<{ lat: number; lng: number; at: number; accuracy?: number } | null> {
  const timeoutMs = opts?.timeoutMs ?? 6000;
  const maxRetries = opts?.retries ?? 1;
  const tryOnce = (): Promise<any> =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      // HARD TIMEOUT (GPS toggle bug — Boss report 2026-10-27: "kabhi kabhi
      // location off karne ke baad wapis on karne par app bolta hai k aapka
      // GPS location on nahi hai"): Android WebView me location OFF->ON flap
      // ke baad getCurrentPosition ke callbacks KABHI-KABHI FIRE HI NAHI hote
      // — bina iske promise hamesha ke liye atak jata tha, gate 'gps' /
      // 'gps-off-live' se aage kabhi nahi badhta tha. timeoutMs+2500 par
      // force-resolve (code 3 jaisa) — retry/null logic waisa hi chalega.
      let settled = false;
      const done = (v: any) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      navigator.geolocation.getCurrentPosition(
        done,
        (e) => done({ __err: e }),
        { timeout: timeoutMs, enableHighAccuracy: true, maximumAge: 0 }
      );
      window.setTimeout(() => done({ __err: { code: 3, message: 'hard-timeout' } }), timeoutMs + 2500);
    });
  return (async () => {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const pos: any = await tryOnce();
      if (pos && pos.coords) {
        return {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: Date.now(),
          accuracy: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : undefined
        };
      }
      const code = pos && pos.__err ? Number(pos.__err.code) : -1;
      if (code === 1 || code === 2 || attempts > maxRetries) return null;
    }
  })();
}

export async function reportDeviceAndLocation(uid: string) {
  if (!uid) return;
  try {
    const { deviceModel, osVersion } = parseDeviceInfo();
    const { appVersion, appVersionCode } = await fetchAppVersionInfo();
    const loc = await fetchLocation();

    const payload: any = {
      deviceModel,
      osVersion,
      appVersion,
      appVersionCode,
      lastSeenAt: Date.now(),
      // NET TYPE (Boss order 2026-10-26: "jab jab location aur net dono on kare
      // uski sari information bhejni hai" — slow/fast/wifi ka pata dashboard ko):
      // 'wifi' | 'cellular' | 'slow-2g'... (WebView Network Information API)
      netType: (navigator as any)?.connection?.effectiveType || 'unknown',
      // SYNC HEALTH (Boss: dashboard ko pata ho ke device kitna synced hai):
      syncHealth: {
        pending: outboxPendingCount(),   // outbox me abhi bhi Confirm-pending writes
        failed: outboxFailedCount(),     // 6 tries ke baad bhi unconfirmed
        at: Date.now()
      }
    };
    if (loc) {
      payload.lastLocation = loc;
    }

    await setDoc(doc(db, 'users', uid), payload, { merge: true });
  } catch (err) {
    // Never crash, never alert user
  }
}
