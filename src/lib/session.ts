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

export const PROFILE_KEY = 'shivam_staff_logged_user';
export const CRED_KEY = 'shivam_staff_credentials';

export interface StoredCredentials {
  email: string;
  password: string;
}

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
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify({ email, password }));
  } catch {
    /* storage unavailable — silent re-login nahi hoga, app cached profile se chalega */
  }
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

// Explicit logout / admin-deactivation — profile + credentials DONO clear
export const clearSession = (): void => {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(CRED_KEY);
  } catch {
    /* ignore */
  }
};
