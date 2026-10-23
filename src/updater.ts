import { Browser } from '@capacitor/browser';

export interface VersionInfo {
  versionCode: number;
  versionName: string;
  apkUrl: string;
}

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
