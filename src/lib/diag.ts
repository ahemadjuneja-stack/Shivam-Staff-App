// AUTH DIAGNOSTICS (Task 59 — "logout phir bhi ho raha hai" ko remote-debug
// karne ke liye): app ka auth lifecycle Firestore collection `diag_auth` me
// log karta hai — {phone} doc, last 30 events, device versionCode ke saath.
// Rules open hain -> main REST se ye events padh kar EXACT wajah dekh sakta
// hoon (kaunsa phone, kaunsa version, storage state kya thi, silent re-login
// kaunse error se fail hua).
//
// SAFE BY DESIGN: koi PIN/password log NAHI hota, koi UI impact nahi,
// har write fire-and-forget (fail = chup), writes debounced (burst = 1 write).

import { doc, setDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { db } from '../firebase';

export interface DiagEvent {
  t: number;
  ev: string;
  [k: string]: any;
}

const MAX_EVENTS = 30;
const FLUSH_DELAY_MS = 2000;

let queue: DiagEvent[] = [];
let phoneKey = '';
let versionCode = 0;
let flushTimer: number | null = null;

// Device versionCode ek baar nikalo (diag me kaunsa build chal raha hai)
export const diagInitVersion = async (): Promise<void> => {
  try {
    if (Capacitor.isNativePlatform()) {
      const i = await CapApp.getInfo();
      const n = Number((i as any).versionCode ?? (i as any).build);
      if (Number.isFinite(n) && n > 0) versionCode = n;
    }
  } catch {
    /* web dev — versionCode 0 rahega */
  }
};

// Kis account ke doc me log karna hai (phone digits)
export const diagSetIdentity = (phone: string): void => {
  const clean = (phone || '').replace(/\D/g, '');
  if (clean) phoneKey = clean;
};

export const diagLog = (ev: string, data?: Record<string, any>): void => {
  try {
    const e: DiagEvent = { t: Date.now(), ev, ...(data || {}) };
    queue = [...queue.slice(-(MAX_EVENTS - 1)), e];
    if (flushTimer !== null) return; // already scheduled — burst events ek saath
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushDiag();
    }, FLUSH_DELAY_MS);
  } catch {
    /* ignore */
  }
};

const flushDiag = (): void => {
  try {
    const id = phoneKey || 'unknown';
    const payload = {
      phone: phoneKey || null,
      versionCode,
      platform: Capacitor.isNativePlatform() ? 'android' : 'web',
      updatedAt: Date.now(),
      events: queue
    };
    setDoc(doc(db, 'diag_auth', id), payload, { merge: true }).catch(() => {});
  } catch {
    /* ignore */
  }
};
