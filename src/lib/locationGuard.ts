// LOCATION GUARD (Task 59-c — Boss order: "location off karne par app INSTANT
// band ho jaye"): Android system broadcast (PROVIDERS_CHANGED / MODE_CHANGED)
// location toggle hote hi MILLISECONDS me fire hota hai — LocationGuardPlugin
// usko sun kar JS ko batata hai. Ye sabse tez signal hai (probe/watchdog ke
// 20-60s wait ka intezaar nahi). Web dev me plugin missing = sab try/catch me
// chup, JS probe/watchdog backup layers kaam karte rehte hain.

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface LocationGuardPluginDef {
  start(): Promise<void>;
  stop(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  addListener(
    eventName: 'locationStateChanged',
    listenerFunc: (data: { enabled: boolean }) => void
  ): Promise<PluginListenerHandle> & PluginListenerHandle;
  removeAllListeners(): Promise<void>;
}

export const LocationGuard = registerPlugin<LocationGuardPluginDef>('LocationGuard');
