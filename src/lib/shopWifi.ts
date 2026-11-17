// ============================================================
// SHOP WIFI FINGERPRINT — LEARNING LOOP (Boss order 2026-11-17:
// "improvement hota rahe" — Google WiFi-positioning ka org-level version):
//
//   WORKERS (native, WorkerSilentEngine) har confirmed IN_SHOP fix par
//   wifi_samples/ws-.. docs likhte hain (kaunse router + kitna signal).
//   MANAGER app open hone par YE aggregator:
//     1) pichle 2 din ke IN_SHOP samples parhe (sab workers ke)
//     2) jo router >=60% samples me dikha (min 10 samples) = SHOP AP
//     3) config/shop_wifi doc update — har worker ka native engine 6h me
//        wahi refetch karta hai -> WiFi se IN_SHOP confirm hota hai,
//        GPS chip band (battery). Jitna chalega, utna accurate.
//     4) 3 din se purane samples delete (DB saaf, naye data hi rule kare).
//
// COLD START: din 1 me fingerprint khali — native GPS hysteresis (100/150m)
// chalta hai + samples jama karta hai; 1-2 din me WiFi engine khud on ho jata.
// ============================================================
import { collection, deleteDoc, doc, getDoc, getDocs, limit as fsLimit, orderBy, query, setDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { diagLog } from './diag';

const AGG_KEY = 'shivam_shopwifi_agg_v1';
const AGG_INTERVAL_MS = 60 * 60 * 1000; // har ghante me ek baar kaafi
const PROMOTE_RATE = 0.6;   // >=60% samples me dikha = shop AP
const PROMOTE_MIN = 10;     // min sample count (false positive guard)
const MAX_SAMPLES = 400;    // aggregation read cap

export interface ShopWifiFingerprint {
  aps: Record<string, { n: number; rate: number; avgRssi?: number }>;
  updatedAt: number;
  by?: string;
}

function shouldRun(): boolean {
  try {
    const last = Number(localStorage.getItem(AGG_KEY)) || 0;
    return Date.now() - last >= AGG_INTERVAL_MS;
  } catch {
    return true;
  }
}

function markRun(): void {
  try {
    localStorage.setItem(AGG_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

// local YYYY-MM-DD (worker engine isoDay se match)
function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Fingerprint doc shape read (debug/keep-count ke liye)
export async function readShopWifiFingerprint(): Promise<ShopWifiFingerprint | null> {
  try {
    const snap = await getDoc(doc(db, 'config', 'shop_wifi'));
    if (!snap.exists()) return null;
    const v = snap.data() as any;
    return {
      aps: (v.aps && typeof v.aps === 'object' ? v.aps : {}) as ShopWifiFingerprint['aps'],
      updatedAt: Number(v.updatedAt) || 0,
      by: typeof v.by === 'string' ? v.by : undefined,
    };
  } catch {
    return null;
  }
}

// MANAGER-ONLY (Home.tsx manager mount par call hota hai)
export async function aggregateShopFingerprint(managerName: string): Promise<number> {
  if (!shouldRun()) return 0;
  markRun();
  try {
    const now = Date.now();
    const from = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const fromDay = dayKey(from.getTime());
    const today = dayKey(now);

    // pichle 2 din ke samples (range query single-field — composite nahi chahiye)
    const snap = await getDocs(
      query(
        collection(db, 'wifi_samples'),
        where('day', '>=', fromDay),
        orderBy('day'),
        fsLimit(MAX_SAMPLES)
      )
    );

    // BSSID stats: kitne IN_SHOP samples me dikha + avg rssi
    const stats = new Map<string, { seen: number; sum: number; n: number }>();
    let inShopTotal = 0;
    let totalSamples = 0;

    snap.forEach((d) => {
      const v = d.data() as any;
      const samples = Array.isArray(v.samples) ? v.samples : [];
      for (const s of samples) {
        totalSamples++;
        if (!s || s.inShop !== true) continue;
        inShopTotal++;
        const aps = Array.isArray(s.aps) ? s.aps : [];
        for (const ap of aps) {
          if (!ap || typeof ap.b !== 'string') continue;
          const st = stats.get(ap.b) || { seen: 0, sum: 0, n: 0 };
          st.seen += 1;
          st.n += 1;
          if (typeof ap.r === 'number') st.sum += ap.r;
          stats.set(ap.b, st);
        }
      }
    });

    if (inShopTotal < PROMOTE_MIN) {
      diagLog('shopwifi_agg_cold', { samples: totalSamples, inShop: inShopTotal });
      return 0;
    }

    // promote: >=60% IN_SHOP samples me dikha
    const aps: ShopWifiFingerprint['aps'] = {};
    let promoted = 0;
    stats.forEach((st, bssid) => {
      const rate = st.seen / inShopTotal;
      if (rate >= PROMOTE_RATE && st.seen >= PROMOTE_MIN) {
        aps[bssid] = {
          n: st.seen,
          rate: Math.round(rate * 100) / 100,
          avgRssi: Math.round(st.sum / Math.max(1, st.n)),
        };
        promoted++;
      }
    });

    if (promoted === 0) {
      diagLog('shopwifi_agg_none', { samples: totalSamples, inShop: inShopTotal });
      return 0;
    }

    await setDoc(
      doc(db, 'config', 'shop_wifi'),
      { aps, updatedAt: now, by: managerName || 'manager-app' },
      { merge: false }
    );
    diagLog('shopwifi_agg_ok', { promoted, inShop: inShopTotal });

    // PRUNE: 3 din se purane samples hatao (naye hi rule karte hain)
    const cutoff = dayKey(now - 3 * 24 * 60 * 60 * 1000);
    let pruned = 0;
    try {
      const old = await getDocs(
        query(collection(db, 'wifi_samples'), where('day', '<', cutoff), fsLimit(150))
      );
      const jobs: Promise<void>[] = [];
      old.forEach((d) => {
        pruned++;
        jobs.push(deleteDoc(d.ref));
      });
      if (jobs.length) await Promise.all(jobs);
    } catch {
      /* prune best-effort */
    }
    diagLog('shopwifi_prune', { pruned });
    return promoted;
  } catch {
    diagLog('shopwifi_agg_err');
    return 0;
  }
}
