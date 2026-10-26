import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

export interface VersionInfo {
  versionCode: number;
  versionName: string;
  apkUrl: string;
}

export interface ReadyApkResult {
  exists: boolean;
  path?: string;
  size?: number;
}

export interface DownloadResult {
  path: string;
  size: number;
  cached?: boolean;
}

// UpdaterPlugin.checkUpdate() ka result — NATIVE Java HTTP check (build 31+)
export interface NativeCheckResult {
  available: boolean;
  localVc?: number;
  versionCode?: number;
  versionName?: string;
  apkUrl?: string;
  source?: string;
  errors?: string;
}

export type UpdateCheckReason = 'none' | 'network';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  info?: VersionInfo;
  reason?: UpdateCheckReason;
  localVersion?: number;
  // Har source ka exact error ("hosting: timeout | github: HTTP 403") — support diagnostics
  detail?: string;
  source?: string;
}

export interface UpdaterPluginDef {
  checkUpdate(): Promise<NativeCheckResult>;
  getReadyApk(options: { versionCode: number }): Promise<ReadyApkResult>;
  downloadApk(options: { url: string, versionCode: number }): Promise<DownloadResult>;
  installApk(options: { path: string }): Promise<void>;
  cleanStale(): Promise<void>;
  addListener(
    eventName: 'progress',
    listenerFunc: (data: { progress: number }) => void
  ): Promise<PluginListenerHandle>;
}

// Native plugin (UpdaterPlugin.java) — sirf APK me available, web me calls reject hongi
export const Updater = registerPlugin<UpdaterPluginDef>('Updater');

export async function checkForUpdates(currentVersionCode?: number): Promise<UpdateCheckResult> {
  // The update popup only makes sense inside the installed APK.
  if (!(window as any).Capacitor?.isNativePlatform?.()) {
    return { updateAvailable: false, reason: 'none' };
  }

  // BUILD 31+: check NATIVE (Java HTTP, dual-source) — WebView/CORS/silent-fail era KHATAM
  try {
    const r = await Updater.checkUpdate();
    const localVersion =
      typeof r.localVc === 'number' && r.localVc > 0 ? r.localVc : currentVersionCode ?? 0;
    if (r.available && typeof r.versionCode === 'number' && r.apkUrl) {
      return {
        updateAvailable: true,
        info: {
          versionCode: r.versionCode,
          versionName: r.versionName || `1.0.0-${r.versionCode}`,
          apkUrl: r.apkUrl
        },
        localVersion,
        source: r.source
      };
    }
    return {
      updateAvailable: false,
      reason: r.errors ? 'network' : 'none',
      localVersion,
      detail: r.errors || undefined,
      source: r.source
    };
  } catch {
    // Purana native plugin (checkUpdate method exist nahi karta) — legacy path
    return legacyCheck(currentVersionCode);
  }
}

// LEGACY: WebView fetch (purane builds ke plugin ke saath compat) — ab bhi silent NAHI
async function legacyCheck(currentVersionCode?: number): Promise<UpdateCheckResult> {
  let localVersion = currentVersionCode;
  if (localVersion === undefined) {
    try {
      const i = await CapApp.getInfo();
      const n = Number((i as any).versionCode ?? (i as any).build);
      if (Number.isFinite(n) && n > 0) localVersion = n;
    } catch {
      // App plugin shape/availability — bundled file se try karenge
    }
  }
  if (localVersion === undefined) {
    try {
      const res = await fetch(`./app-version.json?t=${Date.now()}`);
      if (res.ok) {
        const localData = await res.json();
        if (typeof localData.versionCode === 'number') {
          localVersion = localData.versionCode;
        }
      }
    } catch {
      // No bundled version file available — treat as version 0 so remote wins.
    }
  }
  if (localVersion === undefined) localVersion = 0;

  try {
    const res = await fetch(`https://shivam-staff-app.web.app/app-version.json?t=${Date.now()}`);
    if (!res.ok) {
      return { updateAvailable: false, reason: 'network', localVersion, detail: `webview: HTTP ${res.status}` };
    }
    const data: VersionInfo = await res.json();
    if (typeof data?.versionCode !== 'number') {
      return { updateAvailable: false, reason: 'network', localVersion, detail: 'webview: bad json' };
    }
    if (data.versionCode > localVersion) {
      return { updateAvailable: true, info: data, localVersion };
    }
    return { updateAvailable: false, reason: 'none', localVersion };
  } catch (e: any) {
    return {
      updateAvailable: false,
      reason: 'network',
      localVersion,
      detail: `webview: ${e?.message || 'fetch fail'}`
    };
  }
}
