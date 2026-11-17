# HYBRID LOCATION TRACKING SYSTEM — Sales Role (Boss Order 2026-11-17)

**"Rail jaise system — jaise where is my train me internet band ho location
band ho tab bhi tower id se pata chalta hai train kaha pohchi hai"** +
**"app open hote hi sab se pehle gps location bheje"** +
**"har 15 min me app unka data manager ke role me share karegi"** +
**"galati ki koi gunjaish nahi — galati hui to fayda salesmen ko hoga boss ko nahi"**

---

## 1. KAISE CHALTA HAI (Sales ki poori journey)

```
Ghar se nikla, APP OPEN kiya
  -> LocationGate (already tha): bina GPS fix app me ENTER NAHI hota
  -> Gate pass = FRESH GPS fix native ko
  -> Native: session open + serving TOWER read + TOWER LEARNING
     + sales_live/{uid} write  <- manager ko TURANT pata (app_open)

TOUR MODE (home base/shop se 10km+ door — BOSS-LOCKED shop center se):
  -> GPS chip BAND (battery bachat)
  -> NETWORK (tower/wifi) ping har 15 MIN + PASSIVE free fixes
  -> Har ping: tower key (mcc-mnc-lac-cid) -> city (offline DB se)
     + sales_live/{uid} write = MANAGER KO HAR 15 MIN DATA
  -> Internet band ho to bhi: tower key local DB se city deta hai

DWELL (kisi shop/client ke paas 15 min RUKA):
  -> Ek baar ONE-TIME GPS BURST (45s window, high accuracy)
  -> sales_visits/{sv-uid-at} = CLIENT VISIT LOG (exact lat/lng + dwellMin)
  -> GPS turant wapas BAND — wapas low-power engine

CHAL PADA (dwell todo / visit khatam):
  -> Anchor reset -> TRANSIT wapas (GPS band rahega)
  -> Har dwell-episode ka sirf EK visit log (dedupe — double entry kabhi nahi)

SHOP WAPAS (10km ke andar):
  -> HOME mode: pehle jaisa precise road-map engine (GPS on, purana system)

LOCATION BAND KIYA:
  -> app lock (already tha) + sales_live me LOC_OFF red alert
     (aakhri tower/city ke saath — manager ko turant dikhta hai)
```

## 2. STATE MACHINE

```
HOME -> TRANSIT -> DWELL -> [GPS BURST] -> VISIT -> (move) -> TRANSIT
  ^                                                               |
  +------------------------- (shop wapas 10km ke andar) ----------+
```

| State | GPS chip | Manager ko dikhta hai |
|---|---|---|
| SHOP (HOME) | ON (purana engine) | SHOP + precise location (2-min) |
| TRANSIT | OFF | TRANSIT + city (15-min) |
| DWELL | OFF | DWELL (ruka hua, 15-min confirm ho raha) |
| VISIT | ON sirf 45s burst | VISIT + exact visit log |
| LOC OFF | - | RED LOC_OFF + aakhri jagah |

## 3. FIRESTORE DATA (naye collections)

### `sales_live/{uid}` — LIVE status (full replace har ping par)
```json
{
  "uid": "...", "name": "Sales Name",
  "state": "TRANSIT",            // HOME|TRANSIT|DWELL|VISIT|LOC_OFF
  "tourMode": true,
  "lat": 27.1767, "lng": 78.0081, "acc": 350,
  "src": "network",              // app_open|network|gps_burst|svc|burst_timeout
  "city": "Agra", "citySrc": "tower_db",  // geocoder|tower_db|tower_near|home|none
  "cellKey": "404-45-12345-67890123",
  "cell": { "mcc": "404", "mnc": "45", "lac": 12345, "cid": 67890123, "dbm": -87 },
  "batteryPct": 68, "charging": false,
  "flags": [],                   // gps_teleport | mock_location | gps_low_accuracy | gps_tower_mismatch
  "todayVisits": 3,
  "lastVisitAt": 1763369100000, "lastVisitCity": "Agra",
  "at": 1763369100000, "versionCode": 82, "deviceModel": "..."
}
```

### `sales_visits/{sv-uid-at}` — CLIENT VISIT LOG (append-only)
```json
{
  "uid": "...", "name": "Sales Name",
  "at": 1763369100000, "arrivedAt": 1763367780000, "dwellMin": 22,
  "lat": 27.17670, "lng": 78.00811, "acc": 12,
  "city": "Agra", "citySrc": "geocoder",
  "cellKey": "404-45-12345-67890123",
  "mock": false,
  "flags": [],
  "src": "hybrid_burst", "versionCode": 82, "deviceModel": "..."
}
```

### `cell_towers/{mcc-mnc-lac-cid}` — SELF-LEARNING TOWER DB
```json
{ "key": "404-45-12345-67890123", "lat": 27.1766, "lng": 78.0080,
  "acc": 15, "city": "Agra", "samples": 7, "updatedAt": 1763369100000 }
```

**Tower DB do raaston se bharta hai:**
1. **Self-learning (native):** accurate GPS fix (<=60m) + serving tower mila ->
   `cell_towers` me upsert + phone ki local file me record. Jitna sales
   ghumega DB utna mota.
2. **Team sync (JS):** har sales app open kare to Firestore `cell_towers` ->
   apne phone ke native cache me merge (incremental — `updatedAt > lastSync`).
   **Ye hi "where is my train" ka offline magic hai:** dusré staff ke learned
   towers se, net BAND hone par bhi, serving tower key se city nikal aati hai.

## 4. ANTI-CHEAT LAYER (Boss ka sabse bada dar — salesmen ka fayda, boss ka nuksaan)

| Cheating tarika | System ka jawab |
|---|---|
| Fake GPS app (location spoof) | `mock_location` flag (Location.isMock) + **`gps_tower_mismatch`**: fake app GPS 100km door le jata hai par SIM REAL tower se judi rehti hai — burst GPS vs serving tower 15km+ door = flag. Ye sabse strong signal hai. |
| Internet band karke ghumna | GPS offline bhi chalta hai; visit logs queue me — net wapas aate hi flush. Tower se city offline milti hai. |
| Location band karke baithna | App turant lock (pehle se tha) + `LOC_OFF` red alert + `loc_events` off + duty auto OUT (pehle se tha). Manager board par red ring. |
| Force-close app | Watchdog 15-min alarm + BootReceiver restart (pehle se tha) + sales_live STALE (35min+) board par amber. |
| Phone ka time bigadna | `integrity.ts` ka clock-offset layer (pehle se tha) + at/deviceEpoch field manager comparison ke liye. |
| Visit chhupna (GPS na mila) | Burst 45s me fix nahi -> aakhri fix se approximate visit (LOW ACC flag ke saath) — visit log kabhi silent-missing nahi hota. Underground me fix hi nahi -> next ping par burst RETRY. |
| Battery chhupana | `batteryPct` + `charging` har ping par — phone band/chhupana board par dikh jata hai. |

## 5. FILES (kya badla, kya naya)

### NAYE (4)
| File | Kaam |
|---|---|
| `android/.../CellTowerWatcher.java` | Serving tower read (mcc/mnc/lac/cid/dbm + key). API 28 guard — Android 6/7 pe crash-proof. |
| `android/.../CellDbCache.java` | Offline tower->city DB (JSON file `filesDir/cell_towers.json`) — lookup/nearest-city/record/merge, LRU cap 3000. |
| `src/lib/salesLive.ts` | Cell DB sync (Firestore -> native cache) + SalesLiveDoc/SalesVisitDoc types + time helpers. |
| `src/screens/SalesLive.tsx` | MANAGER board: har sales ka live state/city/battery/visits + alerts + aaj ki visits detail. Slide-swipe se band. |

### MODIFIED (5)
| File | Change |
|---|---|
| `android/.../LocationTrackService.java` | +Hybrid tour engine: TOUR/HOME mode switch, tower pipeline, dwell>=15min -> one-time GPS burst, sales_live/sales_visits/cell_towers REST writes, anti-cheat (teleport/mock/mismatch), offline queue tags (live/visit/tower), visit day-roll, battery read. Threading-safe: Geocoder body pool thread par (main-thread ANR impossible). |
| `android/.../LocationGuardPlugin.java` | startTracking me homeLat/homeLng/homeCity accept; +pushCellDb (team tower sync); +getCellInfo (diagnostics). |
| `src/lib/locationGuard.ts` | Plugin interface extend (pushCellDb/getCellInfo/home base params). |
| `src/App.tsx` | startTracking ab BOSS-LOCKED shop center + profile.city bhejta hai + syncCellDbToNative() call. |
| `src/screens/Home.tsx` | Manager bottom-row me "Sales Tour Live" button + SalesLive screen render. |

### Nahi badla (jana-bujh kar)
- Worker/manager ka tracking — sirf sales par hybrid (native guard already sales-only hai).
- LocationGate (pehle se hi "bina location enter nahi" + instant lock tha).
- loc_sessions/loc_events/punches/duty — purana system waise ka waisa (StaffDetail road-map ab bhi chalta hai).

## 6. PERMISSIONS — KUCH NAYA NAHI CHAHIYE
Cell tower read ke liye `ACCESS_FINE_LOCATION` already manifest me hai
(Android 10+ requirement), battery ke liye koi permission nahi, tower DB file
app-internal hai. **Koi naya permission nahi, koi naya library/dependency
nahi** (java.net + org.json pattern wahi — APK size zero impact).

## 7. TEST PLAN (Boss ke liye)

1. **Login sales se (shop par):** board me "SHOP" state, precise location.
2. **Tour niklo (10km+):** Sales Tour Live board me state `TRANSIT`, city
   naam (geocoder/tower), TOUR badge. Battery 1-2% se bhi kam.
3. **Kisi shop pe 15+ min ruko:** ~15-30 min me state `VISIT` + visit log
   (exact coords + dwellMin). Aaj ke visits count badhega.
4. **Net OFF karo tour me:** location/visits record hote rahenge — net ON
   hone par sab flush (sales_live latest + visits + tower learning).
5. **Location OFF karo:** app turant lock + board par red `LOC OFF`.
6. **Fake GPS app se test:** `MOCK GPS` flag + `TOWER MISMATCH` flag board par.
7. **Manager login:** Home -> "Sales Tour Live" button -> poora board.

**Important:** Tower DB pehle din khali hoga (self-learning hai) — pehle
tours ke baad hi offline city resolution full mazedaar hogi (Where-is-my-train
bhi isi tarah saalon me DB banaya tha). GPS/net wale din DB khud-ba-khud bharta
jayega, team sync se har phone me.

## 8. VERIFICATION STATUS
- `tsc --noEmit` (lint): PASS
- `vite build` (production web build): PASS
- tourHisab test suite: 29/29 PASS
- Java: brace-balance + duplicate-method checks PASS; API-level crash guard
  (Android 6-8) verified; repo me Android SDK nahi hai isliye APK build CI
  (GitHub Actions) par hoga — wahan pehla build proof hoga.
- CI versionCode: run_number se auto — koi manual bump nahi chahiye.

## 9. YAAD RAKHNE WALI BAAT (P1 — pehle se pending)
Firestore rules abhi bhi wide-open hain (`allow read, write: if true`) aur
native REST bina auth token ke likhta hai (pehle ke system ki tarah — naya
system bhi same pattern follow karta hai taaki sab kuch aaj hi kaam kare).
Jab din ho, rules lock + native me token — dono SAATH me karna (ek akela
karoge to tracking toot jayegi). Naya system me collections ka pura write
`queueOp` + REST helper me centralized hai — token wahan ek jagah lagana hai.
