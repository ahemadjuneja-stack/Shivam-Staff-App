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

export type UpdateCheckReason = 'none' | 'network';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  info?: VersionInfo;
  reason?: UpdateCheckReason;
  localVersion?: number;
}

export interface UpdaterPluginDef {
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

  // Local version: pehle PackageManager (native — 100% reliable), phir bundled file.
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
      return { updateAvailable: false, reason: 'network', localVersion };
    }
    const data: VersionInfo = await res.json();
    if (typeof data?.versionCode !== 'number') {
      return { updateAvailable: false, reason: 'network', localVersion };
    }
    if (data.versionCode > localVersion) {
      return { updateAvailable: true, info: data, localVersion };
    }
    return { updateAvailable: false, reason: 'none', localVersion };
  } catch {
    // Offline / network fail — ab silent NAHI, reason ke saath report karte hain
    return { updateAvailable: false, reason: 'network', localVersion };
  }
}
