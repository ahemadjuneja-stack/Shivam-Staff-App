# SILENT WATCH v1 — Worker 100m Lock + Sales Off-Tour Silent Tower Pings

Boss order 2026-11-17 (same day, three rules):

1. "Worker 100 mitter ke andar ho tabhi app on ho... aur bahar jaye to app lock.
   Location On rakhna zaroori hai."
2. "Salesman ke mobile me jab wo tour par naa ho aur app naa bhi on kare tab
   tower id application background me lena chahiye aur manager ko bhejna chahiye
   take pata lage ke wo sach bol raha hai ya juth aur wo kaha hai."
3. "Background me silent me app chalao magar notifications nahi aana chahiye ke
   app kuch kuch der me khul kar uski location bhej raha hai."

## Architecture — ZERO notification, ZERO foreground service

Both silent engines run on **AlarmManager (setAndAllowWhileIdle) -> SilentAlarmReceiver
-> JobScheduler (SilentJobService)** — the process wakes, does radio reads + one
Firestore REST write, and sleeps. Nothing appears on screen, in the notification
drawer, or in the status bar. Battery ~1-2%/day class (vs GPS FGS 10-25%/day).

    Alarm (3min on-duty / 15min off-duty worker, 15min sales)
      -> SilentAlarmReceiver (thin)
      -> JobScheduler one-shot job (4401 worker / 4402 sales)
      -> WorkerSilentEngine.run()  /  SalesSilentEngine.run()
      -> self re-arm

## Worker engine (WorkerSilentEngine.java)

- **IN_SHOP detection order (cheap -> expensive):**
  1. **WiFi fingerprint** — match scan results against `config/shop_wifi`
     (shop AP set). >=2 shop APs (or 1 AP >= -65dBm) = IN_SHOP, **GPS chip off**.
  2. **GPS hysteresis** (only when WiFi has no verdict): dist <= 100m = IN_SHOP
     (Boss: "100 mitter"), >= 150m = OUTSIDE, between = keep previous state
     (GPS-noise buffer). Tower change triggers an immediate GPS check.
- **LOCK LATCH**: OUTSIDE confirmed while on-duty -> `worker_live.lock=true`
  + `worker_alerts` (left_shop) + manager SHOP WATCH red chip. Worker app shows
  full-screen WorkerLock (reason send button). Back IN (auto unlock) or manager
  unlock (Home card / StaffDetail) -> lock=false. Native writes `lock` field
  ONLY on transitions — manager's manual unlock is never overwritten.
- **Learning loop** ("improvement hota rahe"): every confirmed fix + scan ->
  `wifi_samples/ws-{uid}-{ts}` (8-sample batches). Manager app aggregates
  (src/lib/shopWifi.ts): APs seen in >=60% of in-shop samples become the shop
  fingerprint in `config/shop_wifi`; workers' native engines refetch it every 6h.
  Cold start = GPS hysteresis path while fingerprint is empty.
- **Location OFF** -> state LOC_OFF (manager sees amber/red) — Boss: location
  ON rakhna zaroori (WiFi scan results need it on Android 10+).
- Off-duty = 15-min light ping (tower + battery), no lock, no GPS.

## Sales silent engine (SalesSilentEngine.java)

- `LocationTrackService` (FGS) keeps handling TOUR mode (GPS bursts, visits).
- **HANDOFF**: WatchdogReceiver checks every 15 min — if FGS is in HOME mode
  (not on tour) AND app is not foreground -> writes `sales_live` SILENT marker,
  schedules the ping chain, stops the FGS. **Notification disappears.**
- Ping every 15 min: serving tower read (CellTowerWatcher, GPS/internet not
  needed) + last-known/NETWORK fix (no GPS chip) + CellDbCache city ->
  `sales_live/{uid}` (state SILENT) + `users/{uid}` lastLocation patch +
  `tower_pings/tp-{uid}-{ts}` (StaffDetail "SILENT TOWER TRAIL" card).
- **Tour auto-resume**: ping sees last-known 10km+ from home -> FGS restarts
  (ACCESS_BACKGROUND_LOCATION holder — background FGS-start exemption).
- Boot: lastTourMode=true -> FGS; else -> silent ping chain.

## Manager UI (in-app; separate dashboard reads same Firestore docs)

- **SHOP WATCH card** (Home, workers): live chips — LOCKED / SHOP SE BAHAR (red,
  top) / LOCATION OFF (amber) / SHOP ME HAI (green) + distance + wifi/gps source
  + UNLOCK button. Locked/outside rows sort to the top.
- **StaffDetail worker**: SHOP PRESENCE card (state, detection source, battery,
  UNLOCK NOW, today's alerts incl. worker's reason messages).
- **StaffDetail sales**: SILENT TOWER TRAIL card (today's 15-min tower pings —
  sach-verification: claimed time par kis tower/city me tha).
- **SalesLive board**: new SILENT state chip (violet).

## Consent / Privacy

- T&C text + Privacy Policy v3 (in-app + public/privacy.html): nearby Wi-Fi
  router IDs (shop presence only — never connect, never read traffic), worker
  shop-presence state, sales off-tour silent tower pings.
- Consent gate key is now policy-version-aware -> staff see the updated dialog
  once, then smooth skip again.

## Files

Native (com.shivam.staff): RestIo.java (new), WorkerSilentEngine.java (new),
SalesSilentEngine.java (new), SilentJobService.java (new),
SilentAlarmReceiver.java (new), SilentWatchPlugin.java (new),
LocationTrackService.java (handoff + lastTourMode pref + ping cancel on start),
WatchdogReceiver.java (dual-mode brain), BootReceiver.java (dual-mode),
MainActivity.java (plugin register), AndroidManifest.xml (2 receivers + 1 job
service + ACCESS_WIFI_STATE/CHANGE_WIFI_STATE).

JS: src/lib/workerLive.ts (new), src/lib/shopWifi.ts (new),
src/screens/WorkerLock.tsx (new), src/screens/Home.tsx (lock overlay, duty
sync, SHOP WATCH card, aggregation), src/screens/StaffDetail.tsx (SHOP PRESENCE
+ SILENT TOWER TRAIL), src/screens/SalesLive.tsx (SILENT chip),
src/screens/ConsentGate.tsx (v3 re-consent + T&C text),
src/screens/PrivacyPolicy.tsx + public/privacy.html (v3 disclosures),
src/App.tsx (worker engine start/stop).

## Firestore collections (new)

worker_live/{uid}, worker_alerts/wa-{uid}-{ts}, wifi_samples/ws-{uid}-{ts},
tower_pings/tp-{uid}-{ts}, config/shop_wifi.
Existing (untouched): users, sales_live, cell_towers, loc_sessions, ...

## Deferred (next phases)

- Plan B app-usage stats display (usage-access permission row already in wizard).
- FCM push for manager alerts (v1 = in-app polling chips, Boss ka default).
- Firestore rules hardening + native REST auth token (P1 from hybrid build).
