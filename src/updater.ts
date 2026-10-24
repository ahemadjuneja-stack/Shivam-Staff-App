import { Browser } from '@capacitor/browser';
import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

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

export interface UpdaterPluginDef {
  getReadyApk(options: { versionCode: number }): Promise<ReadyApkResult>;
  downloadApk(options: { url: string; versionCode: number }): Promise<DownloadResult>;
  installApk(options: { path: string }): Promise<void>;
  addListener(
    eventName: 'progress',
    listenerFunc: (data: { progress: number }) => void
  ): Promise<PluginListenerHandle>;
}

// Native plugin (UpdaterPlugin.java) — sirf APK me available, web me calls reject hongi
export const Updater = registerPlugin<UpdaterPluginDef>('Updater');

export async function checkForUpdates(currentVersionCode?: number): Promise<{ updateAvailable: boolean; info?: VersionInfo }> {
  // The update popup only makes sense inside the installed APK.
  if (!(window as any).Capacitor?.isNativePlatform?.()) {
    return { updateAvailable: false };
  }

  let localVersion: number = currentVersionCode ?? 0;
  if (currentVersionCode === undefined) {
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

  try {
    const res = await fetch(`https://shivam-staff-app.web.app/app-version.json?t=${Date.now()}`);
    if (!res.ok) return { updateAvailable: false };
    const data: VersionInfo = await res.json();
    if (data.versionCode > localVersion) {
      return { updateAvailable: true, info: data };
    }
  } catch {
    // Silently handle fetch failure in offline environments
  }
  return { updateAvailable: false };
}

export async function openDownloadUrl(url: string) {
  await Browser.open({ url });
}
