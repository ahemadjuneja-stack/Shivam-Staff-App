import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  addDoc,
  setDoc,
  serverTimestamp,
  runTransaction,
  DocumentSnapshot,
  Timestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, PunchRecord, Task, CreditDoc, OutsideLog, ScheduleEntry } from '../types';
import { computeDutyMin, FALLBACK_TARGET_H } from '../lib/duty';
import { CREDIT_POINTS, MAX_CREDIT, MAX_ACTIVE_TASKS_PER_STAFF, totalOf, clampScore, starsForPoints, dailyCreditDelta, workedMinutesOnDay, hourlyCutFor } from '../lib/credit';
import { logCreditHistory, txHistoryEntry, historyCol, localYmd } from '../lib/history';
import PointsGuide from './PointsGuide';
import ProfileScreen from './Profile';
import Avatar from '../components/Avatar';
import { upsertScheduleEntry, removeScheduleEntry, cityKeyOf } from '../lib/schedule';
import { reportDeviceAndLocation } from '../lib/reporting';
import { sampleGeofence, closeStaleOutsideEvent, lastGpsFix, SAMPLE_MS } from '../lib/geofence';
import { enqueueOutbox, flushOutbox } from '../lib/sync';
import {
  calibrateFromServer,
  clockSnapshot,
  clockJumped,
  heartbeatTouch,
  detectDutyGap,
  openInOf,
  overMaxShift,
  autoCloseDone,
  markAutoCloseDone,
  MAX_SHIFT_MS
} from '../lib/integrity';
import { CalendarDays, Timer, BarChart3, Wallet, ChevronRight, MapPin, Pencil, Trash2, X } from 'lucide-react';
import { consumeAutoDutyRequest, consumeAutoDutyOffRequest } from './LocationGate';
import TaskVerifyModal from '../components/TaskVerifyModal';
import { verifyTask } from '../lib/taskVerify';

// ============================================================
// NEW HOME SCREEN (Boss order 2026-10-25 — demo screenshot style)
// PURANA SAB REMOVED: MENU grid, DUTY TIME cards, section switching,
// Attendance/Work Log/Sales/Profile/HisabXL/Tasks screens (band).
//
// NAYA LAYOUT (Boss demo):
//   Header row: staff name (gold) + golden star badge with credit points
//   Duty strip: D. Overtime/Undertime + M. (compact 2 rows, worker only)
//   Pending Task: cards (title, Task Date, Duration, By/To, Status)
//     - manager: + New Task button (assign form), tap pending = verify (English dialog)
//     - staff: sirf apne tasks (toUid) — koi aur nahi dekh sakta
//   Completed: Done cards ya "Nil"
//   Fixed branch avatars: ZS Patan / RR Godhra / SK Mangrol (Boss: abhi fixed)
//   Polls (SOON) | Salary Info. (SOON) | Duty toggle (fixed bottom-RIGHT)
//   TASK MSGS REMOVED (Boss 2026-10-26: "whatsapp jaisa task msg remove karo
//   wo mujse galati se hua hai sirf task ka hi box sahi hai")
// NO LOGOUT BUTTON (Boss: "app me koi logout button nahi hai") — hidden logout:
//   staff name ko ~1s press & hold karo (design kuch nahi badalta).
// AUTO DUTY ON (Boss 2026-10-26): location gate pass (100m andar) -> flag ->
//   Home attendance load hote hi duty ON (staff only, dedupe-safe).
// Unclear cheezo pe SOON chip (Boss: "dhire dhire sab samaj ajayga")
// ============================================================

interface HomeProps {
  profile: UserProfile;
  onLogout: () => void;
}

// TASK TITLE COLORS (Boss order 2026-10-27: "task font color ko kuch alag
// colors me likho take aasani se dikhe") — pehle sab pending task titles same
// #7EB3FF blue me the (2 tasks ek jaise dikhte the), ab har card ka title
// palette cycle se apna distinct color (adjacent cards hamesha alag hue,
// sab dark navy bg par readable light tints).
const TASK_TITLE_COLORS = [
  '#7EB3FF', // sky blue
  '#FCD34D', // amber
  '#34D399', // emerald
  '#F472B6', // pink
  '#C4B5FD', // violet
  '#67E8F9', // cyan
  '#FDBA74', // orange
  '#FCA5A5' // rose
];

// Fixed branch avatars (Boss: "Abhi fixed" — aage real branch data)
const FIXED_BRANCHES = [
  { initials: 'ZS', city: 'Patan Gujarat' },
  { initials: 'RR', city: 'Godhra, Gujarat' },
  { initials: 'SK', city: 'Mangrol, Gujarat' }
];

// Premium meta chip (Task Date / Duration / By) — glass inset
function MetaChip({ icon: Icon, label, value }: { icon: typeof CalendarDays; label: string; value: string }) {
  return (
    <span className="glass-inset inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10.5px]">
      <Icon className="h-3 w-3 text-slate-500" />
      <span className="font-medium text-slate-500">{label}:</span>
      <span className="font-bold text-slate-200">{value}</span>
    </span>
  );
}

// DP CHIP (Boss order 2026-10-27: "har jaga jaha unka naam aata hai waha DP
// bhi show hona chahiye"): task cards me To/By naam ke saath profile photo.
function PersonChip({
  photoMap,
  uid,
  name,
  label
}: {
  photoMap: Record<string, string>;
  uid: string;
  name: string;
  label: string;
}) {
  return (
    <span className="glass-inset inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10.5px]">
      <Avatar photo={photoMap[uid]} name={name} size={18} />
      <span className="font-medium text-slate-500">{label}:</span>
      <span className="font-bold text-slate-200">{name}</span>
    </span>
  );
}

// Branch avatar ring gradients (premium — fixed branches, Boss: abhi fixed)
const BRANCH_RINGS = [
  'linear-gradient(135deg, #F5B93F, #E8912D)',
  'linear-gradient(135deg, #4C9EFF, #6366F1)',
  'linear-gradient(135deg, #34D399, #0D9488)'
];

// "20-10-26" — demo ka date format
const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getFullYear()).slice(2)}`;
};

const localDayStart = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

const monthKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// "15M" | "2H 30M" | "4H"
const fmtDur = (min: number): string => {
  const m = Math.round(min);
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}H ${rm}M` : `${h}H`;
};

// floor hours: "145H"
const fmtH = (min: number): string => `${Math.floor(min / 60)}H`;

export default function Home({ profile, onLogout }: HomeProps) {
  const isManager = profile.role === 'manager';
  // SALES RULES (Boss order 2026-10-26): salesman ko tasks NAHI dikhte, star/
  // credit points NAHI dikhte (na display, na auto point writes). Baaki access
  // Boss aage decide karega.
  const isSales = profile.role === 'sales';
  const isWorker = profile.role === 'worker';

  // ---------- Hidden logout (Boss: design me logout button nahi) + TAP = PROFILE (Boss order 2026-10-27) ----------
  // Staff name ~0.9s press & hold -> English confirm -> logout (UI me kuch nahi dikhta)
  // SHORT TAP (<0.7s) -> PROFILE SCREEN khulta hai (photo add/edit ke liye)
  const [showProfile, setShowProfile] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressStartedAtRef = useRef(0);
  const longPressFiredRef = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const startPress = () => {
    cancelPress();
    longPressFiredRef.current = false;
    pressStartedAtRef.current = Date.now();
    pressTimer.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      if (window.confirm('Logout from Shivam Staff App?')) onLogout();
    }, 900);
  };
  // Release par: agar long-press fire NAHI hua aur press chhota tha -> profile
  // (touchmove/mouseleave par cancelPress hi chalega — scroll me profile nahi khulega)
  const endPress = () => {
    cancelPress();
    if (
      !longPressFiredRef.current &&
      pressStartedAtRef.current &&
      Date.now() - pressStartedAtRef.current < 700
    ) {
      setShowProfile(true);
    }
    pressStartedAtRef.current = 0;
  };
  useEffect(() => cancelPress, []);

  // ---------- Device & location reporting (dashboard StaffDetail ke liye — silent, no UI) ----------
  useEffect(() => {
    reportDeviceAndLocation(profile.uid);
    const t = window.setInterval(() => {
      // BATTERY SAVER: sales hidden me JS report skip — native LocationTrack-
      // Service har fix par users.lastLocation+lastSeenAt likhta hai (better
      // data, src:'svc') — JS ka 5-min GPS burst hidden me redundant tha.
      // Worker ka 5-min report pehle jaise chalta hai (wahi uska source hai).
      if (profile.role === 'sales' && document.hidden) return;
      reportDeviceAndLocation(profile.uid);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [profile.uid, profile.role]);

  // ---------- Duty state ----------
  const [isOnDuty, setIsOnDuty] = useState<boolean>(false);
  const [punches, setPunches] = useState<PunchRecord[]>([]);
  const [targetH, setTargetH] = useState<number>(FALLBACK_TARGET_H);
  const [, setTick] = useState(0);
  // attendance snapshot pe baar aaya? (auto-duty race-safe decision ke liye)
  const [attLoaded, setAttLoaded] = useState<boolean>(false);
  // AUTO DUTY flags ab effect me har 2s consume hote hain (LocationGate se) —
  // mount-time single consume nahi (sales location OFF/ON repeat ho sakta hai)

  // ---------- Toast (SOON modules) ----------
  const [notice, setNotice] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  // ---------- Task state ----------
  const [tasks, setTasks] = useState<Task[]>([]);
  const [staffList, setStaffList] = useState<UserProfile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toUid, setToUid] = useState('');
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [days, setDays] = useState(1);

  // ---------- Listeners: duty status ----------
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'staff_attendance', profile.uid), (docSnap) => {
      setAttLoaded(true);
      if (docSnap.exists()) {
        const d = docSnap.data();
        setIsOnDuty(d.isOnDuty === true);
        // CLOCK CALIBRATION (integrity): server-resolved snapshot se real time
        // anchor — is offset se pata chalta hai device clock kitna aage/peeche hai
        if (!docSnap.metadata.hasPendingWrites && d.updatedAt && typeof (d.updatedAt as Timestamp).toMillis === 'function') {
          calibrateFromServer((d.updatedAt as Timestamp).toMillis());
        }
      }
    });
    return () => unsub();
  }, [profile.uid]);

  // ---------- AUTO DUTY (Boss order 2026-10-26: "100 mitter ke andar hai
  // location me access de diya to automatically duty on ho jaani chahiye") +
  // SALES LOCATION DUTY (Boss order 2026-10-26: "salesmen ko on off duty ka
  // button bhi nahi hona chahiye, unka duty location par hi chalega"):
  // LocationGate flags set karta hai (ON: gate pass — worker+sales; OFF:
  // location off — sales) -> ye poll 2s me consume karta hai. Race-safe:
  // attendance load hone ke BAAD + isOnDuty check ke saath — exact ek punch.
  // Worker: sirf ON flag (button se OFF karta hai). Sales: dono flags.
  useEffect(() => {
    if (profile.role === 'manager' || !attLoaded) return;
    const iv = window.setInterval(() => {
      if (consumeAutoDutyRequest()) {
        if (!isOnDuty) toggleDuty(true);
      }
      if (profile.role === 'sales' && consumeAutoDutyOffRequest()) {
        if (isOnDuty) toggleDuty(false);
      }
    }, 2000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.role, attLoaded, isOnDuty]);

  // ---------- Listeners: punches (duty calc + credit hours) ----------
  useEffect(() => {
    const q = query(collection(db, 'punches'), where('uid', '==', profile.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<PunchRecord, 'id'>) }))
        .sort((a, b) => a.at - b.at);
      setPunches(records);
    });
    return () => unsub();
  }, [profile.uid]);

  // ---------- Listeners: duty targets (personal > default_month > default) ----------
  useEffect(() => {
    const mk = monthKeyOf(new Date());
    let personal: number | null = null;
    let defMonth: number | null = null;
    let defAny: number | null = null;
    const apply = () => {
      const v = personal ?? defMonth ?? defAny;
      setTargetH(v !== null && v > 0 ? v : FALLBACK_TARGET_H);
    };
    const onVal = (setter: (n: number | null) => void) => (snap: DocumentSnapshot) => {
      const data = snap.data();
      const th = data ? Number(data.targetHours) : NaN;
      setter(snap.exists() && Number.isFinite(th) && th > 0 ? th : null);
      apply();
    };
    const noopErr = () => {};
    const unsubs = [
      onSnapshot(doc(db, 'duty_targets', `${profile.uid}_${mk}`), onVal((n) => { personal = n; }), noopErr),
      onSnapshot(doc(db, 'duty_targets', `default_${mk}`), onVal((n) => { defMonth = n; }), noopErr),
      onSnapshot(doc(db, 'duty_targets', 'default'), onVal((n) => { defAny = n; }), noopErr)
    ];
    return () => unsubs.forEach((u) => u());
  }, [profile.uid]);

  // ---------- Live tick: ON duty span har 30s me badhe ----------
  useEffect(() => {
    if (!isOnDuty) return;
    // BATTERY SAVER: hidden me UI tick skip (re-render 0) — wapas visible
    // aate hi agli tick (30s) me clock sahi ho jata hai.
    const t = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, 30000);
    return () => clearInterval(t);
  }, [isOnDuty]);

  // ---------- Listeners: tasks (visibility rule — manager: uske diye | worker: usko mile | sales: KUCH NAHI) ----------
  useEffect(() => {
    if (isManager || isSales) return; // SALES: tasks unke liye nahi hai (Boss order 2026-10-26)
    const field = isManager ? 'byUid' : 'toUid';
    const q = query(collection(db, 'tasks'), where(field, '==', profile.uid));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Task, 'id'>) }));
      rows.sort((a, b) => {
        const rank = (s: Task['status']) => (s === 'pending' ? 0 : 1);
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
        return b.createdAt - a.createdAt;
      });
      setTasks(rows);
    });
    return () => unsub();
  }, [profile.uid, isManager, isSales]);

  // ---------- Listeners: manager staff list (assign picker) ----------
  useEffect(() => {
    if (!isManager) return;
    getDocs(query(collection(db, 'users'), where('status', '==', 'active')))
      .then((snap) => {
        const rows = snap.docs
          .map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, 'uid'>) } as UserProfile))
          .filter((u) => u.role === 'worker' || u.role === 'sales');
        setStaffList(rows);
      })
      .catch(() => {});
  }, [isManager]);

  // ---------- DP MAP (Boss order 2026-10-27: task cards me naam ke saath photo) ----------
  // staffList (manager) + apna photo turant; baki uids (worker ka manager, etc.)
  // lazy getDoc — ek uid sirf ek baar fetch hota hai.
  const [photoMap, setPhotoMap] = useState<Record<string, string>>({});
  const photoFetchedRef = useRef<Set<string>>(new Set());
  const ensurePhoto = (uid: string) => {
    if (!uid || photoFetchedRef.current.has(uid)) return;
    photoFetchedRef.current.add(uid);
    getDoc(doc(db, 'users', uid))
      .then((s) => {
        const p = s.data()?.photo;
        if (typeof p === 'string' && p) setPhotoMap((m) => (m[uid] === p ? m : { ...m, [uid]: p }));
      })
      .catch(() => {});
  };
  useEffect(() => {
    const patch: Record<string, string> = {};
    if (profile.photo) patch[profile.uid] = profile.photo;
    staffList.forEach((s) => {
      const p = (s as any).photo;
      if (typeof p === 'string' && p) patch[s.uid] = p;
    });
    if (Object.keys(patch).length) setPhotoMap((m) => ({ ...m, ...patch }));
  }, [profile.photo, profile.uid, staffList]);
  useEffect(() => {
    tasks.forEach((t) => {
      ensurePhoto(t.toUid);
      ensurePhoto(t.byUid);
    });
  }, [tasks]);

  // ---------- CREDIT POINTS (live) ----------
  const [creditDoc, setCreditDoc] = useState<CreditDoc | null>(null);
  // POINTS GUIDE (Boss Task 51): staff apne points ka pura up/down rule dekh sake
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => {
    if (!isWorker) return; // SALES/MANAGER: credit system unke liye nahi hai (Boss order 2026-10-26)
    const unsub = onSnapshot(doc(db, 'credit_points', profile.uid), (snap) => {
      setCreditDoc(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<CreditDoc, 'uid'>) }) : null);
    });
    return () => unsub();
  }, [profile.uid, isWorker]);

  const [allCredits, setAllCredits] = useState<{ uid: string; taskScore: number; hoursScore: number; dailyScore: number }[]>([]);
  const [staffRoleMap, setStaffRoleMap] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isWorker) return; // SALES/MANAGER: rank/credits sirf workers ke liye
    const unsub = onSnapshot(collection(db, 'credit_points'), (snap) => {
      setAllCredits(snap.docs.map((d) => ({ uid: d.id, taskScore: Number(d.data().taskScore) || 0, hoursScore: Number(d.data().hoursScore) || 0, dailyScore: Number(d.data().dailyScore) || 0 })));
    });
    getDocs(query(collection(db, 'users'), where('status', '==', 'active')))
      .then((s) => {
        const m: Record<string, string> = {};
        s.docs.forEach((d) => { m[d.id] = String((d.data() as any).role || 'worker'); });
        setStaffRoleMap(m);
      })
      .catch(() => {});
    return () => unsub();
  }, [isWorker]);

  // Live totals + POINTS-BASED stars (Boss Task 52: har 60 points = 1 star,
  // 300 = 5 stars — app apne aap credit ke hisab se stars adjust karta hai).
  // Rank abhi bhi chalta hai (gold star badge me rank number).
  const creditInfo = useMemo(() => {
    const staffUids = Object.entries(staffRoleMap)
      .filter(([, r]) => r === 'worker' || r === 'sales')
      .map(([u]) => u);
    const totals = new Map<string, number>();
    staffUids.forEach((u) => totals.set(u, 0));
    allCredits.forEach((c) => { if (totals.has(c.uid)) totals.set(c.uid, totalOf(c)); });
    const sorted = [...totals.entries()].map(([uid, total]) => ({ uid, total })).sort((a, b) => b.total - a.total);
    const myIdx = sorted.findIndex((e) => e.uid === profile.uid);
    const total = myIdx >= 0 ? sorted[myIdx].total : totalOf(creditDoc);
    return {
      total,
      stars: starsForPoints(total),
      rank: myIdx + 1,
      of: sorted.length
    };
  }, [allCredits, staffRoleMap, profile.uid, creditDoc]);

  // Aaj ka credit change (Boss Task 52): history subcollection se aaj ki
  // entries ka net delta — up = green arrow, down = red arrow, Home pe live.
  const [todayDelta, setTodayDelta] = useState<number | null>(null);
  useEffect(() => {
    if (!profile.uid || !isWorker) return; // SALES/MANAGER: aaj ka change nahi dikhta
    const unsub = onSnapshot(historyCol(profile.uid), (snap) => {
      const today = localYmd(Date.now());
      let sum = 0;
      snap.docs.forEach((d) => {
        const v = d.data() as { delta?: number; at?: number };
        if (localYmd(Number(v.at) || 0) === today) sum += Number(v.delta) || 0;
      });
      setTodayDelta(sum);
    }, () => setTodayDelta(null));
    return () => unsub();
  }, [profile.uid, profile.role]);

  // hoursScore updater (worker only): monthly duty on-track/peeche — auto +/-10
  useEffect(() => {
    if (profile.role !== 'worker') return;
    const calc = computeDutyMin(punches, isOnDuty, targetH, profile.createdAt);
    const target = calc.monthDeltaMin >= 0 ? CREDIT_POINTS.HOURS_ONTRACK : CREDIT_POINTS.HOURS_BEHIND;
    const cur = Number(creditDoc?.hoursScore) || 0;
    if (creditDoc && cur === target) return;
    setDoc(doc(db, 'credit_points', profile.uid), { hoursScore: target, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    // Credit history (Boss Task 51): monthly duty up/down bhi history me
    logCreditHistory(profile.uid, 'hours', target >= 0 ? 'Monthly duty on track' : 'Monthly duty behind', target);
  }, [profile.role, profile.uid, profile.createdAt, punches, isOnDuty, targetH, creditDoc]);

  // ---------- Daily credit accrual (Boss order 2026-10-26: har roz duty time ke hisab se up/down) ----------
  // Worker only (hoursScore jaisa hi gating). Catch-up: lastCreditDay ke baad ke
  // har COMPLETED din (yesterday tak) ka delta ek hi merge write me accumulate.
  // lastCreditDay dedupe karta hai — koi din double-count nahi hota.
  useEffect(() => {
    if (profile.role !== 'worker') return;
    const ymdOf = (dt: Date) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const todayYmd = ymdOf(now);
    const last = creditDoc?.lastCreditDay;
    if (last === todayYmd) return;
    let cursor: Date;
    if (last) {
      const [ly, lm, ld] = last.split('-').map(Number);
      cursor = new Date(ly, lm - 1, ld + 1);
    } else if (Number(profile.createdAt) > 0) {
      const reg = new Date(Number(profile.createdAt));
      cursor = new Date(reg.getFullYear(), reg.getMonth(), reg.getDate());
    } else {
      cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);
    }
    const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);
    if (cursor < earliest) cursor = earliest;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyTargetMin = (targetH * 60) / daysInMonth; // lib/duty.ts dailyRateMin jaisa
    let accrual = 0;
    let iter = 0;
    const historyEntries: { type: 'daily' | 'hourly'; label: string; delta: number }[] = [];
    while (cursor <= yesterday && iter < 31) {
      const wm = workedMinutesOnDay(punches, ymdOf(cursor));
      const dayBonus = dailyCreditDelta(wm, dailyTargetMin);
      // BOSS RULE (Task 51): on-duty har ghanta -2 — daily accrual ke saath fold
      const cut = hourlyCutFor(wm);
      accrual += dayBonus + cut.delta;
      if (dayBonus !== 0) {
        historyEntries.push({ type: 'daily', label: `Duty day (${(wm / 60).toFixed(1)}h) credit`, delta: dayBonus });
      }
      if (cut.delta !== 0) {
        historyEntries.push({ type: 'hourly', label: `On-duty time (${cut.hours}h)`, delta: cut.delta });
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      iter++;
    }
    if (iter === 0) return;
    setDoc(
      doc(db, 'credit_points', profile.uid),
      { dailyScore: (Number(creditDoc?.dailyScore) || 0) + accrual, lastCreditDay: todayYmd, updatedAt: Date.now() },
      { merge: true }
    ).catch(() => {});
    // Credit history (Boss Task 51): har day ka daily bonus + hourly cut
    historyEntries.forEach((e) => logCreditHistory(profile.uid, e.type, e.label, e.delta));
  }, [profile.role, profile.uid, profile.createdAt, punches, targetH, creditDoc]);

  // ---------- GEOFENCE (Boss order 2026-10-26): net band ho to bhi GPS se
  // outside record hota hai; net aane par outside_logs dashboard me sync ----------
  useEffect(() => {
    if (profile.role === 'manager') return;
    closeStaleOutsideEvent(profile);
    sampleGeofence(profile, isOnDuty);
    const t = window.setInterval(() => sampleGeofence(profile, isOnDuty), SAMPLE_MS);
    return () => window.clearInterval(t);
  }, [profile, isOnDuty]);

  // ---------- OUTSIDE LOG auto points (Boss STOPWATCH order 2026-10-26):
  // har closed log ka outcome AUTOMATIC — koi manual credit editing nahi:
  //   rejected (manager NO)            -> -5 (OUTSIDE_REJECT)
  //   approved (manager YES)           -> 0 (kaam tha — no cut)
  //   pending + allowedMin SET         -> on-time wapas (+5) / late (-4)
  //   pending + allowedMin NOT set     -> -5 (bina bataye gaya = OUTSIDE_NO_NOTICE)
  // 'open' status = event abhi chal raha hai — skip. Atomic transaction se
  // ek log se sirf EK baar cut/credit (double impossible). Purane build ke
  // pending logs (bina closedAt) safe hain — sirf manager YES/NO se honge.
  useEffect(() => {
    if (!isWorker) return; // SALES: outside auto point cuts bhi nahi (credit system unke liye nahi) — logs manager-review ke liye record rehte hain
    const q = query(collection(db, 'outside_logs'), where('uid', '==', profile.uid));
    const unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== 'added' && ch.type !== 'modified') return;
        const data = ch.doc.data() as OutsideLog;
        if (data.status === 'open' || data.cutApplied === true) return;
        if (data.status !== 'rejected' && data.status !== 'approved' && data.status !== 'pending') return;
        if (data.status === 'pending' && !data.closedAt) return; // purana log — manager review only
        // outcome decide (transaction ke andar re-confirm bhi hota hai)
        let delta: number;
        let reason: string;
        if (data.status === 'rejected') {
          delta = CREDIT_POINTS.OUTSIDE_REJECT;
          reason = 'outside_reject';
        } else if (data.status === 'approved') {
          delta = 0;
          reason = 'outside_approved';
        } else if (typeof data.allowedMin === 'number' && data.allowedMin > 0) {
          const onTime = (data.outsideMin || 0) <= data.allowedMin;
          delta = onTime ? CREDIT_POINTS.OUTSIDE_ONTIME : CREDIT_POINTS.OUTSIDE_LATE;
          reason = onTime ? 'outside_ontime' : 'outside_late';
        } else {
          delta = CREDIT_POINTS.OUTSIDE_NO_NOTICE;
          reason = 'outside_no_notice';
        }
        // atomic transaction — ek log se sirf EK baar apply (double-cut impossible)
        runTransaction(db, async (tx) => {
          const lref = doc(db, 'outside_logs', ch.doc.id);
          const ls = await tx.get(lref);
          if (!ls.exists() || ls.data().cutApplied === true) return;
          const ld = ls.data();
          if (ld.status === 'open') return;
          if (ld.status === 'pending' && !ld.closedAt) return;
          // transaction ke andar allowedMin FRESH padho — manager timer race-safe
          let d2: number;
          if (ld.status === 'rejected') d2 = CREDIT_POINTS.OUTSIDE_REJECT;
          else if (ld.status === 'approved') d2 = 0;
          else if (typeof ld.allowedMin === 'number' && ld.allowedMin > 0) {
            d2 = (ld.outsideMin || 0) <= ld.allowedMin ? CREDIT_POINTS.OUTSIDE_ONTIME : CREDIT_POINTS.OUTSIDE_LATE;
          } else d2 = CREDIT_POINTS.OUTSIDE_NO_NOTICE;
          const cref = doc(db, 'credit_points', profile.uid);
          const cs = await tx.get(cref);
          const cur = cs.exists() ? Number(cs.data().taskScore) || 0 : 0;
          tx.set(cref, { taskScore: clampScore(cur + d2), updatedAt: Date.now() }, { merge: true });
          // Credit history (Boss Task 51): outside outcome score ke saath atomic
          const outLabel = d2 === CREDIT_POINTS.OUTSIDE_REJECT
            ? 'Outside work rejected by manager'
            : d2 === CREDIT_POINTS.OUTSIDE_ONTIME
              ? 'Back from outside on time'
              : d2 === CREDIT_POINTS.OUTSIDE_LATE
                ? 'Late return from outside'
                : d2 === CREDIT_POINTS.OUTSIDE_NO_NOTICE
                  ? 'Went outside without notice'
                  : 'Outside work approved';
          if (d2 !== 0) txHistoryEntry(tx, profile.uid, 'outside', outLabel, d2);
          tx.update(lref, {
            cutApplied: true,
            cutPoints: d2,
            cutReason: reason,
            cutAt: Date.now()
          });
        }).catch(() => {});
      });
    }, () => {});
    return () => unsub();
  }, [profile.uid, profile.role]);

  // ---------- SYNC GUARANTEE (Boss order 2026-10-26): mount + net-wapas par
  // outbox reconcile — lib/sync.ts module init me 'online' event + 90s interval
  // bhi hai. Ye effect sirf mount-time flush trigger karta hai. ----------
  useEffect(() => {
    flushOutbox().catch(() => {});
  }, [profile.uid]);

  // ---------- DUTY HEARTBEAT + APP-CLOSE GAP (security — Boss: "staff har tarha
  // ki koshish karega timing bypass ki"): ON duty me har 60s heartbeat (localStorage,
  // net nahi chahiye). App 20 min+ silent raha (force-close/background) to reopen
  // par duty_gaps log banta hai — dashboard manager ko dikhta hai.
  // TOUR RULE (Boss order 2026-10-27): salesman role me duty gaps NAHI —
  // tour me app band hona normal hai, jab tak role badla nahi tracking off. ----------
  useEffect(() => {
    if (profile.role === 'manager' || profile.role === 'sales') return;
    const check = () => {
      if (isOnDuty) heartbeatTouch(profile.uid);
      const gap = detectDutyGap(profile.uid, isOnDuty);
      if (gap) {
        const opId = `dg-${profile.uid}-${gap.fromAt}`;
        const payload = {
          opId,
          uid: profile.uid,
          name: profile.name,
          fromAt: gap.fromAt,
          toAt: gap.toAt,
          gapMin: Math.max(1, Math.round((gap.toAt - gap.fromAt) / 60000)),
          kind: 'app_closed' as const,
          status: 'pending' as const,
          createdAt: Date.now()
        };
        enqueueOutbox('duty_gap', payload, opId); // journal-first (sync guarantee)
        addDoc(collection(db, 'duty_gaps'), payload).catch(() => {});
      }
    };
    check();
    const t = window.setInterval(check, 60 * 1000);
    return () => window.clearInterval(t);
  }, [profile, isOnDuty]);

  // ---------- MAX SHIFT CAP (security): ON duty 16h+ (OFF bhool gaya / jaan
  // boojh ke chhoda) -> auto out punch (auto:true, flags:['max_shift']) +
  // attendance flip. Worked time unlimited na bade — business protection. ----------
  useEffect(() => {
    if (profile.role === 'manager' || !isOnDuty) return;
    const openIn = openInOf(punches);
    if (openIn === null || !overMaxShift(openIn, Date.now())) return;
    if (autoCloseDone(openIn)) return;
    markAutoCloseDone(openIn);
    const at = openIn + MAX_SHIFT_MS; // capped end — 16h se aage credited NAHI
    const cs = clockSnapshot();
    const opId = `pn-${profile.uid}-${at}-auto`;
    const fix = lastGpsFix();
    const autoPunch: PunchRecord = {
      uid: profile.uid,
      name: profile.name,
      type: 'out',
      at,
      lat: fix?.lat ?? 22.3039,
      lng: fix?.lng ?? 70.8022,
      dist: 10,
      opId,
      auto: true,
      flags: ['max_shift'],
      clockOffsetMs: cs.offsetMs,
      clockSuspect: cs.suspect
    };
    enqueueOutbox('punch', autoPunch as unknown as object, opId);
    addDoc(collection(db, 'punches'), autoPunch).catch(() => {});
    setDoc(
      doc(db, 'staff_attendance', profile.uid),
      { uid: profile.uid, name: profile.name, isOnDuty: false, autoClosed: true, updatedAt: serverTimestamp() },
      { merge: true }
    ).catch(() => {});
    enqueueOutbox('attendance', { uid: profile.uid, name: profile.name, isOnDuty: false }, `at-${opId}`);
    setIsOnDuty(false);
  }, [profile, isOnDuty, punches]);

  // ---------- Duty calc (demo strip) ----------
  const calc = useMemo(
    () => computeDutyMin(punches, isOnDuty, targetH, profile.createdAt),
    [punches, isOnDuty, targetH, profile.createdAt]
  );

  const dayPositive = calc.dayDeltaMin >= 0.5;
  const dayNegative = calc.dayDeltaMin <= -0.5;
  const monthPositive = calc.monthDeltaMin >= 0.5;
  const monthNegative = calc.monthDeltaMin <= -0.5;
  const dayLabel = calc.firstInToday === null
    ? 'D. Overtime: 0M'
    : `D. ${dayPositive ? 'Overtime' : 'Undertime'}: ${fmtDur(Math.abs(calc.dayDeltaMin))}`;
  const monthLabel = `M. ${monthNegative ? 'Undertime' : 'Overtime'}: ${fmtDur(Math.abs(calc.monthDeltaMin))}`;
  const dayFraction = `${fmtH(calc.workedTodayMin)} / ${Math.round(calc.dailyRateMin / 60)}H : D`;
  const monthFraction = `${fmtH(calc.workedMonthMin)} / ${Math.round(targetH)}H : M`;

  // Meter percentages (0-100, derived — demo data unchanged, sirf visual)
  const dayPct = Math.max(0, Math.min(100, calc.dailyRateMin > 0 ? (calc.workedTodayMin / calc.dailyRateMin) * 100 : 0));
  const monthPct = Math.max(0, Math.min(100, targetH > 0 ? (calc.workedMonthMin / (targetH * 60)) * 100 : 0));

  // ---------- Duty toggle (ON THE SPOT — Boss order 2026-10-26: "itna wait se
  // monthly staff ke 1-2 min ka fark pad sakta hai") ----------
  // Optimistic: tap hote hi EXACT time capture + UI turant flip — koi loading
  // wait nahi. SYNC-GUARANTEE: har write outbox journal me PEHLE record hota
  // hai (opId ke saath) — Firestore cache evict / app data clear ho jaye to
  // bhi reconcile layer write ko Firebase tak pohnchayegi (lib/sync.ts).
  // INTEGRITY: har punch me clock offset + suspect flags embed — dashboard
  // manager ko timing-tampering ka evidence milta hai (lib/integrity.ts).
  const toggleDuty = (next: boolean) => {
    if (next === isOnDuty) return;
    const at = Date.now(); // tap ka EXACT time — duty minute yahi se count hote hai
    const cs = clockSnapshot();
    const flags: string[] = [];
    if (cs.suspect) flags.push('clock_offset');
    if (clockJumped()) flags.push('clock_jump');
    const opId = `pn-${profile.uid}-${at}-${next ? 'in' : 'out'}`;
    const fix = lastGpsFix(); // GPS ko internet nahi chahiye — real coords jab available
    const punch: PunchRecord = {
      uid: profile.uid,
      name: profile.name,
      type: next ? 'in' : 'out',
      at,
      lat: fix?.lat ?? 22.3039,
      lng: fix?.lng ?? 70.8022,
      dist: 10,
      opId,
      serverEstAt: at + cs.offsetMs,
      clockOffsetMs: cs.offsetMs,
      clockSuspect: cs.suspect,
      flags
    };
    setIsOnDuty(next); // instant — button on the spot kaam karta hai
    enqueueOutbox('punch', punch as unknown as Record<string, unknown>, opId);
    enqueueOutbox('attendance', { uid: profile.uid, name: profile.name, isOnDuty: next }, `at-${opId}`);
    addDoc(collection(db, 'punches'), punch).catch(() => {}); // silent — outbox retry karta hai
    setDoc(doc(db, 'staff_attendance', profile.uid), {
      uid: profile.uid,
      name: profile.name,
      isOnDuty: next,
      updatedAt: serverTimestamp()
    }, { merge: true }).catch(() => {});
  };

  // ---------- Task assign (manager) ----------
  const deadlineAt = useMemo(() => {
    const start = localDayStart(startDate);
    const d = Math.max(1, Math.floor(days) || 1);
    return start + d * 86400000 - 1;
  }, [startDate, days]);

  const activePendingFor = (uid: string): number =>
    tasks.filter((t) => t.toUid === uid && t.status === 'pending').length;

  const handleAssign = async () => {
    if (!isManager || saving) return;
    const staff = staffList.find((s) => s.uid === toUid);
    if (!staff) {
      window.alert('Please select a staff member for this task.');
      return;
    }
    if (!title.trim()) {
      window.alert('Please write the task details.');
      return;
    }
    // BOSS RULE: ek manager ek staff ko max 5 ACTIVE (pending) task de sakta hai.
    if (activePendingFor(toUid) >= MAX_ACTIVE_TASKS_PER_STAFF) {
      window.alert(
        `This staff member already has ${MAX_ACTIVE_TASKS_PER_STAFF} pending tasks.\n` +
        'They have too much work right now — please let them clear the pending tasks first, then assign a new task.'
      );
      return;
    }
    try {
      setSaving(true);
      await addDoc(collection(db, 'tasks'), {
        title: title.trim(),
        byUid: profile.uid,
        byName: profile.name,
        toUid: staff.uid,
        toName: staff.name,
        startAt: localDayStart(startDate),
        days: Math.max(1, Math.floor(days) || 1),
        deadlineAt,
        status: 'pending',
        createdAt: Date.now()
      });
      setTitle('');
      setDays(1);
      setShowForm(false);
      window.alert('Task assigned successfully.');
    } catch (err: any) {
      window.alert('Failed to assign task: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // ---------- LINE SCHEDULE (Boss order 2026-10-27 — SALES): "apne LINE
  // SCHEDULE likh sake usme City ka naam aur ek side date likhni hogi" +
  // "dashboard se monthly SCHEDULE diye jayge home page par apne aap city
  // names showing hone chahiye" — dashboard XL upload / monthly builder jo
  // bhi likhta hai wo BHI yahan live dikhta hai (same collection).
  const [scheduleRows, setScheduleRows] = useState<ScheduleEntry[]>([]);
  const [showSchedForm, setShowSchedForm] = useState(false);
  // MULTI-CITY v2 (Boss order 2026-10-27: "City ke bagal me date bhi aani chahiye") —
  // har row = CITY (left) + USKI DATE (right) pair; multiple rows = ek saath
  // multiple city, alag-alag dates bhi (tour planning). Save par har pair apni entry.
  const [schedRows, setSchedRows] = useState<{ city: string; date: string }[]>([
    { city: '', date: localYmd(Date.now()) }
  ]);
  const [savingSched, setSavingSched] = useState(false);
  const [editSchedId, setEditSchedId] = useState<string | null>(null);
  const [editSchedDate, setEditSchedDate] = useState('');
  const [editSchedCity, setEditSchedCity] = useState('');

  useEffect(() => {
    if (!isSales || !profile.uid) return;
    const q = query(collection(db, 'line_schedule'), where('uid', '==', profile.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEntry, 'id'>) }));
        rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.city.localeCompare(b.city)));
        setScheduleRows(rows);
      },
      () => {}
    );
    return () => unsub();
  }, [isSales, profile.uid]);

  const addScheduleRow = async () => {
    if (savingSched) return;
    if (schedRows.some((r) => !r.date)) {
      window.alert('Please pick a date for every city.');
      return;
    }
    // MULTI-CITY save: har row ka (city, date) pair — comma se likha city bhi
    // split hota hai ("Bhuj, Mundra" = 2 cities usi row ki date par),
    // cityKey dedupe (same city+date 2 baar likha to 1 hi entry). Deterministic
    // id lsch-{uid}-{date}-{citykey} = duplicate doc phir bhi impossible;
    // dashboard Tours page wahi collection padhta hai.
    const seen = new Set<string>();
    const pairs: { city: string; date: string }[] = [];
    schedRows.forEach((r) =>
      (r.city || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((city) => {
          const k = `${r.date}|${cityKeyOf(city)}`;
          if (!seen.has(k)) {
            seen.add(k);
            pairs.push({ city, date: r.date });
          }
        })
    );
    if (!pairs.length) {
      window.alert('Please write the city name.');
      return;
    }
    setSavingSched(true);
    try {
      const results = await Promise.allSettled(
        pairs.map((p) =>
          upsertScheduleEntry({
            uid: profile.uid,
            name: profile.name,
            phone: profile.mobile,
            date: p.date,
            city: p.city,
            source: 'self'
          })
        )
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      const saved = pairs.length - failed;
      if (!saved) {
        window.alert('Could not save schedule: ' + String((results[0] as PromiseRejectedResult)?.reason?.message || 'network error, please try again.'));
        return;
      }
      setSchedRows([{ city: '', date: localYmd(Date.now()) }]);
      setShowSchedForm(false);
      showToast(
        failed
          ? `${saved}/${pairs.length} cities saved — check connection for the rest.`
          : `${saved} ${saved === 1 ? 'city' : 'cities'} saved to line schedule.`
      );
    } catch (e: any) {
      window.alert('Could not save schedule: ' + String(e?.message || e));
    } finally {
      setSavingSched(false);
    }
  };

  // EDIT (Boss: "agar wo usme koi changes karna chahiye to date ya city me kar
  // sakte hai") — date/city badla to NAYA deterministic doc banta hai, purana
  // delete (id bhi date+city se banta hai isliye move = delete+create).
  const saveSchedEdit = async () => {
    if (!editSchedId || savingSched) return;
    if (!editSchedDate) {
      window.alert('Please pick a date.');
      return;
    }
    if (!editSchedCity.trim()) {
      window.alert('Please write the city name.');
      return;
    }
    const row = scheduleRows.find((r) => r.id === editSchedId);
    if (!row) {
      setEditSchedId(null);
      return;
    }
    setSavingSched(true);
    try {
      await upsertScheduleEntry({
        uid: profile.uid,
        name: profile.name,
        phone: profile.mobile,
        date: editSchedDate,
        city: editSchedCity.trim(),
        source: row.source === 'dashboard' ? 'dashboard' : 'self'
      });
      if (row.id) await removeScheduleEntry(row.id).catch(() => {});
      setEditSchedId(null);
      showToast('Schedule updated.');
    } catch (e: any) {
      window.alert('Could not update schedule: ' + String(e?.message || e));
    } finally {
      setSavingSched(false);
    }
  };

  const deleteSchedRow = async (row: ScheduleEntry) => {
    if (!row.id) return;
    if (!window.confirm(`Remove ${row.city} on ${row.date} from your line schedule?`)) return;
    try {
      await removeScheduleEntry(row.id);
      showToast('Schedule entry removed.');
    } catch (e: any) {
      window.alert('Could not remove: ' + String(e?.message || e));
    }
  };

  // ---------- Task verify (manager tap -> verify modal) ----------
  // BUG FIX (Boss order 2026-10-26): pehle window.confirm tha — box band karne
  // (Cancel) par bhi 'false' = NO samajh ke turant -5 cut jata tha, sirf
  // dekhne ke liye click karne par bhi! Ab decision SIRF modal ke explicit
  // YES/NO buttons par — dismiss par KUCH NAHI hota, task pending rehta hai.
  const [verifyTarget, setVerifyTarget] = useState<Task | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const openVerify = (t: Task) => {
    if (t.status !== 'pending' || !isManager) return;
    setVerifyTarget(t);
  };

  const decideVerify = async (yes: boolean) => {
    if (!verifyTarget || verifyBusy) return;
    setVerifyBusy(true);
    try {
      await verifyTask(verifyTarget, yes);
      setVerifyTarget(null);
    } catch (err: any) {
      window.alert('Verify failed: ' + err.message);
    } finally {
      setVerifyBusy(false);
    }
  };

  const pendingTasks = tasks.filter((t) => t.status === 'pending');
  const doneTasks = tasks
    .filter((t) => t.status !== 'pending')
    .sort((a, b) => (b.verifiedAt || b.createdAt) - (a.verifiedAt || a.createdAt));

  // POINTS GUIDE + PROFILE — SLIDE OVERLAYS (Boss rule 2026-10-27: back button
  // kahi nahi hona chahiye, sirf left-edge slide / hardware-back se band hota
  // hai). Home yahan MOUNTED rehta hai — slide karte hi neeche Home reveal
  // hota hai (iOS-style) aur wapas aane par turant wahi state milti hai.
  // Hooks sab pehle chal chuke hote hain — ye conditional render safe hai.

  return (
    <div className="relative min-h-screen text-slate-100 px-4 pb-28">
      {/* Ambient depth — premium feel (fixed glow orbs, layout untouched) */}
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-indigo-500/15" />
      <div className="ambient-orb top-[45%] -left-20 h-56 w-56 bg-amber-400/10" />

      {/* Toast (SOON modules) */}
      {notice && (
        <div
          className="glass-card fixed left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2.5 text-xs font-semibold text-slate-100 shadow-2xl intro-rise"
          style={{ top: 'calc(var(--sat) + 58px)' }}
        >
          {notice}
        </div>
      )}

      {/* HEADER HERO — brand eyebrow + DP + staff name (TAP = profile, long-press = hidden logout) + star badge */}
      <div className="intro-rise relative z-10">
        <div className="glass-card flex items-center justify-between gap-3 rounded-[26px] px-5 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* DP (Boss order 2026-10-27): naam ke saath photo, tap = profile */}
            <button
              onClick={() => setShowProfile(true)}
              className="shrink-0 rounded-full ring-2 ring-amber-300/25 transition active:scale-95"
              title="Open profile"
            >
              <Avatar photo={profile.photo} name={profile.name} size={46} />
            </button>
            <div className="min-w-0">
              <div className="shivam-silver shivam-silver-shine-slow text-[9px] font-bold uppercase tracking-[0.34em]">Shivam Staff</div>
              <span
                className="gold-text mt-0.5 block select-none truncate text-[22px] font-bold leading-tight"
                onTouchStart={startPress}
                onTouchEnd={endPress}
                onTouchMove={cancelPress}
                onMouseDown={startPress}
                onMouseUp={endPress}
                onMouseLeave={cancelPress}
                onContextMenu={(e) => e.preventDefault()}
              >
                {profile.name}
              </span>
            </div>
          </div>
          {isWorker && (
            <div className="flex shrink-0 flex-col items-center">
              <div className="relative flex h-14 w-14 items-center justify-center">
                <div className="star-glow absolute inset-0 rounded-full bg-amber-400/25 blur-md" />
                <svg viewBox="0 0 24 24" className="h-14 w-14 drop-shadow-[0_2px_8px_rgba(245,147,0,0.45)]" fill="url(#homeStarGold)">
                  <defs>
                    <linearGradient id="homeStarGold" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#FFD97A" />
                      <stop offset="55%" stopColor="#F5B93F" />
                      <stop offset="100%" stopColor="#E8912D" />
                    </linearGradient>
                  </defs>
                  <path d="M12 1.7l3.1 6.4 7 1-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-1z" />
                </svg>
                <span className="absolute text-[13.5px] font-black text-[#3B2302]">{creditInfo.rank}</span>
              </div>
              {/* Credit stars (Task 52): har 60 points = 1 star, 300 = 5 stars */}
              <div className="mt-1 flex items-center gap-[1.5px]">
                {[1, 2, 3, 4, 5].map((i) => (
                  <svg key={i} viewBox="0 0 24 24" className={`h-[11px] w-[11px] ${i <= creditInfo.stars ? 'text-amber-300' : 'text-slate-600/70'}`} fill="currentColor">
                    <path d="M12 1.7l3.1 6.4 7 1-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-1z" />
                  </svg>
                ))}
              </div>
              <button
                onClick={() => setShowGuide(true)}
                className="mt-1 rounded-full border border-amber-300/20 bg-amber-400/10 px-2.5 py-0.5 text-[9px] font-extrabold tracking-wide text-amber-300 active:scale-95 transition"
              >
                Credit Points: {creditInfo.total}/{MAX_CREDIT} · Guide
              </button>
              {/* Aaj ka change (Task 52): up = green arrow, down = red arrow */}
              {todayDelta !== null && todayDelta !== 0 && (
                <div
                  className={`mt-1 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-extrabold tracking-wide ${
                    todayDelta > 0
                      ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-300'
                      : 'border-rose-300/25 bg-rose-400/10 text-rose-300'
                  }`}
                >
                  {todayDelta > 0 ? (
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="currentColor"><path d="M12 4l8 12H4z" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="currentColor"><path d="M12 20L4 8h16z" /></svg>
                  )}
                  {todayDelta > 0 ? '+' : ''}{todayDelta} today
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* LINE SCHEDULE (Boss order 2026-10-27 — SALES ONLY): jahan normal staff
          ko tasks dikhte hain wahan salesman apna tour plan likhta/dekhta hai.
          Dashboard se aaya monthly schedule BHI yahin live show hota hai. */}
      {isSales && (
        <div className="relative z-10 mt-6">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-[17px] font-semibold text-[#B7C5F0]">Line Schedule</h2>
              <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-extrabold text-emerald-300">
                {scheduleRows.length}
              </span>
            </div>
            <button
              onClick={() => setShowSchedForm((v) => !v)}
              className={`flex items-center rounded-full px-4 py-2 text-[11px] font-extrabold uppercase tracking-wider shadow-lg transition active:scale-95 ${
                showSchedForm
                  ? 'border border-white/10 bg-white/10 text-slate-200 shadow-none'
                  : 'bg-gradient-to-r from-emerald-400 to-teal-500 text-slate-950 shadow-emerald-500/25'
              }`}
            >
              {showSchedForm ? '× Close' : '+ Add City'}
            </button>
          </div>

          {showSchedForm && (
            <div className="glass-card intro-rise mb-3 space-y-3 rounded-[20px] p-4">
              {/* Boss order 2026-10-27: "City ke bagal me date bhi aani chahiye" —
                  har row me CITY (left) ke saath USKI DATE (right) + X remove;
                  har city ki apni entry banti hai, dates alag-alag bhi chal sakti hain. */}
              <div className="flex items-center gap-2">
                <span className="sec-label min-w-0 flex-1">City</span>
                <span className="sec-label w-[37%] shrink-0">Date</span>
                {schedRows.length > 1 && <span className="w-[30px] shrink-0" />}
              </div>
              {schedRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.city}
                    onChange={(e) =>
                      setSchedRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, city: e.target.value } : r)))
                    }
                    placeholder={i === 0 ? 'e.g. Junagadh' : 'Another city…'}
                    className="glass-inset min-w-0 flex-1 rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:border-amber-300/50 focus:outline-none"
                  />
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) =>
                      setSchedRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, date: e.target.value } : r)))
                    }
                    className="glass-inset w-[37%] shrink-0 rounded-xl p-3 text-xs text-white focus:border-amber-300/50 focus:outline-none"
                  />
                  {schedRows.length > 1 && (
                    <button
                      onClick={() => setSchedRows((rows) => rows.filter((_, ri) => ri !== i))}
                      className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-slate-500 transition active:scale-95 hover:text-rose-300"
                      title="Remove this city"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                {schedRows.length < 8 ? (
                  <button
                    onClick={() =>
                      setSchedRows((rows) => [
                        ...rows,
                        { city: '', date: rows[rows.length - 1]?.date || localYmd(Date.now()) }
                      ])
                    }
                    className="rounded-full border border-dashed border-emerald-300/30 bg-emerald-400/10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-emerald-300 transition active:scale-95"
                  >
                    + Add City
                  </button>
                ) : (
                  <div className="text-[9.5px] font-bold uppercase tracking-wide text-slate-600">Max 8 cities at a time</div>
                )}
                <div className="text-right text-[9.5px] leading-snug text-slate-600">
                  Each city has its own date — commas work too.
                </div>
              </div>
              <button
                onClick={addScheduleRow}
                disabled={savingSched}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-emerald-500/25 disabled:opacity-50 transition active:scale-95"
              >
                {savingSched ? 'Saving...' : 'Save Line Schedule'}
              </button>
            </div>
          )}

          {scheduleRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-5 text-center">
              <div className="text-[13px] font-medium text-slate-400">No line schedule yet.</div>
              <div className="mt-1 text-[10.5px] text-slate-600">
                Add your city + date — your monthly schedule from the dashboard also appears here automatically.
              </div>
            </div>
          ) : (
            /* BOSS order 2026-10-27: "City strip ko slim karo — space kam use ho
               aur hum aur function add kar sake; strip EK box me dikhao, us box
               me scroll karke dusri city dikhni chahiye" — saare cities ab EK hi
               compact glass box me slim rows (40px) ki tarah, zyada entries par
               box ke andar scroll (page lamba nahi hota, niche ke functions ke
               liye jagah bachti hai). */
            <div className="glass-card overflow-hidden rounded-[18px]">
              <div className="max-h-[164px] overflow-y-auto overscroll-contain">
                {scheduleRows.map((row) => {
                  const isToday = row.date === localYmd(Date.now());
                  const dayNum = Number(row.date.slice(8, 10));
                  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  const monthShort = monthNames[Math.max(0, Math.min(11, Number(row.date.slice(5, 7)) - 1))];
                  const dt = new Date(Number(row.date.slice(0, 4)), Number(row.date.slice(5, 7)) - 1, dayNum);
                  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
                  return (
                    <div
                      key={row.id}
                      className={`border-b border-white/5 px-3 py-2.5 last:border-b-0 ${isToday ? 'bg-amber-400/[0.06]' : ''}`}
                    >
                      {editSchedId === row.id ? (
                        <div className="space-y-2">
                          {/* edit mode — sirf ye row expand hoti hai (City LEFT, Date RIGHT) */}
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              value={editSchedCity}
                              onChange={(e) => setEditSchedCity(e.target.value)}
                              placeholder="City"
                              className="glass-inset w-full rounded-xl p-2.5 text-xs text-white placeholder-slate-500 focus:outline-none"
                            />
                            <input
                              type="date"
                              value={editSchedDate}
                              onChange={(e) => setEditSchedDate(e.target.value)}
                              className="glass-inset w-full rounded-xl p-2.5 text-xs text-white focus:outline-none"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={saveSchedEdit}
                              disabled={savingSched}
                              className="flex-1 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-2 text-[10.5px] font-extrabold text-slate-950 disabled:opacity-50 transition active:scale-95"
                            >
                              {savingSched ? 'Saving...' : 'Save Changes'}
                            </button>
                            <button
                              onClick={() => setEditSchedId(null)}
                              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-[10.5px] font-bold text-slate-300 transition active:scale-95"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <MapPin className="h-3 w-3 shrink-0 text-emerald-300/80" />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-100">{row.city}</span>
                          {isToday && (
                            <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[7.5px] font-extrabold tracking-wide text-amber-300">
                              TODAY
                            </span>
                          )}
                          {row.source === 'dashboard' && (
                            <span
                              className="shrink-0 rounded-full border border-sky-300/20 bg-sky-400/10 px-1.5 py-0.5 text-[7.5px] font-extrabold tracking-wide text-sky-300"
                              title="From dashboard"
                            >
                              DASH
                            </span>
                          )}
                          <span className="shrink-0 whitespace-nowrap text-[10px] font-bold text-[#7EB3FF]">
                            {dayNum} {monthShort} · {weekday}
                          </span>
                          <button
                            onClick={() => {
                              setEditSchedId(row.id || null);
                              setEditSchedDate(row.date);
                              setEditSchedCity(row.city);
                            }}
                            className="shrink-0 rounded-md border border-white/10 bg-white/5 p-1.5 text-slate-400 transition active:scale-95 hover:text-slate-200"
                            title="Edit date / city"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => deleteSchedRow(row)}
                            className="shrink-0 rounded-md border border-white/10 bg-white/5 p-1.5 text-slate-400 transition active:scale-95 hover:text-rose-300"
                            title="Remove"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* DUTY STRIP — glass overview (worker only, same 2 rows jaisa demo) */}
      {profile.role === 'worker' && (
        <div className="glass-card intro-rise intro-rise-delay relative z-10 mt-3 rounded-[26px] px-4 py-4">
          <div className="mb-2.5 flex items-center justify-between px-1">
            <span className="sec-label">Duty Overview</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] font-extrabold tracking-[0.12em] ${
              isOnDuty ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-300' : 'border-rose-300/25 bg-rose-400/10 text-rose-300'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isOnDuty ? 'animate-pulse bg-emerald-400' : 'bg-rose-400'}`} />
              {isOnDuty ? 'ON DUTY' : 'OFF DUTY'}
            </span>
          </div>
          <div className="glass-inset rounded-2xl px-4 py-3">
            <div className="flex items-center justify-between">
              <span className={`text-[14.5px] font-extrabold tracking-tight ${dayPositive ? 'text-emerald-300' : dayNegative ? 'text-rose-300' : 'text-slate-400'}`}>
                {dayLabel}
              </span>
              <span className="text-[15px] font-extrabold tabular-nums text-[#5FA8FF]">{dayFraction}</span>
            </div>
            <div className="meter mt-2">
              <span className="bg-gradient-to-r from-[#4C9EFF] to-[#7EB3FF]" style={{ width: `${dayPct}%` }} />
            </div>
          </div>
          <div className="glass-inset mt-2 rounded-2xl px-4 py-3">
            <div className="flex items-center justify-between">
              <span className={`text-[14.5px] font-extrabold tracking-tight ${monthPositive ? 'text-emerald-300' : monthNegative ? 'text-rose-300' : 'text-slate-400'}`}>
                {monthLabel}
              </span>
              <span className="text-[15px] font-extrabold tabular-nums text-[#5FA8FF]">{monthFraction}</span>
            </div>
            <div className="meter mt-2">
              <span className="bg-gradient-to-r from-[#8B5CF6] to-[#C4B5FD]" style={{ width: `${monthPct}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* PENDING TASK heading (+ New Task for manager) — SALES: tasks unke liye nahi (Boss order 2026-10-26) */}
      {!isSales && (<div className="relative z-10 mt-6 mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[17px] font-semibold text-[#B7C5F0]">Pending Task</h2>
          <span className="rounded-full border border-sky-300/20 bg-sky-400/10 px-2 py-0.5 text-[10px] font-extrabold text-sky-300">
            {pendingTasks.length}
          </span>
        </div>
        {isManager && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className={`flex items-center rounded-full px-4 py-2 text-[11px] font-extrabold uppercase tracking-wider shadow-lg transition active:scale-95 ${
              showForm
                ? 'border border-white/10 bg-white/10 text-slate-200 shadow-none'
                : 'bg-gradient-to-r from-emerald-400 to-teal-500 text-slate-950 shadow-emerald-500/25'
            }`}
          >
            {showForm ? '× Close' : '+ New Task'}
          </button>
        )}
      </div>
      )}

      {/* Assign form (manager only) */}
      {isManager && showForm && (
        <div className="glass-card intro-rise relative z-10 mb-5 space-y-4 rounded-[26px] p-5">
          <div>
            <label className="sec-label">Staff Member</label>
            <select
              value={toUid}
              onChange={(e) => setToUid(e.target.value)}
              className="glass-inset mt-1.5 w-full rounded-xl p-3 text-xs text-white focus:border-amber-300/50 focus:outline-none"
            >
              <option value="">— Select staff —</option>
              {staffList.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name} ({s.role}{s.city ? ` • ${s.city}` : ''}) — {activePendingFor(s.uid)}/{MAX_ACTIVE_TASKS_PER_STAFF} pending
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="sec-label">Task Details</label>
            <textarea
              rows={2}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Clean and arrange the nail polish display rack"
              className="glass-inset mt-1.5 w-full rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:border-amber-300/50 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="sec-label">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="glass-inset mt-1.5 w-full rounded-xl p-3 text-xs text-white focus:border-amber-300/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="sec-label">Complete In (Days)</label>
              <input
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="glass-inset mt-1.5 w-full rounded-xl p-3 text-xs text-white focus:border-amber-300/50 focus:outline-none"
              />
            </div>
          </div>
          <div className="glass-inset flex items-center justify-between rounded-xl px-4 py-3">
            <span className="text-[11px] font-medium text-slate-400">Deadline</span>
            <span className="text-[11px] font-extrabold text-[#5FA8FF]">
              {fmtDate(deadlineAt)} <span className="font-medium text-slate-500">• within {Math.max(1, Math.floor(days) || 1)} day(s)</span>
            </span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleAssign}
              disabled={saving}
              className="flex-1 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-emerald-500/25 disabled:opacity-50 transition active:scale-95"
            >
              {saving ? 'Assigning...' : 'Assign Task'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-xs font-bold text-slate-300 transition active:scale-95"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pending task cards — premium glass, status accent */}
      {!isSales && (pendingTasks.length === 0 ? (
        <div className="relative z-10 rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-6 text-center">
          <div className="text-[13.5px] font-medium text-slate-400">
            {isManager ? 'No pending tasks. Tap "+ New Task" to assign one.' : 'No pending tasks. Enjoy your day!'}
          </div>
        </div>
      ) : (
        <div className="relative z-10 space-y-2.5">
          {pendingTasks.map((t, i) => {
            const canTap = isManager;
            const titleColor = TASK_TITLE_COLORS[i % TASK_TITLE_COLORS.length];
            return (
              <button
                key={t.id}
                onClick={() => openVerify(t)}
                disabled={!canTap}
                className="glass-card relative w-full overflow-hidden rounded-[20px] px-4 py-3.5 text-left transition active:scale-[0.985]"
              >
                <span className="absolute inset-y-0 left-0 w-[3.5px]" style={{ background: `linear-gradient(to bottom, ${titleColor}, ${titleColor}44)` }} />
                <div className="flex items-start justify-between gap-2.5 pl-2">
                  <div className="text-[15.5px] font-semibold leading-snug" style={{ color: titleColor }}>{t.title}</div>
                  <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-400/10 px-2.5 py-1 text-[9px] font-extrabold tracking-[0.12em] text-amber-300">
                    PENDING
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-2">
                  <MetaChip icon={CalendarDays} label="Task Date" value={fmtDate(t.startAt)} />
                  <MetaChip icon={Timer} label="Duration" value={fmtDate(t.deadlineAt)} />
                  <PersonChip
                    photoMap={photoMap}
                    uid={isManager ? t.toUid : t.byUid}
                    name={isManager ? t.toName : t.byName}
                    label={isManager ? 'To' : 'By'}
                  />
                </div>
                {canTap && (
                  <div className="mt-2 pl-2 text-[10px] font-extrabold tracking-wide text-[#4C9EFF]">Tap to verify →</div>
                )}
              </button>
            );
          })}
        </div>
      ))}

      {/* Completed / history — Done cards ya "Nil" */}
      {!isSales && (<div className="relative z-10 mt-6">
        <h2 className="mb-2.5 text-[17px] font-semibold text-[#B7C5F0]">Completed Task</h2>
        {doneTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-4">
            <div className="text-[15px] font-semibold text-slate-500">Nil</div>
            <div className="mt-1 text-[10.5px] text-slate-600">Verified tasks will appear here with their result.</div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {doneTasks.map((t) => (
              <div key={t.id} className="glass-card rounded-[20px] px-4 py-3.5">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="text-[15px] font-medium leading-snug text-[#9FB3D9]/85">{t.title}</div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[9px] font-extrabold tracking-[0.12em] ${
                    t.status === 'completed'
                      ? 'border-emerald-300/20 bg-emerald-400/10 text-emerald-300/90'
                      : 'border-rose-300/25 bg-rose-400/10 text-rose-300'
                  }`}>
                    {t.status === 'completed' ? 'DONE' : 'NOT DONE'}
                    {t.pointsDelta !== undefined ? (t.pointsDelta >= 0 ? ` +${t.pointsDelta}` : ` ${t.pointsDelta}`) : ''}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <MetaChip icon={CalendarDays} label="Task Date" value={fmtDate(t.startAt)} />
                  <MetaChip icon={Timer} label="Duration" value={fmtDate(t.deadlineAt)} />
                  <PersonChip
                    photoMap={photoMap}
                    uid={isManager ? t.toUid : t.byUid}
                    name={isManager ? t.toName : t.byName}
                    label={isManager ? 'To' : 'By'}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* FIXED branch avatars (Boss: abhi fixed — premium gradient rings)
          BOSS ORDER 2026-10-27: "Is box me jaha mene white border kiya hai wo
          sirf MANAGER ko dikhega aur kisi ko nahi — staff aur Salesman ise nahi
          dekh sakte; iske bare me hum aage details me baat karenge" — isliye
          strip ab isManager-gated (worker/sales me render hi nahi hoti). */}
      {isManager && (
        <div className="relative z-10 mt-6 flex items-start gap-5 overflow-x-auto border-t border-white/[0.08] pb-1 pt-5">
          {FIXED_BRANCHES.map((b, i) => (
            <div key={b.initials} className="flex min-w-[76px] flex-col items-center gap-2">
              <div className="rounded-full p-[2.5px]" style={{ background: BRANCH_RINGS[i % BRANCH_RINGS.length] }}>
                <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-[#0B1526] text-[17px] font-bold tracking-wide text-slate-100">
                  {b.initials}
                </div>
              </div>
              <span className="whitespace-nowrap text-[10.5px] font-semibold text-slate-300">{b.city}</span>
            </div>
          ))}
          <ChevronRight className="ml-auto h-6 w-6 self-center text-[#4C9EFF]" />
        </div>
      )}

      {/* BOTTOM ROW — Polls (SOON) | Salary Info. (SOON) | On/Off duty toggle */}
      <div className="relative z-10 mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={() => showToast('Polls — coming soon!')}
          className="glass-card relative flex items-center gap-2 rounded-full py-2.5 pl-4 pr-5 text-[14.5px] font-bold text-amber-300 transition active:scale-95"
        >
          <BarChart3 className="h-4 w-4 text-amber-300/80" />
          Polls
          <span className="soon-badge absolute -top-1.5 -right-1 rounded-full border border-white/10 bg-[#101B31] px-1.5 py-px text-[8px] font-extrabold tracking-wider text-slate-400">SOON</span>
        </button>
        <button
          onClick={() => showToast('Salary Info — coming soon!')}
          className="glass-card relative flex items-center gap-2 rounded-full py-2.5 pl-4 pr-5 text-[14.5px] font-bold text-teal-300 transition active:scale-95"
        >
          <Wallet className="h-4 w-4 text-teal-300/80" />
          Salary Info.
          <span className="soon-badge absolute -top-1.5 -right-1 rounded-full border border-white/10 bg-[#101B31] px-1.5 py-px text-[8px] font-extrabold tracking-wider text-slate-400">SOON</span>
        </button>
      </div>

      {/* DUTY TOGGLE — FIXED bottom-RIGHT (Boss order 2026-10-26: "button ko right
          side me jane do", pehle left tha, usse pehle center). App open hote hi
          visible, scroll na kare. Poore app me EK hi instance. Same handlers/writes
          — ZERO logic change, sirf position. Sync number badge REMOVED (Boss:
          "jitni baar dabate hai numbers aa raha hai uski zaroorat nahi").
          SALES: BUTTON NAHI (Boss order 2026-10-26: "salesmen ko on off duty ka
          button bhi nahi hona chahiye, unka duty location par hi chalega") —
          unka duty app khud location ON/OFF se chalata hai. */}
      {!isSales && (
      <div
        className="glass-inset fixed right-4 z-40 flex items-center gap-1 rounded-full p-1 shadow-[0_12px_40px_rgba(2,6,23,0.7)]"
        style={{ bottom: 'calc(var(--sab) + 14px)' }}
      >
        <button
          onClick={() => toggleDuty(true)}
          disabled={isOnDuty}
          className={`rounded-full px-5 py-2.5 text-[14px] font-extrabold transition active:scale-95 ${
            isOnDuty
              ? 'bg-emerald-400 text-slate-950 shadow-[0_0_16px_rgba(52,211,153,0.45)]'
              : 'text-slate-400'
          }`}
        >
          ON
        </button>
        <button
          onClick={() => toggleDuty(false)}
          disabled={!isOnDuty}
          className={`rounded-full px-5 py-2.5 text-[14px] font-extrabold transition active:scale-95 ${
            !isOnDuty
              ? 'bg-rose-500 text-white shadow-[0_0_16px_rgba(244,63,94,0.4)]'
              : 'text-slate-400'
          }`}
        >
          OFF
        </button>
      </div>
      )}

      {/* Verify modal — dismiss (X/backdrop) = NO action, task stays pending */}
      <TaskVerifyModal
        task={verifyTarget}
        busy={verifyBusy}
        onClose={() => setVerifyTarget(null)}
        onDecide={decideVerify}
      />

      {/* POINTS GUIDE — slide overlay (Boss rule: koi back button nahi) */}
      {showGuide && <PointsGuide onBack={() => setShowGuide(false)} />}

      {/* PROFILE — naam tap -> slide overlay (photo add/edit, slide se band) */}
      {showProfile && <ProfileScreen profile={profile} onBack={() => setShowProfile(false)} />}

    </div>
  );
}
