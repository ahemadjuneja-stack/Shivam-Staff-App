import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import Avatar from '../components/Avatar';
import {
  MapPin, RadioTower, Battery, BatteryCharging, Clock, ChevronDown, ShieldAlert, Footprints
} from 'lucide-react';
import { useSwipeBack, SWIPE_OVERLAY_STYLE } from '../lib/swipeBack';
import { fmtClock } from '../lib/onDuty';
import { SalesLiveDoc, SalesVisitDoc, fmtAgoShort, todayStartMs } from '../lib/salesLive';
import type { UserProfile } from '../types';

// ============================================================
// SALES — TOUR LIVE BOARD (Boss order 2026-11-17):
// "har 15 min me app unka data manager ke role me share karegi" +
// "tower id se pata chalna chahiye kis area ke tower se connect hai".
//
// NATIVE hybrid engine (LocationTrackService) likhta hai:
//   sales_live/{uid}    <- 15-min ping (tour) / 2-min (shop) live state
//   sales_visits/{sv-}  <- 15-min ruka = ONE-TIME GPS burst = visit log
//
// ROW ME KYA HAI:
//   - STATE chip: HOME | TRANSIT | DWELL | VISIT | LOC_OFF | STALE (35min+)
//   - CITY: GPS geocoder ya TOWER-ID se (tower icon = offline tower proof)
//   - Battery + charging (phone band/battery drain bhi ek signal hai)
//   - Aaj ke VISITS count (GPS burst logs)
//   - ALERTS: MOCK GPS / TELEPORT / TOWER MISMATCH / LOW ACC (anti-cheat —
//     Boss: "galati hui to fayda salesmen ko hoga boss ko nahi")
// Row tap -> usi sales ki aaj ki visits (time, city, dwell, accuracy).
// 100% READ-ONLY — koi write nahi, battery ZERO impact. Sirf MANAGER.
// ============================================================

const STALE_MS = 35 * 60 * 1000; // 15-min ping + buffer — isse purana = STALE

const STATE_META: Record<string, { label: string; cls: string }> = {
  HOME: { label: 'SHOP', cls: 'bg-slate-400/15 text-slate-300' },
  TRANSIT: { label: 'TRANSIT', cls: 'bg-sky-400/15 text-sky-300' },
  DWELL: { label: 'DWELL', cls: 'bg-amber-400/15 text-amber-300' },
  VISIT: { label: 'VISIT', cls: 'bg-emerald-400/15 text-emerald-300' },
  LOC_OFF: { label: 'LOC OFF', cls: 'bg-rose-500/20 text-rose-300' },
  SILENT: { label: 'SILENT', cls: 'bg-violet-400/15 text-violet-300' },
  STALE: { label: 'STALE', cls: 'bg-amber-500/10 text-amber-400/80 border border-amber-500/30' }
};

const FLAG_LABELS: Record<string, string> = {
  mock_location: 'MOCK GPS',
  gps_teleport: 'TELEPORT',
  gps_tower_mismatch: 'TOWER MISMATCH',
  gps_low_accuracy: 'LOW ACC'
};

interface SalesRow {
  uid: string;
  name: string;
  photo?: string;
  live?: SalesLiveDoc;
  state: string; // HOME/TRANSIT/.../STALE
  visits: SalesVisitDoc[];
}

export default function SalesLiveScreen({
  profile,
  onBack
}: {
  profile: UserProfile;
  onBack: () => void;
}) {
  const slideRef = useSwipeBack(onBack);
  const [salesUsers, setSalesUsers] = useState<Array<{ uid: string; name: string; photo?: string }>>([]);
  const [liveMap, setLiveMap] = useState<Record<string, SalesLiveDoc>>({});
  const [visitsToday, setVisitsToday] = useState<SalesVisitDoc[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // (1) active sales users (naam + DP)
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    unsubs.push(
      onSnapshot(query(collection(db, 'users'), where('status', '==', 'active')), (snap) => {
        const rows: Array<{ uid: string; name: string; photo?: string }> = [];
        snap.forEach((d) => {
          const v = d.data() as any;
          const r = String(v.role || '');
          if (r !== 'sales' && r !== 'salesman' && r !== 'sales_manager') return;
          rows.push({
            uid: d.id,
            name: String(v.name || 'Sales'),
            photo: typeof v.photo === 'string' && v.photo ? v.photo : undefined
          });
        });
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setSalesUsers(rows);
      }, () => {})
    );
    // (2) sales_live — native engine ka 15-min feed (realtime listener)
    unsubs.push(
      onSnapshot(collection(db, 'sales_live'), (snap) => {
        const m: Record<string, SalesLiveDoc> = {};
        snap.forEach((d) => {
          const v = d.data() as SalesLiveDoc;
          m[d.id] = { ...v, uid: d.id };
        });
        setLiveMap(m);
      }, () => {})
    );
    // (3) aaj ke visits — GPS burst logs (single-field range query, index nahi chahiye)
    unsubs.push(
      onSnapshot(query(collection(db, 'sales_visits'), where('at', '>=', todayStartMs())), (snap) => {
        const rows: SalesVisitDoc[] = [];
        snap.forEach((d) => {
          const v = d.data() as SalesVisitDoc;
          if (v && typeof v.at === 'number') rows.push(v);
        });
        rows.sort((a, b) => b.at - a.at);
        setVisitsToday(rows);
      }, () => {})
    );
    // (4) 30s tick — ago labels fresh
    const t = window.setInterval(() => setTick((x) => x + 1), 30 * 1000);
    return () => {
      unsubs.forEach((u) => u());
      window.clearInterval(t);
    };
  }, []);

  const now = Date.now();
  const rows = useMemo<SalesRow[]>(() => {
    return salesUsers.map((u) => {
      const live = liveMap[u.uid];
      let state = live?.state || 'STALE';
      // live doc purana (35min+) = STALE — 15-min ping ki bhi update nahi aa rahi
      if (live?.at && state !== 'LOC_OFF' && now - live.at > STALE_MS) state = 'STALE';
      const visits = visitsToday.filter((v) => v.uid === u.uid);
      return { uid: u.uid, name: u.name, photo: u.photo, live, state, visits };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesUsers, liveMap, visitsToday, tick, now]);

  const tourCount = rows.filter((r) => r.live?.tourMode).length;
  const alertCount = rows.reduce(
    (n, r) => n + (r.live?.flags?.some((f) => f !== 'gps_low_accuracy') ? 1 : 0),
    0
  );

  return (
    <div ref={slideRef} className="fixed inset-0 z-[60] overflow-y-auto bg-[#0A1220] px-4 text-slate-100" style={SWIPE_OVERLAY_STYLE}>
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-sky-500/10" />
      <div className="ambient-orb top-[45%] -left-20 h-56 w-56 bg-emerald-400/10" />

      {/* Header */}
      <div className="relative z-10 pb-3 pt-6">
        <div className="flex items-center gap-2.5">
          <RadioTower className="h-5 w-5 text-sky-300" />
          <h1 className="text-[17px] font-extrabold tracking-wide text-slate-100">SALES — TOUR LIVE</h1>
          <span className="rounded-full border border-white/10 bg-[#101B31] px-2 py-px text-[10px] font-bold text-slate-300">
            {rows.length}
          </span>
          <span className="relative ml-auto flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-400" />
          </span>
        </div>
        <p className="mt-1 text-[11.5px] text-slate-500">
          Har 15-min tower/GPS ping · 15-min ruka = exact visit (GPS burst)
          {tourCount > 0 ? ` · ${tourCount} TOUR mode` : ''}
          {alertCount > 0 ? ` · ${alertCount} ALERT` : ''}
        </p>
        <p className="mt-0.5 text-[10.5px] text-slate-600">Swipe left se band ({profile.name} — manager view)</p>
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <div className="glass-card relative z-10 rounded-2xl p-5">
          <p className="text-[13px] text-slate-500">Koi active sales user nahi mila.</p>
        </div>
      ) : (
        <div className="relative z-10 space-y-2.5 pb-10">
          {rows.map((r) => {
            const meta = STATE_META[r.state] || STATE_META.STALE;
            const staled = r.state === 'STALE';
            const flags = (r.live?.flags || []).filter((f) => f !== 'gps_low_accuracy');
            const isTowerCity = r.live?.citySrc === 'tower_db' || r.live?.citySrc === 'tower_near';
            const expandedOpen = expanded === r.uid;
            return (
              <div key={r.uid} className="glass-card overflow-hidden rounded-2xl">
                <button
                  onClick={() => setExpanded(expandedOpen ? null : r.uid)}
                  className="flex w-full items-center gap-3 p-3.5 text-left transition active:scale-[0.99]"
                >
                  <div
                    className="rounded-full"
                    style={
                      r.state === 'LOC_OFF'
                        ? { boxShadow: '0 0 0 2px rgba(244,63,94,0.55)' }
                        : !staled && r.live?.at
                        ? { boxShadow: '0 0 0 2px rgba(52,211,153,0.55)' }
                        : undefined
                    }
                  >
                    <Avatar photo={r.photo} name={r.name} size={40} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[14.5px] font-bold text-slate-100">{r.name}</span>
                      <span className={`rounded px-1.5 py-px text-[8.5px] font-extrabold tracking-wider ${meta.cls}`}>
                        {meta.label}
                      </span>
                      {r.live?.tourMode && (
                        <span className="rounded bg-violet-400/15 px-1 py-px text-[8.5px] font-extrabold tracking-wider text-violet-300">
                          TOUR
                        </span>
                      )}
                      {flags.length > 0 && (
                        <span className="flex items-center gap-0.5 rounded bg-rose-500/15 px-1 py-px text-[8.5px] font-extrabold tracking-wider text-rose-300">
                          <ShieldAlert className="h-2.5 w-2.5" />
                          {flags.map((f) => FLAG_LABELS[f] || f).join(' + ')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-slate-400">
                      <MapPin
                        className={`h-3 w-3 shrink-0 ${
                          r.state === 'LOC_OFF' ? 'text-rose-400' : staled ? 'text-slate-600' : 'text-emerald-300'
                        }`}
                      />
                      <span className="truncate">
                        {r.live?.city ? r.live.city : r.live?.lat ? `${r.live.lat.toFixed(3)}, ${r.live.lng?.toFixed(3)}` : 'Location nahi aayi'}
                      </span>
                      {isTowerCity && (
                        <RadioTower className="h-3 w-3 shrink-0 text-sky-400" />
                      )}
                      {r.live?.at ? (
                        <span className="shrink-0 text-slate-500">· {fmtAgoShort(r.live.at, now)} pehle</span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
                      {/* Battery (charging bhi dikhe — phone chhupana mushkil) */}
                      <span className="flex items-center gap-1">
                        {r.live?.charging ? (
                          <BatteryCharging className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Battery className={`h-3.5 w-3.5 ${((r.live?.batteryPct ?? 100) <= 20 ? 'text-rose-400' : 'text-slate-500')}`} />
                        )}
                        {typeof r.live?.batteryPct === 'number' ? `${r.live.batteryPct}%` : '—'}
                      </span>
                      {/* Aaj ke visits (GPS burst = exact client stop) */}
                      <span className="flex items-center gap-1">
                        <Footprints className="h-3.5 w-3.5 text-amber-400/80" />
                        {r.visits.length} visit{r.visits.length === 1 ? '' : 's'}
                      </span>
                      {/* Serving tower key (rail-system proof — manager verify) */}
                      {r.live?.cellKey && (
                        <span className="flex items-center gap-1 truncate text-slate-600">
                          <RadioTower className="h-3 w-3" />
                          <span className="max-w-[110px] truncate">{r.live.cellKey}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${expandedOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                {/* EXPANDED — aaj ki visits (time, city, dwell, accuracy, flags) */}
                {expandedOpen && (
                  <div className="border-t border-white/[0.06] px-4 py-2.5">
                    {r.visits.length === 0 ? (
                      <p className="py-1.5 text-[12px] text-slate-500">
                        Aaj koi visit log nahi — 15 min se zyada kahin ruka hi nahi (ya update abhi aani hai).
                      </p>
                    ) : (
                      <div className="divide-y divide-white/[0.05]">
                        {r.visits.map((v, i) => (
                          <div key={`${v.at}-${i}`} className="flex items-center gap-2.5 py-2">
                            <span className="w-[54px] shrink-0 text-[11px] font-bold tabular-nums text-slate-400">
                              {fmtClock(v.at)}
                            </span>
                            <MapPin className="h-3 w-3 shrink-0 text-slate-500" />
                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-slate-200">
                              {v.city || `${v.lat.toFixed(3)}, ${v.lng.toFixed(3)}`}
                            </span>
                            <span className="shrink-0 text-[11px] text-slate-400">
                              {typeof v.dwellMin === 'number' ? `${v.dwellMin}min` : ''}
                              {typeof v.acc === 'number' ? ` · ±${Math.round(v.acc)}m` : ''}
                            </span>
                            {(v.flags?.length || v.mock) && (
                              <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {r.live?.lastVisitAt ? (
                      <p className="pb-1 pt-1 text-[10.5px] text-slate-600">
                        <Clock className="mr-1 inline h-3 w-3" />
                        Last visit: {fmtClock(r.live.lastVisitAt)}
                        {r.live.lastVisitCity ? ` (${r.live.lastVisitCity})` : ''}
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {/* Legend — manager ko system ki samajh (Boss transparency rule) */}
          <div className="glass-card rounded-2xl p-4">
            <p className="text-[11px] font-extrabold tracking-wider text-slate-400">SYSTEM — KAISE CHALTA HAI</p>
            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
              <li>· SHOP (10km ke andar): poora precise GPS road-map (pehle jaisa).</li>
              <li>· TOUR (10km+ door): GPS chip BAND — sirf tower/NETWORK 15-min ping = battery bachat.</li>
              <li>· 15 min ek jagah ruka = ONE-TIME GPS burst = exact visit log (city + dwell time).</li>
              <li>· Tower icon wali city = TOWER-ID se (internet band hone par bhi chalti hai).</li>
              <li>· LOC OFF red = us waqt location band ki (jagah ke saath — chhupna impossible).</li>
              <li>· MOCK/TELEPORT/TOWER MISMATCH = fake-GPS ke signals — verification Boss ke liye.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
