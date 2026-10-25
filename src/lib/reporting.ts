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

export async function fetchLocation(): Promise<{ lat: number; lng: number; at: number; accuracy?: number } | null> {
  try {
    if ('geolocation' in navigator) {
      const pos: any = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 4000, enableHighAccuracy: true });
      });
      if (pos && pos.coords) {
        return {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: Date.now(),
          accuracy: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : undefined
        };
      }
    }
  } catch (e) {
    // ignore silently
  }
  return null;
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
