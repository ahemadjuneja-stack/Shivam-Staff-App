# CONSENT + PRIVACY POLICY (Boss order 2026-11-17)

Boss ka order: "App installed hote staff manager aur sales role ko SARE
permissions EK HI dialog me dikhna chahiye — usme sirf permission ka zikr,
niche privacy policy ka link (permission dete waqt wo padh bhi sakta hai),
ek check-mark ke Terms & Conditions wo manta hai aur uska data use karne ki
hume permission hai kyunki wo hamare yaha kaam karta hai."

## FLOW (naya)

```
Login
  -> CONSENT DIALOG (ek hi screen):
       - role ke hisaab se saari permissions + har ek ka reason
         (sab roles: Location, Notification, Motion, Background-location,
          Battery-exempt | worker+sales me EXTRA: App usage access [OPTIONAL])
       - "Privacy Policy padho" button -> poora policy screen (offline bhi)
       - CHECKBOX: T&C + data-use permission (employment basis)
       - Accept (checkbox ke bina band)
  -> PERMISSIONS WIZARD:
       - Android system prompts EK-EK karke (ye Android ka rule hai — system
         dialogs combine nahi ho sakte; hamara dialog pehle sab explain karta hai)
       - har row par LIVE status tick (permStatus 2.5s poll)
       - background-location -> app settings deep-link ("Allow all the time")
       - battery -> system exemption dialog; usage-access -> usage settings
       - "Aage badho" — pending permissions skip allowed (location gate
         baad me phir poochega)
  -> LOCATION GATE (pehle jaisa) -> Home
Ek baar accept = localStorage flag -> agli open par SKIP (smooth boot).
```

## NAYI FILES

- `src/screens/ConsentGate.tsx` — consent dialog + wizard + Firestore record
  (`consents/{uid}`: uid/name/mobile/role/policyVersion/acceptedAt/userAgent;
  offline fail par pending flag, agli open par silent retry).
- `src/screens/PrivacyPolicy.tsx` — in-app policy (9 sections): kya data,
  kya KABHI nahi (photos/chats/screen-content/dukan-bahar usage), Firebase
  storage + sirf management access, permissions kyun, fake-GPS detection,
  retention/deletion, consent withdrawal, policy versioning.
- `public/privacy.html` — hosted copy (Firebase Hosting deploy me dist ke
  saath jata hai; same text, dark theme, mobile-friendly).

## PLUGIN (LocationGuardPlugin.java) — 5 naye @PluginMethod

- `permStatus()` — fine/coarse/bg-location/notifications/motion/battery/usage
  sab ka snapshot (API-level aware: 29 ke niche motion/bg true, 33 ke niche
  notification true; usage = AppOps OPSTR_GET_USAGE_STATS). Kabhi throw nahi.
- `requestPermissions()` — fine+coarse + notification(33+) + motion(29+) ek
  saath queue. BACKGROUND-LOCATION JAAN-BOOJH KAR NAHI — Android 11+ par
  saath maangne par system chup-chaap deny karta hai; wizard settings se
  "Allow all the time" karwata hai (openAppSettings()).
- `requestBatteryExemption()` — system exemption dialog (pehle se exempt =
  asked:false).
- `requestUsageAccess()` — ACTION_USAGE_ACCESS_SETTINGS (optional step).
- `openAppSettings()` — ACTION_APPLICATION_DETAILS_SETTINGS.

`src/lib/locationGuard.ts` me `PermStatus` type + 5 bindings.

## WIRING

`App.tsx`: `ConsentGate -> LocationGate -> Home` (consent gate sabse pehle —
location gate uske andar; manager bhi consent dialog dekhega, uska wizard me
usage-access row NAHI hai sirf worker/sales ke liye hai).

## IMPORTANT NOTES

- Privacy policy me app-usage tracking likha hai (Plan B ke liye) — uski line
  saaf kehti hai "sirf minutes ka total, screen content nahi, sirf dukan ke
  time". Usage-tracking ka code ABHI nahi hai (Plan B pending) — policy pehle
  se utha kar rakhti hai taaki feature aaye to naya consent na lage.
- Policy text DONO jagah same rakho: PrivacyPolicy.tsx + public/privacy.html.
- Consent doc Firestore RULES abhi wide-open hain (P1 known) — rules lock
  karte waqt `consents` collection bhi cover karna (write: own uid only).
