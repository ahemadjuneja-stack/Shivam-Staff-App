import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import Avatar from '../components/Avatar';
import {
  MapPin, Pin, PinOff, Clock, CheckCircle2, LogIn, LogOut, Timer, Footprints, Compass,
  CalendarDays, History, ChevronDown, Power
} from 'lucide-react';
import { useSwipeBack, SWIPE_OVERLAY_STYLE } from '../lib/swipeBack';
import {
  CityCoord, DutyUserMeta, PunchLike, OutsideLogLike,
  nearestCity, fmtAgo, fmtClock,
  summarizePunchesToday, daysSinceOn, isUnannouncedOutside, FRESH_WINDOW_MS,
  buildDayTracks, openSessionLastActive,
  DayTrack, RawSessionLike, RawLocEventLike
} from '../lib/onDuty';

// "15M" | "2H 30M" | "4H"
const fmtDurLocal = (min: number): string => {
  const m = Math.round(min);
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}H ${rm}M` : `${h}H`;
};

// ============================================================
// STAFF DETAIL SCREEN (Boss order 2026-10-28):
// Board ki row/DP par tap -> yeh screen khulti hai (sirf MANAGER ke liye).
//
// SALES — DATE AUR DIN KE HISAB SE (Boss 2nd order: "Salesmen ka data Date
//   aur din ke hisab se karo — DP par click ho aaj kaha gaya, uske bad kis
//   date me kaha gaya kitne baje location on kiya us din ka khatam, uske
//   niche purani date 8 din ka data"):
//     1) AAJ card — aaj location kitne baje ON kiya + din ka khatam (abhi
//        ON hai ya kitne baje band) + aaj ka poora route (chronological)
//     2) PURANE DIN — pichle 8 calendar din (naye purane): har date ki row
//        (date + din) me ON time + khatam time + route summary; tap par us
//        din ka poora kaha-kaha-gaya list khulta hai. Jis din location ON
//        nahi hui wo bhi row dikhti hai ("us din location ON nahi ki") —
//        non-compliance chhupti nahi.
//     Banner: open session + 12h activity = "abhi ON hai"; warna calendar
//     days ("Location N din purana hai") — zombie-session honest fix.
// WORKER: kitne baje duty par aaya, kab duty off ki, total on-duty + aaj ke
//   BINA-BATAYE bahar events (dukan ke kaam / authorized = approved ya
//   allowedMin wale HIDE — Boss rule).
//
// Har din LOCAL midnight bucket [raat 12, agle raat 12) — new din new data;
// resume-session ke points apne-apne din me sort hote hain (locTrack ke 12h
// resume rule ke saath compatible). Sab queries equality-only (composite
// index ki zaroorat nahi — app ke established patterns). BOSS RULE: koi
// back button nahi — left-edge slide se band (useSwipeBack).
// ============================================================

export interface StaffDetailTarget {
  uid: string;
  name: string;
  role: 'worker' | 'sales';
  photo?: string;
}

interface TourStop {
  at: number;
  label: string;
}

// consecutive duplicate labels dedupe -> "Bhuj → Mundra → Bhuj" (route summary)
function routeSummary(stops: TourStop[]): string {
  const seq: string[] = [];
  for (const s of stops) {
    if (seq.length === 0 || seq[seq.length - 1] !== s.label) seq.push(s.label);
  }
  return seq.join(' → ');
}

// PURANE DIN ki ek row — collapsed: date + ON/Khatam times + route summary;
// tap -> us din ka poora kaha-kaha-gaya list (empty din = "ON nahi ki")
function DayRow({ day, expanded, onToggle }: { day: DayTrack; expanded: boolean; onToggle: () => void }) {
  if (!day.hasData) {
    return (
      <div className="py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-bold text-slate-400">{day.dayLabel}</span>
          <span className="text-[11px] text-slate-600">—</span>
        </div>
        <p className="mt-0.5 text-[11.5px] text-amber-300/60">Us din location ON nahi ki</p>
      </div>
    );
  }
  return (
    <div className="py-1">
      <button onClick={onToggle} className="flex w-full items-center gap-2 py-1.5 text-left transition active:scale-[0.99]">
        <span className="w-[92px] shrink-0 text-[12.5px] font-bold text-slate-100">{day.dayLabel}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold text-slate-400">
          ON {day.onAt ? fmtClock(day.onAt) : '—'}
          <span className="mx-1 text-slate-600">·</span>
          Khatam {day.lastAt ? fmtClock(day.lastAt) : '—'}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="pb-2">
          <p className="mb-1 truncate text-[11px] font-semibold text-[#7EB3FF]">
            {routeSummary(day.stops)} · {day.stops.length} points
          </p>
          {day.stops.length === 0 ? (
            <p className="text-[12px] text-slate-500">Koi movement nahi.</p>
          ) : (
            <div className="max-h-[240px] divide-y divide-white/[0.05] overflow-y-auto overscroll-contain">
              {day.stops.map((s, i) => (
                <div key={`${s.at}-${i}`} className="flex items-center gap-3 py-1.5">
                  <span className="w-[64px] shrink-0 text-[11px] font-bold tabular-nums text-slate-500">{fmtClock(s.at)}</span>
                  <MapPin className="h-3 w-3 shrink-0 text-slate-500" />
                  <span className="truncate text-[12.5px] font-semibold text-slate-200">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StaffDetailScreen({
  staff,
  cities,
  pinned,
  onTogglePin,
  onBack
}: {
  staff: StaffDetailTarget;
  cities: CityCoord[];
  pinned: boolean;
  onTogglePin: () => void;
  onBack: () => void;
}) {
  const slideRef = useSwipeBack(onBack);
  const isSales = staff.role === 'sales';

  // ---------- Shared: fresh users doc (live lastLocation/lastSeenAt) ----------
  const [userMeta, setUserMeta] = useState<DutyUserMeta | null>(null);

  // ---------- SALES state ----------
  const [lastOnAt, setLastOnAt] = useState<number>(0);          // banner daysSinceOn (aakhri ON event)
  const [openRecent, setOpenRecent] = useState<boolean>(false); // open session + 12h activity = "abhi ON hai"
  const [days, setDays] = useState<{ today: DayTrack; past: DayTrack[] } | null>(null);
  const [salesLoaded, setSalesLoaded] = useState(false);
  const [openDayKey, setOpenDayKey] = useState<string>('');     // kaunsa purana din expand hai

  // ---------- WORKER state ----------
  const [punches, setPunches] = useState<PunchLike[]>([]);
  const [outsides, setOutsides] = useState<OutsideLogLike[]>([]);
  const [workerLoaded, setWorkerLoaded] = useState(false);
  const [attOnDuty, setAttOnDuty] = useState<boolean | null>(null);

  // ---------- Load (ek baar open par) ----------
  useEffect(() => {
    let alive = true;

    getDoc(doc(db, 'users', staff.uid))
      .then((s) => {
        if (!alive || !s.exists()) return;
        const v = s.data() as any;
        setUserMeta({
          uid: staff.uid,
          name: String(v.name || staff.name),
          role: staff.role,
          photo: typeof v.photo === 'string' && v.photo ? v.photo : staff.photo,
          lastLocation: v.lastLocation && Number.isFinite(v.lastLocation?.lat) ? v.lastLocation : undefined,
          lastSeenAt: Number(v.lastSeenAt) || undefined
        });
      })
      .catch(() => {});

    if (isSales) {
      // (1) loc_events: saare ON/OFF events EK hi query me (uid equality-only ✓)
      //     ON = kitne baje location on kiya · OFF = us din ka khatam moment
      const evP = getDocs(query(collection(db, 'loc_events'), where('uid', '==', staff.uid)))
        .then((snap) => {
          if (!alive) return [] as RawLocEventLike[];
          let bestOn = 0;
          const rows: RawLocEventLike[] = [];
          snap.forEach((d) => {
            const v = d.data() as any;
            const at = Number(v.at) || 0;
            rows.push({ type: String(v.type || ''), at });
            if (String(v.type) === 'on' && at > bestOn) bestOn = at;
          });
          setLastOnAt(bestOn);
          return rows;
        })
        .catch(() => [] as RawLocEventLike[]);
      // (2) loc_sessions: saare sessions (uid equality-only ✓) — buildDayTracks
      //     khud har LOCAL calendar-day bucket banata hai (aaj + pichle 8 din)
      const seP = getDocs(query(collection(db, 'loc_sessions'), where('uid', '==', staff.uid)))
        .then((snap) => {
          if (!alive) return [] as RawSessionLike[];
          const rows: RawSessionLike[] = [];
          snap.forEach((d) => {
            const v = d.data() as any;
            rows.push({
              startedAt: Number(v.startedAt) || 0,
              status: String(v.status || ''),
              endedAt: v.endedAt === undefined ? undefined : Number(v.endedAt),
              points: Array.isArray(v.points) ? v.points : []
            });
          });
          return rows;
        })
        .catch(() => [] as RawSessionLike[]);
      Promise.all([evP, seP]).then(([events, sessions]) => {
        if (!alive) return;
        const t = Date.now();
        setDays(buildDayTracks(sessions, events, cities, t));
        // zombie-guard: open session par bhi 12h se koi activity nahi = "abhi
        // ON hai" MAT dikhao (locTrack ke 12h stale-close window se match)
        const openLast = openSessionLastActive(sessions, t);
        setOpenRecent(openLast > 0 && t - openLast < 12 * 60 * 60 * 1000);
        setSalesLoaded(true);
      });
    } else {
      // (3) punches (uid equality-only ✓ — established pattern Home.tsx:291)
      getDocs(query(collection(db, 'punches'), where('uid', '==', staff.uid)))
        .then((snap) => {
          if (!alive) return;
          const rows: PunchLike[] = [];
          snap.forEach((d) => {
            const v = d.data() as any;
            rows.push({ type: String(v.type || ''), at: Number(v.at) || 0 });
          });
          setPunches(rows);
          setWorkerLoaded(true);
        })
        .catch(() => {
          if (alive) setWorkerLoaded(true);
        });
      // (4) outside_logs (uid equality-only ✓ — geofence.ts pattern)
      getDocs(query(collection(db, 'outside_logs'), where('uid', '==', staff.uid)))
        .then((snap) => {
          if (!alive) return;
          const rows: OutsideLogLike[] = [];
          snap.forEach((d) => {
            const v = d.data() as any;
            rows.push({
              fromAt: Number(v.fromAt) || 0,
              toAt: v.toAt === undefined ? undefined : Number(v.toAt),
              status: String(v.status || ''),
              allowedMin: typeof v.allowedMin === 'number' ? v.allowedMin : undefined
            });
          });
          setOutsides(rows);
        })
        .catch(() => {});
      // (5) abhi duty ON hai? (attendance doc)
      getDoc(doc(db, 'staff_attendance', staff.uid))
        .then((s) => {
          if (!alive) return;
          setAttOnDuty(s.exists() ? s.data()?.isOnDuty === true : false);
        })
        .catch(() => {
          if (alive) setAttOnDuty(false);
        });
    }
    return () => {
      alive = false;
    };
  }, [staff.uid, isSales]);

  // ---------- Derived ----------
  const now = Date.now();
  const loc = userMeta?.lastLocation;
  const seenAt = Number(userMeta?.lastSeenAt) || (loc?.at ? Number(loc!.at) : 0);
  const liveFresh = !!(loc && seenAt > 0 && now - seenAt <= FRESH_WINDOW_MS);
  const locLabel = loc ? (() => {
    const c = nearestCity(loc.lat, loc.lng, cities);
    return c ? c.city : `${loc.lat.toFixed(2)}, ${loc.lng.toFixed(2)}`;
  })() : 'Location nahi mili';

  // SALES banner: open session + recent activity = ON hai; warna calendar-days purana
  // (zombie open session — 12h se no activity — "abhi ON hai" nahi dikhayega)
  const bannerDays = daysSinceOn(lastOnAt, now);
  const banner = openRecent
    ? { tone: 'good' as const, text: 'Location abhi ON hai' }
    : bannerDays === 0
    ? { tone: 'warn' as const, text: 'Location aaj ON nahi hui' }
    : { tone: 'bad' as const, text: `Location ${bannerDays} din purana hai` };

  // WORKER summary
  const psum = useMemo(() => summarizePunchesToday(punches, now), [punches, punches.length, now]);
  const isOnNow = attOnDuty === true || psum.openIn !== null;
  const unannounced = useMemo(
    () =>
      outsides
        .filter((l) => l.fromAt >= new Date(now).setHours(0, 0, 0, 0)) // SIRF TODAY
        .filter(isUnannouncedOutside)                                  // bina-bataye only
        .sort((a, b) => b.fromAt - a.fromAt),
    [outsides, outsides.length, now]
  );

  const roleChipCls = isSales ? 'bg-amber-400/15 text-amber-300' : 'bg-sky-400/15 text-sky-300';

  return (
    <div ref={slideRef} className="fixed inset-0 z-[60] overflow-y-auto bg-[#0A1220] px-4 text-slate-100" style={SWIPE_OVERLAY_STYLE}>
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-emerald-500/10" />
      <div className="ambient-orb top-[45%] -left-20 h-56 w-56 bg-sky-400/10" />

      {/* Header: DP + naam + role + PIN toggle (Boss: manager pin kar sake) */}
      <div className="relative z-10 mb-4 flex items-center gap-2">
        <h2 className="text-[16px] font-semibold text-[#B7C5F0]">Staff Detail</h2>
        <button
          onClick={onTogglePin}
          className={`ml-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-extrabold transition active:scale-95 ${
            pinned ? 'border-amber-300/40 bg-amber-400/15 text-amber-300' : 'border-white/10 bg-[#101B31] text-slate-400'
          }`}
        >
          {pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
          {pinned ? 'PINNED' : 'PIN'}
        </button>
      </div>

      {/* Identity card */}
      <div className="glass-card intro-rise relative z-10 rounded-[26px] px-5 py-5">
        <div className="flex items-center gap-4">
          <div
            className="shrink-0 rounded-full"
            style={liveFresh ? { boxShadow: '0 0 0 2.5px rgba(52,211,153,0.55)' } : undefined}
          >
            <Avatar photo={userMeta?.photo || staff.photo} name={staff.name} size={64} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[18px] font-extrabold text-slate-100">{staff.name}</span>
              <span className={`rounded px-1.5 py-px text-[9px] font-extrabold tracking-wider ${roleChipCls}`}>
                {isSales ? 'SALES' : 'STAFF'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-slate-400">
              {liveFresh ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" style={{ fill: 'rgba(52,211,153,0.16)' }} />
              ) : isOnNow ? (
                <Clock className="h-4 w-4 shrink-0 text-amber-400/80" />
              ) : (
                <Clock className="h-4 w-4 shrink-0 text-slate-500" />
              )}
              <span className="truncate">
                {locLabel}
                {seenAt > 0 ? ` · ${fmtAgo(seenAt, now)}` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ================= SALES ================= */}
      {isSales && (
        <>
          {/* Location age banner (Boss: "2 din purana hai ya 1 din purana") */}
          <div
            className={`intro-rise relative z-10 mt-3 flex items-center gap-2.5 rounded-2xl border px-4 py-3 ${
              banner.tone === 'good'
                ? 'border-emerald-300/25 bg-emerald-400/10'
                : banner.tone === 'warn'
                ? 'border-amber-300/25 bg-amber-400/10'
                : 'border-rose-300/25 bg-rose-400/10'
            }`}
          >
            <Compass
              className={`h-5 w-5 shrink-0 ${
                banner.tone === 'good' ? 'text-emerald-300' : banner.tone === 'warn' ? 'text-amber-300' : 'text-rose-300'
              }`}
            />
            <span
              className={`text-[13px] font-extrabold ${
                banner.tone === 'good' ? 'text-emerald-300' : banner.tone === 'warn' ? 'text-amber-300' : 'text-rose-300'
              }`}
            >
              {banner.text}
            </span>
          </div>

          {/* AAJ — Boss: "aaj kaha gaya, kitne baje location on kiya, us din ka khatam" */}
          <div className="glass-card intro-rise relative z-10 mt-3 rounded-2xl p-4">
            <div className="mb-2.5 flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-[#4C9EFF]" />
              <span className="text-[11px] font-extrabold tracking-[0.14em] text-slate-300">AAJ</span>
              <span className="text-[10.5px] font-bold text-slate-500">{days ? `· ${days.today.dayLabel}` : ''}</span>
              <span className="ml-auto text-[10px] font-bold text-slate-500">
                {days ? `${days.today.stops.length} points` : ''}
              </span>
            </div>
            {!salesLoaded || !days ? (
              <p className="py-2 text-[12.5px] text-slate-500">Loading…</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <Power className="h-3.5 w-3.5 text-emerald-300" /> Location ON kiya
                  </span>
                  <span
                    className={`text-[13px] font-bold tabular-nums ${
                      days.today.onAt ? 'text-slate-100' : 'text-rose-300'
                    }`}
                  >
                    {days.today.onAt ? fmtClock(days.today.onAt) : 'Nahi kiya'}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <LogOut className="h-3.5 w-3.5 text-rose-300" /> Din ka khatam
                  </span>
                  {days.today.endOpen ? (
                    <span className="flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-extrabold tracking-wider text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> ABHI ON HAI
                    </span>
                  ) : (
                    <span
                      className={`text-[13px] font-bold tabular-nums ${
                        days.today.lastAt ? 'text-slate-100' : 'text-slate-500'
                      }`}
                    >
                      {days.today.lastAt ? fmtClock(days.today.lastAt) : '—'}
                    </span>
                  )}
                </div>
                {/* Aaj ka poora route — subah se ab tak, chronological */}
                {days.today.stops.length === 0 ? (
                  <p className="mt-2.5 border-t border-white/[0.05] pt-2.5 text-[12.5px] text-slate-500">
                    {days.today.onAt || days.today.endOpen
                      ? 'Location ON hai — movement aane par route yahan dikhega.'
                      : 'Aaj koi movement nahi.'}
                  </p>
                ) : (
                  <div className="mt-2.5 max-h-[280px] divide-y divide-white/[0.05] overflow-y-auto overscroll-contain border-t border-white/[0.05]">
                    {days.today.stops.map((s, i) => (
                      <div key={`${s.at}-${i}`} className="flex items-center gap-3 py-2">
                        <span className="w-[64px] shrink-0 text-[11px] font-bold tabular-nums text-slate-500">{fmtClock(s.at)}</span>
                        <MapPin className="h-3 w-3 shrink-0 text-slate-500" />
                        <span className="truncate text-[12.5px] font-semibold text-slate-200">{s.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* PURANE DIN — Boss: "uske niche purani date 8 din ka data dikhna chahiye" */}
          <div className="glass-card intro-rise relative z-10 mt-3 rounded-2xl p-4">
            <div className="mb-1 flex items-center gap-2">
              <History className="h-4 w-4 text-[#B7C5F0]" />
              <span className="text-[11px] font-extrabold tracking-[0.14em] text-slate-300">PURANE DIN</span>
              <span className="ml-auto text-[10px] font-bold text-slate-500">pichle 8 din</span>
            </div>
            {!salesLoaded || !days ? (
              <p className="py-2 text-[12.5px] text-slate-500">Loading…</p>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {days.past.map((d) => (
                  <DayRow
                    key={d.dateKey}
                    day={d}
                    expanded={openDayKey === d.dateKey}
                    onToggle={() => setOpenDayKey(openDayKey === d.dateKey ? '' : d.dateKey)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ================= WORKER ================= */}
      {!isSales && (
        <>
          {/* Duty summary (kitne baje aaya / off kiya / kitni der) */}
          <div className="glass-card intro-rise relative z-10 mt-3 rounded-2xl p-4">
            <div className="mb-2 flex items-center gap-2">
              <Timer className="h-4 w-4 text-emerald-300" />
              <span className="text-[11px] font-extrabold tracking-[0.14em] text-slate-300">AAJ KI DUTY</span>
            </div>
            {!workerLoaded ? (
              <p className="py-2 text-[12.5px] text-slate-500">Loading…</p>
            ) : psum.firstIn === null ? (
              <p className="py-2 text-[12.5px] text-slate-500">Aaj duty par nahi aaya.</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <LogIn className="h-4 w-4 text-emerald-300" /> Duty par aaya
                  </span>
                  <span className="text-[13px] font-bold tabular-nums text-slate-100">{fmtClock(psum.firstIn)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <LogOut className="h-4 w-4 text-rose-300" /> Duty off ki
                  </span>
                  <span className="text-[13px] font-bold tabular-nums text-slate-100">
                    {psum.openIn !== null ? 'Abhi ON hai' : psum.lastOut ? fmtClock(psum.lastOut) : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-400">
                    <Timer className="h-4 w-4 text-sky-300" /> Total on duty
                  </span>
                  <span className="text-[13px] font-bold tabular-nums text-slate-100">{fmtDurLocal(psum.workedMin)}</span>
                </div>
                {isOnNow && (
                  <div className="flex items-center gap-1.5 rounded-xl border border-emerald-300/25 bg-emerald-400/10 px-3 py-2 text-[11.5px] font-extrabold text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Abhi duty par hai
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bina bataye bahar (dukan ke kaam / authorized HIDE — Boss rule) */}
          <div className="glass-card intro-rise relative z-10 mt-3 rounded-2xl p-4">
            <div className="mb-2 flex items-center gap-2">
              <Footprints className="h-4 w-4 text-amber-300" />
              <span className="text-[11px] font-extrabold tracking-[0.14em] text-slate-300">BINA BATAYE BAHAR</span>
              <span className="ml-auto text-[10px] font-bold text-slate-500">sirf aaj</span>
            </div>
            {unannounced.length === 0 ? (
              <p className="py-2 text-[12.5px] text-slate-500">Kuch nahi — aaj bina bataye koi bahar jaana nahi.</p>
            ) : (
              <div className="max-h-[220px] divide-y divide-white/[0.05] overflow-y-auto overscroll-contain">
                {unannounced.map((l, i) => (
                  <div key={`${l.fromAt}-${i}`} className="flex items-center gap-3 py-2">
                    <span className="w-[64px] shrink-0 text-[11px] font-bold tabular-nums text-slate-500">{fmtClock(l.fromAt)}</span>
                    <span className="flex-1 truncate text-[12.5px] font-semibold text-slate-200">
                      {l.toAt === undefined ? 'Abhi bahar hai (stopwatch chal raha)' : `${fmtDurLocal((l.toAt! - l.fromAt) / 60000)} bahar raha`}
                    </span>
                    <span
                      className={`rounded px-1.5 py-px text-[9px] font-extrabold tracking-wider ${
                        l.status === 'open'
                          ? 'bg-rose-400/15 text-rose-300'
                          : l.status === 'pending'
                          ? 'bg-amber-400/15 text-amber-300'
                          : 'bg-slate-400/15 text-slate-400'
                      }`}
                    >
                      {l.status === 'open' ? 'OPEN' : l.status === 'pending' ? 'WAIT' : 'REJECTED'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Footer note — Boss rule: koi back button nahi, left-edge slide se band */}
      <p className="relative z-10 mb-6 mt-4 text-center text-[10.5px] text-slate-600">
        Left edge se slide karke wapas jao
      </p>
    </div>
  );
}
