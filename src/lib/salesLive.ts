// ============================================================
// SALES LIVE + CELL TOWER DB (Boss order 2026-11-17 — hybrid tour engine):
// "Rail jaise system — internet band ho location band ho tab bhi tower id
//  se pata chalta hai train kaha pohchi hai" + "har 15 min me app unka data
//  manager ke role me share karegi".
//
// NATIVE (LocationTrackService) har 15-min TOUR ping par likhta hai:
//   sales_live/{uid}   <- live state (manager board isi ko onSnapshot karta hai)
//   sales_visits/{sv-} <- 15-min dwell ke baad ONE-TIME GPS burst = visit log
//   cell_towers/{key}  <- self-learning tower DB (gps fix + tower mila to)
//
// YE FILE (JS side):
//   syncCellDbToNative()  <- Firestore cell_towers -> native file cache push.
//      Ye hi "where is my train" ka offline magic hai: jab tak net+GPS the
//      tha, kisi bhi sales ne jo tower learn kiya (cell_towers me hai), wo
//      har phone ke native cache me merge ho jata hai. Baad me INTERNET BAND
//      ho to bhi native serving-tower key se CITY nikal leta hai (CellDbCache).
//      Incremental (updatedAt > lastSync) — har app-open par cheap sync.
//
// SALES ONLY — worker/manager par native tracking hi nahi chalta, ye sync
// bhi sales ke liye hi call hota hai (App.tsx).
// ============================================================
import { collection, getDocs, limit as fsLimit, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { LocationGuard } from './locationGuard';
import type { CellTowerRecord } from './locationGuard';
import { diagLog } from './diag';

// ---------- TYPES (native sales_live/{uid} doc — manager board reads) ----------
export interface SalesLiveDoc {
  uid: string;
  name: string;
  state: 'HOME' | 'TRANSIT' | 'DWELL' | 'VISIT' | 'LOC_OFF' | string;
  tourMode?: boolean;
  lat?: number;
  lng?: number;
  acc?: number;
  src?: string; // app_open | network | gps_burst | svc | burst_timeout | last
  city?: string;
  citySrc?: string; // geocoder | tower_db | tower_near | home | none
  cellKey?: string; // "mcc-mnc-lac-cid" — serving tower fingerprint
  cell?: { mcc?: string; mnc?: string; lac?: number; cid?: number; dbm?: number };
  batteryPct?: number;
  charging?: boolean;
  flags?: string[]; // gps_teleport | mock_location | gps_low_accuracy | gps_tower_mismatch
  todayVisits?: number;
  lastVisitAt?: number;
  lastVisitCity?: string;
  at?: number;
  versionCode?: number;
  deviceModel?: string;
}

// native sales_visits/{sv-uid-at} doc — CLIENT VISIT LOG
export interface SalesVisitDoc {
  uid: string;
  name: string;
  at: number;
  arrivedAt?: number;
  dwellMin?: number;
  lat: number;
  lng: number;
  acc?: number;
  city?: string;
  citySrc?: string;
  cellKey?: string;
  mock?: boolean;
  flags?: string[];
  src?: string;
}

const SYNC_KEY = 'shivam_cell_db_sync_v1';
const SYNC_FULL_MAX = 800; // pehla (full) sync cap — org ka DB chhota hota hai
const SYNC_INC_MAX = 500;  // incremental batch cap

function readLastSync(): number {
  try {
    return Number(localStorage.getItem(SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastSync(t: number) {
  try {
    if (t > 0) localStorage.setItem(SYNC_KEY, String(t));
  } catch {
    /* ignore */
  }
}

// ---------- CELL DB SYNC (Firestore -> native offline cache) ----------
// App open / gate pass par sales ke liye call hota hai (App.tsx). Fail ho to
// chup — native self-learning ka local DB phir bhi kaam karta hai.
export async function syncCellDbToNative(): Promise<number> {
  if (!LocationGuard?.pushCellDb) return 0; // web dev — plugin nahi, chup
  try {
    const last = readLastSync();
    let records: CellTowerRecord[] = [];
    let maxUpd = last;
    if (last <= 0) {
      // PEHLA sync — full DB (dusre sales ke learned towers sab milenge)
      const snap = await getDocs(
        query(collection(db, 'cell_towers'), orderBy('updatedAt'), fsLimit(SYNC_FULL_MAX))
      );
      snap.forEach((d) => {
        const v = d.data() as Partial<CellTowerRecord>;
        const rec = docToRecord(d.id, v);
        if (rec) {
          records.push(rec);
          maxUpd = Math.max(maxUpd, rec.updatedAt || 0);
        }
      });
    } else {
      // INCREMENTAL — sirf naye/updated towers (single-field range query)
      const snap = await getDocs(
        query(collection(db, 'cell_towers'), where('updatedAt', '>', last), orderBy('updatedAt'), fsLimit(SYNC_INC_MAX))
      );
      snap.forEach((d) => {
        const v = d.data() as Partial<CellTowerRecord>;
        const rec = docToRecord(d.id, v);
        if (rec) {
          records.push(rec);
          maxUpd = Math.max(maxUpd, rec.updatedAt || 0);
        }
      });
    }
    if (records.length === 0) {
      writeLastSync(maxUpd);
      return 0;
    }
    await LocationGuard.pushCellDb({ towers: records });
    writeLastSync(maxUpd);
    diagLog('cell_db_sync', { n: records.length, first: last <= 0 });
    return records.length;
  } catch {
    diagLog('cell_db_sync_err');
    return 0;
  }
}

function docToRecord(id: string, v: Partial<CellTowerRecord>): CellTowerRecord | null {
  try {
    const lat = Number(v.lat);
    const lng = Number(v.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
    return {
      key: typeof v.key === 'string' && v.key ? v.key : id, // native key field se aata hai
      lat,
      lng,
      acc: Number.isFinite(Number(v.acc)) ? Number(v.acc) : undefined,
      city: typeof v.city === 'string' ? v.city : undefined,
      samples: Number.isFinite(Number(v.samples)) ? Number(v.samples) : undefined,
      updatedAt: Number(v.updatedAt) || 0
    };
  } catch {
    return null;
  }
}

// ---------- TIME HELPERS (manager board ke liye) ----------

/** Aaj ka local midnight (visits "today" bucket). */
export function todayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "5m" | "2h 10m" — live board ago label. */
export function fmtAgoShort(at: number | undefined, now: number): string {
  if (!at || at <= 0) return '—';
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 1) return 'abhi';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
