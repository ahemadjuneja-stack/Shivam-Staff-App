// SESSION PERSISTENCE (Boss rule 2026-10-26: "ek baar login -> kabhi logout nahi"):
// Login credentials phone ke localStorage me save hote hain. Agar app restart
// par WebView ka Firebase session restore fail ho jaye (IndexedDB clear,
// password change se refresh-token revoke, corrupt storage) — to App.tsx
// chupke se in credentials se re-login kar leta hai. Staff ko login screen
// KABHI nahi dikhti (sirf explicit logout / admin-delete par).
//
// Firestore users doc ka `pin` field Auth password ka source of truth hai
// (dashboard changeStaffPin / registerStaff dono sync me rakhte hain) —
// isliye PIN change hote hi stored credentials bhi live update ho jate hain
// aur silent re-login hamesha working rehta hai.
//
// DUAL-LAYER STORAGE (Boss bug report 2026-10-26: "58 update ke baad bhi
// logout ho gaya" — APK verify kiya, code sahi tha; ROOT CAUSE: WebView ka
// localStorage + IndexedDB DONO wipe ho rahe the device par — OEM cleaner /
// WebView update / low-storage eviction. Cached profile + creds + Firebase
// session TINO ek saath gayab -> login screen). FIX: har write ke saath
// NATIVE SharedPreferences backup (SessionVault plugin — shared_prefs/,
// WebView storage se alag, sirf Clear Data/uninstall se mitta hai) aur boot
// par WebView storage khali mile to native vault se restore.

import { registerPlugin } from '@capacitor/core';

export const PROFILE_KEY = 'shivam_staff_logged_user';
export const CRED_KEY = 'shivam_staff_credentials';

interface SessionVaultPluginDef {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value?: string }>;
  remove(options: { key: string }): Promise<void>;
}

// Native plugin (SessionVaultPlugin.java) — sirf APK me available; web dev
// me calls "not implemented" throw karenge (sab try/catch me wrapped hai)
const SessionVault = registerPlugin<SessionVaultPluginDef>('SessionVault');

export interface StoredCredentials {
  email: string;
  password: string;
}

// Fire-and-forget native mirror — kabhi bhi main flow block ya fail nahi karega
const vaultSet = (key: string, value: string): void => {
  try {
    SessionVault.set({ key, value }).catch(() => {});
  } catch {
    /* web dev / plugin missing — localStorage hi source of truth rahega */
  }
};

const vaultRemove = (key: string): void => {
  try {
    SessionVault.remove({ key }).catch(() => {});
  } catch {
    /* web dev */
  }
};

export const readStoredCredentials = (): StoredCredentials | null => {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c && typeof c.email === 'string' && c.email && typeof c.password === 'string' && c.password) {
      return { email: c.email, password: c.password };
    }
    return null;
  } catch {
    return null;
  }
};

export const storeCredentials = (email: string, password: string): void => {
  const raw = JSON.stringify({ email, password });
  try {
    localStorage.setItem(CRED_KEY, raw);
  } catch {
    /* storage unavailable — native vault phir bhi backup lega */
  }
  vaultSet(CRED_KEY, raw);
};

// Cached profile ka dual-layer write — App.tsx isse hi PROFILE_KEY likhta hai
export const storeProfile = (p: unknown): void => {
  const raw = JSON.stringify(p);
  try {
    localStorage.setItem(PROFILE_KEY, raw);
  } catch {
    /* ignore */
  }
  vaultSet(PROFILE_KEY, raw);
};

// users/{uid} doc se credentials sync — dashboard se PIN change hone par bhi
// silent re-login working rahe (Firestore pin == Auth password, dashboard sync rakhta hai)
export const syncCredentialsFromDoc = (data: any): void => {
  const phone =
    typeof data?.phone === 'string' && data.phone
      ? data.phone
      : typeof data?.mobile === 'string'
      ? data.mobile
      : '';
  const pin = typeof data?.pin === 'string' ? data.pin.trim() : '';
  if (!phone || !pin) return;
  const email = `${phone.trim()}@shivamstaff.app`;
  const password = `sv${pin}shivam`;
  const cur = readStoredCredentials();
  if (!cur || cur.email !== email || cur.password !== password) {
    storeCredentials(email, password);
  }
};

// BOOT RESTORE — WebView storage wipe hone par native vault se wapas laao.
// App ke pehle render se PEHLE ek hi baar call hota hai (App.tsx boot effect).
// Sirf MISSING keys restore hote hain — healthy localStorage kabhi overwrite
// nahi hota (fresh data hamesha jeete).
export const ensureSessionRestored = async (): Promise<void> => {
  let lp: string | null = null;
  let lc: string | null = null;
  try {
    lp = localStorage.getItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
  try {
    lc = localStorage.getItem(CRED_KEY);
  } catch {
    /* ignore */
  }
  if (lp && lc) return; // dono healthy — kuch nahi karna

  let np: string | undefined;
  let nc: string | undefined;
  try {
    const r = await SessionVault.get({ key: PROFILE_KEY });
    np = r.value;
  } catch {
    /* web dev / plugin missing */
  }
  try {
    const r = await SessionVault.get({ key: CRED_KEY });
    nc = r.value;
  } catch {
    /* web dev */
  }

  try {
    if (!lp && np) localStorage.setItem(PROFILE_KEY, np);
    if (!lc && nc) localStorage.setItem(CRED_KEY, nc);
  } catch {
    /* localStorage hi band hai — next boot phir try hoga */
  }
};

// Explicit logout / admin-deactivation — profile + credentials DONO layers
// clear (localStorage + native vault), warna next boot par session wapas aa jayega
export const clearSession = (): void => {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(CRED_KEY);
  } catch {
    /* ignore */
  }
  vaultRemove(PROFILE_KEY);
  vaultRemove(CRED_KEY);
};
