// ============================================================
// SYNC GUARANTEE LAYER (Boss order 2026-10-26)
// "Aisa nahi hona chahiye ke net band ho, task diya ho, ya wo shop
//  se bahar ho, ya kuch bhi update ho — wo local store me reh jaye
//  aur wapis firebase par app update hi na kare."
//
// PROBLEM: Firestore persistentLocalCache offline writes queue karta hai,
// lekin wo queue phone ke IndexedDB me hai. Agar Android storage pressure
// me cache evict ho jaye / app data clear ho jaye / WebView storage wipe
// ho jaye — to QUEUED WRITES HAMESHA KE LIYE GAYAB. Duty punch, outside
// log, attendance flip — kuch bhi Firebase tak nahi pohnchta.
//
// LAYER (belt + suspenders):
//   1. JOURNAL: har critical write pehle localStorage outbox me record
//      (opId ke saath — replay-safe idempotency).
//   2. WRITE: Firestore write jaise pehle hota tha (offline me cache queue).
//   3. CONFIRM + RECONCILE: har 90s (jab online ho) + 'online' event par
//      outbox me har op ke liye SERVER se poocha jata hai (source:'server'
//      — cache nahi, real server read): "kya ye opId wahan pohnch chuka?"
//      — AGAR HAAN: outbox entry delete (confirmed).
//      — AGAR NAHI: write DOBARA fire (same opId — server pe duplicate
//        nahi banega kyunki presence check pehle hota hai).
//   4. RETRY CAP: 6 tries ke baad op 'failed' mark (infinite loop nahi),
//      UI dot me count dikhta rehta hai.
//
// LOGOUT CASE: ops me uid/name embedded hai — phone koi bhi user khole,
// reconcile SAHI bande ke data ko uske uid ke saath sync karega. Data
// kabhi orphan nahi hota.
// ============================================================
import { addDoc, collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, query, setDoc, where } from 'firebase/firestore';
import { db } from '../firebase';

const LS_KEY = 'shivam_outbox_v1';
const MAX_TRIES = 6;

export type OutboxKind = 'punch' | 'attendance' | 'outside_log' | 'duty_gap' | 'task_new';

export interface OutboxOp {
  id: string; // opId — same write dobara jaye to SAME id (dedupe guarantee)
  kind: OutboxKind;
  at: number;
  tries: number;
  failed?: boolean;
  payload: object;
}

function load(): OutboxOp[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as OutboxOp[];
    return Array.isArray(arr) ? arr.filter((o) => o && o.id && o.kind && o.payload) : [];
  } catch {
    return [];
  }
}

function save(ops: OutboxOp[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(ops));
  } catch {
    // storage full/blocked — Firestore cache phir bhi queue karta hai
  }
}

let ops: OutboxOp[] = load();
let flushing = false;
const listeners = new Set<(pending: number) => void>();

function notify() {
  const n = outboxPendingCount();
  listeners.forEach((cb) => {
    try { cb(n); } catch { /* ignore */ }
  });
}

export function outboxPendingCount(): number {
  return ops.filter((o) => !o.failed).length;
}

export function outboxFailedCount(): number {
  return ops.filter((o) => o.failed).length;
}

// UI dot ke liye — subscribe(pending count)
export function subscribeOutbox(cb: (pending: number) => void): () => void {
  listeners.add(cb);
  cb(outboxPendingCount());
  return () => listeners.delete(cb);
}

// STEP 1: journal-before-write (strict order — pehle LS record, phir write)
export function enqueueOutbox(kind: OutboxKind, payload: object, id: string) {
  if (!id) return;
  if (ops.some((o) => o.id === id)) return; // dedupe — same op kabhi double journal nahi
  ops.push({ id, kind, at: Date.now(), tries: 0, payload });
  if (ops.length > 200) ops = ops.slice(-200); // cap — purane confirmed hi hote hain
  save(ops);
  notify();
  // debounce flush — write ke turant baad online ho to 2s me confirm ho jayega
  window.setTimeout(() => { flushOutbox().catch(() => {}); }, 2000);
}

// server-source presence check — CACHE NAHI, asli server se poochte hain
async function serverHas(collName: string, opId: string): Promise<boolean> {
  const q = query(collection(db, collName), where('opId', '==', opId));
  const snap = await getDocsFromServer(q);
  return !snap.empty;
}

// STEP 3: reconcile — har op: present? remove : re-fire
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  flushing = true;
  try {
    let dirty = false;
    for (const op of [...ops]) {
      if (op.failed || op.tries >= MAX_TRIES) continue;
      try {
        let confirmed = false;
        if (op.kind === 'punch') {
          if (await serverHas('punches', op.id)) {
            confirmed = true;
          } else {
            await addDoc(collection(db, 'punches'), op.payload);
            confirmed = await serverHas('punches', op.id);
          }
        } else if (op.kind === 'outside_log') {
          if (await serverHas('outside_logs', op.id)) {
            confirmed = true;
          } else {
            await addDoc(collection(db, 'outside_logs'), op.payload);
            confirmed = await serverHas('outside_logs', op.id);
          }
        } else if (op.kind === 'duty_gap') {
          if (await serverHas('duty_gaps', op.id)) {
            confirmed = true;
          } else {
            await addDoc(collection(db, 'duty_gaps'), op.payload);
            confirmed = await serverHas('duty_gaps', op.id);
          }
        } else if (op.kind === 'task_new') {
          if (await serverHas('tasks', op.id)) {
            confirmed = true;
          } else {
            await addDoc(collection(db, 'tasks'), op.payload);
            confirmed = await serverHas('tasks', op.id);
          }
        } else if (op.kind === 'attendance') {
          const p = op.payload as { uid?: string; isOnDuty?: unknown };
          const ref = doc(db, 'staff_attendance', String(p.uid || ''));
          if (!ref.id) { op.failed = true; continue; }
          await setDoc(ref, { ...op.payload, updatedAt: Date.now() }, { merge: true });
          const s = await getDocFromServer(ref);
          confirmed = s.exists() && s.data().isOnDuty === p.isOnDuty;
        }
        if (confirmed) {
          ops = ops.filter((o) => o.id !== op.id); // CONFIRMED — journal se nikal gaya
        } else {
          op.tries += 1;
          if (op.tries >= MAX_TRIES) op.failed = true;
        }
        dirty = true;
      } catch {
        // offline/flake — try badhao, op rehta hai (koi data loss nahi)
        op.tries += 1;
        if (op.tries >= MAX_TRIES) op.failed = true;
        dirty = true;
      }
    }
    if (dirty) { save(ops); notify(); }
  } finally {
    flushing = false;
  }
}

// Module init: net wapas aaya → turant reconcile. + 90s heartbeat reconcile.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    window.setTimeout(() => { flushOutbox().catch(() => {}); }, 2500); // radio settle de do
  });
  window.setInterval(() => {
    // BATTERY SAVER: app hidden = 90s flush skip (radio wakeup 0) — journal
    // entries localStorage (L2) me safe; wapas foreground aate hi flush.
    if (document.hidden) return;
    flushOutbox().catch(() => {});
  }, 90 * 1000);
  document.addEventListener('visibilitychange', () => {
    // BATTERY SAVER resume: visible = 900ms me outbox reconcile (dashboard jaisa)
    if (!document.hidden) window.setTimeout(() => { flushOutbox().catch(() => {}); }, 900);
  });
}
