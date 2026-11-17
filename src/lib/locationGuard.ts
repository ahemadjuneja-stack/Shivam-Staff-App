// LOCATION GUARD (Task 59-c — Boss order: "location off karne par app INSTANT
// band ho jaye"): Android system broadcast (PROVIDERS_CHANGED / MODE_CHANGED)
// location toggle hote hi MILLISECONDS me fire hota hai — LocationGuardPlugin
// usko sun kar JS ko batata hai. Ye sabse tez signal hai (probe/watchdog ke
// 20-60s wait ka intezaar nahi). Web dev me plugin missing = sab try/catch me
// chup, JS probe/watchdog backup layers kaam karte rehte hain.
//
// BACKGROUND TRACKING (Boss order 2026-10-27: "salesman agar app on naa bhi
// kare aur location on kare tab bhi unka location dashboard par aana chahiye"):
// startTracking() = native LocationTrackService (foreground service) — app
// band hone par bhi GPS trail + ON/OFF events + duty sync Firestore me jaate
// hain. stopTracking() = logout/role-change par sab band. ensureSession() =
// gate pass par fresh fix native ko (session/'on' event wahi banta hai).
// SALES ONLY — worker/manager par startTracking native me no-op hai.
//
// HYBRID TOUR ENGINE (Boss order 2026-11-17): startTracking ab HOME BASE
// (shop center + home city) bhi native ko deta hai — native TOUR/HOME mode
// decide karta hai (10km+ door = tour = GPS band, tower ID engine).
// pushCellDb() = Firestore cell_towers ka native cache me merge (offline
// "where is my train" layer). getCellInfo() = current serving tower read.

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface CellTowerInfo {
  ok: boolean;
  key: string; // "mcc-mnc-lac-cid" — DB lookup key
  mcc: string;
  mnc: string;
  lac: number;
  cid: number;
  dbm: number;
}

export interface CellTowerRecord {
  key: string;
  lat: number;
  lng: number;
  acc?: number;
  city?: string;
  samples?: number;
  updatedAt?: number;
}

// CONSENT WIZARD (Boss order 2026-11-17): har permission ka on/off status —
// ConsentGate wizard isse ticks dikhata hai (2.5s poll).
export interface PermStatus {
  fineLocation: boolean; // ACCESS_FINE_LOCATION granted
  coarseLocation: boolean;
  backgroundLocation: boolean; // "Allow all the time" (API 29+; niche par true)
  notifications: boolean; // API 33+ par real check, niche par true
  motion: boolean; // ACTIVITY_RECOGNITION (API 29+; niche par true)
  batteryExempt: boolean; // isIgnoringBatteryOptimizations
  usageAccess: boolean; // AppOps OPSTR_GET_USAGE_STATS (optional feature)
  error?: string;
}

export interface LocationGuardPluginDef {
  start(): Promise<void>;
  stop(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  startTracking(opts: {
    uid: string;
    name: string;
    role: string;
    versionCode?: number;
    // HYBRID TOUR ENGINE (Boss 2026-11-17): home base = BOSS-LOCKED shop
    // center + sales ka home city — native TOUR/HOME mode isi se decide karta hai
    homeLat?: number;
    homeLng?: number;
    homeCity?: string;
  }): Promise<void>;
  stopTracking(): Promise<void>;
  ensureSession(opts: { hasFix: boolean; lat?: number; lng?: number }): Promise<void>;
  // TOWER DB SYNC (Boss 2026-11-17): Firestore cell_towers -> native file cache
  pushCellDb(opts: { towers: CellTowerRecord[] }): Promise<{ merged?: number }>;
  // Current serving tower (diagnostics — gate/dashboard display)
  getCellInfo(): Promise<CellTowerInfo>;
  // CONSENT WIZARD (Boss 2026-11-17): permission status + guided requests.
  // Background-location aur battery Android me alag flow hain (settings se
  // karna padta hai) — isliye alag methods, wizard par-par dikhata hai.
  permStatus(): Promise<PermStatus>;
  requestPermissions(): Promise<{ requested: number }>;
  requestBatteryExemption(): Promise<{ asked: boolean }>;
  requestUsageAccess(): Promise<void>;
  openAppSettings(): Promise<void>;
  addListener(
    eventName: 'locationStateChanged',
    listenerFunc: (data: { enabled: boolean }) => void
  ): Promise<PluginListenerHandle> & PluginListenerHandle;
  removeAllListeners(): Promise<void>;
}

export const LocationGuard = registerPlugin<LocationGuardPluginDef>('LocationGuard');
