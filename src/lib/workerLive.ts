// ============================================================
// WORKER LIVE + SILENT WATCH BRIDGE (Boss order 2026-11-17):
// "worker 100 mitter ke andar ho tabhi app on ho... aur bahar jaye to app
//  lock" + "Location On rakhna zaroori hai" + ZERO-notification background.
//
// NATIVE (SilentWatchPlugin -> WorkerSilentEngine, alarm+job based, FGS nahi):
//   worker_live/{uid}    <- 3-min check (on-duty) / 15-min (off-duty):
//                           state IN_SHOP|OUTSIDE|UNKNOWN|LOC_OFF|OFFDUTY,
//                           src wifi|gps, dist, cellKey, lock latch
//   worker_alerts/wa-..  <- left_shop / back_shop / reason / manager_unlock
//   wifi_samples/ws-..   <- shop WiFi fingerprint learning (manager aggregates)
//   config/shop_wifi     <- native 6h refetch — WiFi engine smart hota jata hai
//
// JS SIDE:
//   startWorkerWatchIfNeeded()  <- login par native engine chalu (App.tsx)
//   stopWorkerWatch()           <- logout par sab band
//   syncWorkerDuty()            <- duty toggle par cadence switch (3m/15m)
//   useWorkerLock()             <- lock screen ke liye worker_live snapshot
// ============================================================
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { registerPlugin } from '@capacitor/core';
import { db } from '../firebase';
import { SHOP_CENTER_LOCKED } from './geofence';
import { diagLog } from './diag';

// ---------- native plugin bridge ----------
export interface SilentWatchPluginDef {
  startWorkerWatch(opts: {
    uid: string;
    name: string;
    city?: string;
    versionCode?: string;
    shopLat?: number;
    shopLng?: number;
  }): Promise<void>;
  stopWorkerWatch(): Promise<void>;
  setWorkerDuty(opts: { onDuty: boolean }): Promise<void>;
  workerState(): Promise<{
    enabled: boolean;
    onDuty: boolean;
    state: string;
    stateAt: number;
    lock: boolean;
    dist: number;
    lastTowerKey: string;
  }>;
  wifiScan(): Promise<{ aps: string; count: number; error?: string }>;
}

export const SilentWatch = registerPlugin<SilentWatchPluginDef>('SilentWatch');

// ---------- worker_live/{uid} doc (native engine likhta hai) ----------
export interface WorkerLiveDoc {
  uid: string;
  name: string;
  state: 'IN_SHOP' | 'OUTSIDE' | 'UNKNOWN' | 'LOC_OFF' | 'OFFDUTY' | string;
  src?: string; // wifi | gps | none | last | tower
  dist?: number;         // shop center se meters (GPS src par)
  lat?: number;
  lng?: number;
  acc?: number;
  cellKey?: string;
  cell?: { mcc?: string; mnc?: string; lac?: number; cid?: number; dbm?: number };
  city?: string;
  batteryPct?: number;
  charging?: boolean;
  lock?: boolean;        // LATCH — manager unlock ya wapas IN par hi hat-ta hai
  onDuty?: boolean;
  at?: number;
  versionCode?: number;
  deviceModel?: string;
  flags?: string[];
}

// worker_alerts/wa-... doc
export interface WorkerAlertDoc {
  uid: string;
  name: string;
  type: 'left_shop' | 'back_shop' | 'reason' | 'manager_unlock' | string;
  text?: string;
  at: number;
  lat?: number;
  lng?: number;
  dist?: number;
  cellKey?: string;
  city?: string;
  status?: 'open' | 'noted' | string;
}

// ---------- START (App.tsx — worker login par) ----------
// Native engine ko identity + Boss-locked shop center deta hai. Fingerprint
// config native khud 6h me refetch karta hai (config/shop_wifi).
export async function startWorkerWatchIfNeeded(profile: {
  uid: string;
  name: string;
  city: string;
}): Promise<void> {
  try {
    const { fetchAppVersionInfo } = await import('./reporting');
    const v = await fetchAppVersionInfo().catch(() => ({ appVersionCode: 0 }));
    await SilentWatch.startWorkerWatch({
      uid: profile.uid,
      name: profile.name,
      city: profile.city || 'Main',
      versionCode: String(v.appVersionCode || 0),
      shopLat: SHOP_CENTER_LOCKED.lat,
      shopLng: SHOP_CENTER_LOCKED.lng,
    });
    diagLog('worker_watch_start');
  } catch {
    diagLog('worker_watch_start_err'); // web dev / old build — chup
  }
}

export async function stopWorkerWatch(): Promise<void> {
  try {
    await SilentWatch.stopWorkerWatch();
    diagLog('worker_watch_stop');
  } catch {
    /* ignore */
  }
}

// ---------- DUTY SYNC (Home.tsx toggleDuty par) ----------
// on-duty = 3-min checks + lock rule; off-duty = 15-min light ping + no lock.
export async function syncWorkerDuty(onDuty: boolean): Promise<void> {
  try {
    await SilentWatch.setWorkerDuty({ onDuty });
    diagLog('worker_watch_duty', { on: onDuty });
  } catch {
    /* ignore */
  }
}

// ---------- WORKER LOCK HOOK (Home.tsx — worker app me) ----------
// worker_live/{uid} live snapshot — lock latch par full-screen lock dikhata hai
// (manager unlock ya wapas shop IN hone par turant hat jata hai).
export function useWorkerLock(uid: string): {
  doc: WorkerLiveDoc | null;
  locked: boolean;
  loading: boolean;
} {
  const [docData, setDocData] = useState<WorkerLiveDoc | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'worker_live', uid),
      (snap) => {
        setDocData(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<WorkerLiveDoc, 'uid'>) } as WorkerLiveDoc) : null);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, [uid]);

  return { doc: docData, locked: docData?.lock === true, loading };
}
