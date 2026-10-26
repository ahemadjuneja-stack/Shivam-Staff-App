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

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface LocationGuardPluginDef {
  start(): Promise<void>;
  stop(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  startTracking(opts: { uid: string; name: string; role: string; versionCode?: number }): Promise<void>;
  stopTracking(): Promise<void>;
  ensureSession(opts: { hasFix: boolean; lat?: number; lng?: number }): Promise<void>;
  addListener(
    eventName: 'locationStateChanged',
    listenerFunc: (data: { enabled: boolean }) => void
  ): Promise<PluginListenerHandle> & PluginListenerHandle;
  removeAllListeners(): Promise<void>;
}

export const LocationGuard = registerPlugin<LocationGuardPluginDef>('LocationGuard');
