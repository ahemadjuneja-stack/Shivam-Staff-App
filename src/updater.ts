import { Browser } from '@capacitor/browser';

export interface VersionInfo {
  versionCode: number;
  versionName: string;
  apkUrl: string;
}

export async function checkForUpdates(currentVersionCode = 1): Promise<{ updateAvailable: boolean; info?: VersionInfo }> {
  try {
    const res = await fetch(`https://shivam-staff-app.web.app/app-version.json?t=${Date.now()}`);
    if (!res.ok) return { updateAvailable: false };
    const data: VersionInfo = await res.json();
    if (data.versionCode > currentVersionCode) {
      return { updateAvailable: true, info: data };
    }
  } catch {
    // Silently handle fetch failure in preview / offline environments
  }
  return { updateAvailable: false };
}

export async function openDownloadUrl(url: string) {
  await Browser.open({ url });
}
