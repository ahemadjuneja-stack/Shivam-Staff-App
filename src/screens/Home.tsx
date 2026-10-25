import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  addDoc,
  setDoc,
  serverTimestamp,
  runTransaction,
  DocumentSnapshot
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, PunchRecord, Task, CreditDoc, OutsideLog } from '../types';
import { computeDutyMin, FALLBACK_TARGET_H } from '../lib/duty';
import { CREDIT_POINTS, MAX_ACTIVE_TASKS_PER_STAFF, totalOf, starsFor, dailyCreditDelta, workedMinutesOnDay } from '../lib/credit';
import { reportDeviceAndLocation } from '../lib/reporting';
import { sampleGeofence, closeStaleOutsideEvent, lastGpsFix, SAMPLE_MS } from '../lib/geofence';
import { CalendarDays, Timer, UserRound, BarChart3, Wallet, ChevronRight } from 'lucide-react';

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
//   Polls (SOON) | Salary Info. (SOON) | On/Off duty toggle
//   Task Msgs box — WhatsApp style chat feed (Boss order 2026-10-25):
//   task events bubbles me — assign (manager naam, left) + verify (Done/Not Done
//   + points), date chips, bubble time, ticks. Manager view: apne msgs right green.
// NO LOGOUT BUTTON (Boss: "app me koi logout button nahi hai") — hidden logout:
//   staff name ko ~1s press & hold karo (design kuch nahi badalta).
// Unclear cheezo pe SOON chip (Boss: "dhire dhire sab samaj ajayga")
// ============================================================

interface HomeProps {
  profile: UserProfile;
  onLogout: () => void;
}

// WhatsApp-style task message bubble (Boss order: "Task msgs ke liye ek box whatsapp jaisa")
interface TaskMsg {
  key: string;
  at: number;
  sender: string; // staff view: manager ka naam (group-chat style label); manager view: ''
  mine: boolean;  // manager view: apne bheje hue (right, green)
  text: string;
  meta: string;   // chhoti line: deadline / points
  verify?: boolean; // verification bubble (bold)
}

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

// "10:32 AM" — WhatsApp bubble time
const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
};

export default function Home({ profile, onLogout }: HomeProps) {
  const isManager = profile.role === 'manager';

  // ---------- Hidden logout (Boss: design me logout button nahi) ----------
  // Staff name ~1s press & hold -> English confirm -> logout (UI me kuch nahi dikhta)
  const pressTimer = useRef<number | null>(null);
  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const startPress = () => {
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      if (window.confirm('Logout from Shivam Staff App?')) onLogout();
    }, 900);
  };
  useEffect(() => cancelPress, []);

  // ---------- Device & location reporting (dashboard StaffDetail ke liye — silent, no UI) ----------
  useEffect(() => {
    reportDeviceAndLocation(profile.uid);
    const t = window.setInterval(() => reportDeviceAndLocation(profile.uid), 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [profile.uid]);

  // ---------- Duty state ----------
  const [isOnDuty, setIsOnDuty] = useState<boolean>(false);
  const [punches, setPunches] = useState<PunchRecord[]>([]);
  const [targetH, setTargetH] = useState<number>(FALLBACK_TARGET_H);
  const [, setTick] = useState(0);

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
      if (docSnap.exists()) setIsOnDuty(docSnap.data().isOnDuty === true);
    });
    return () => unsub();
  }, [profile.uid]);

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
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [isOnDuty]);

  // ---------- Listeners: tasks (visibility rule — manager: uske diye | staff: usko mile) ----------
  useEffect(() => {
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
  }, [profile.uid, isManager]);

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

  // ---------- CREDIT POINTS (live) ----------
  const [creditDoc, setCreditDoc] = useState<CreditDoc | null>(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'credit_points', profile.uid), (snap) => {
      setCreditDoc(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<CreditDoc, 'uid'>) }) : null);
    });
    return () => unsub();
  }, [profile.uid]);

  const [allCredits, setAllCredits] = useState<{ uid: string; taskScore: number; hoursScore: number; dailyScore: number }[]>([]);
  const [staffRoleMap, setStaffRoleMap] = useState<Record<string, string>>({});
  useEffect(() => {
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
  }, []);

  // Live totals + rank stars (top = 5 stars, bottom = 1 star — Boss rule)
  const creditInfo = useMemo(() => {
    const staffUids = Object.entries(staffRoleMap)
      .filter(([, r]) => r === 'worker' || r === 'sales')
      .map(([u]) => u);
    const totals = new Map<string, number>();
    staffUids.forEach((u) => totals.set(u, 0));
    allCredits.forEach((c) => { if (totals.has(c.uid)) totals.set(c.uid, totalOf(c)); });
    const sorted = [...totals.entries()].map(([uid, total]) => ({ uid, total })).sort((a, b) => b.total - a.total);
    const myIdx = sorted.findIndex((e) => e.uid === profile.uid);
    return {
      total: myIdx >= 0 ? sorted[myIdx].total : totalOf(creditDoc),
      stars: starsFor(sorted.map((e) => e.total), myIdx),
      rank: myIdx + 1,
      of: sorted.length
    };
  }, [allCredits, staffRoleMap, profile.uid, creditDoc]);

  // hoursScore updater (worker only): monthly duty on-track/peeche — auto +/-10
  useEffect(() => {
    if (profile.role !== 'worker') return;
    const calc = computeDutyMin(punches, isOnDuty, targetH, profile.createdAt);
    const target = calc.monthDeltaMin >= 0 ? CREDIT_POINTS.HOURS_ONTRACK : CREDIT_POINTS.HOURS_BEHIND;
    if (creditDoc && (Number(creditDoc.hoursScore) || 0) === target) return;
    setDoc(doc(db, 'credit_points', profile.uid), { hoursScore: target, updatedAt: Date.now() }, { merge: true }).catch(() => {});
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
    while (cursor <= yesterday && iter < 31) {
      accrual += dailyCreditDelta(workedMinutesOnDay(punches, ymdOf(cursor)), dailyTargetMin);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      iter++;
    }
    if (iter === 0) return;
    setDoc(
      doc(db, 'credit_points', profile.uid),
      { dailyScore: (Number(creditDoc?.dailyScore) || 0) + accrual, lastCreditDay: todayYmd, updatedAt: Date.now() },
      { merge: true }
    ).catch(() => {});
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

  // ---------- OUTSIDE LOG cut (Boss: "manager NO dabade to points apne aap cut honge") ----------
  useEffect(() => {
    if (profile.role === 'manager') return;
    const q = query(collection(db, 'outside_logs'), where('uid', '==', profile.uid));
    const unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== 'added' && ch.type !== 'modified') return;
        const data = ch.doc.data() as OutsideLog;
        if (data.status !== 'rejected' || data.cutApplied === true) return;
        // atomic transaction — ek log se sirf EK baar cut (double-cut impossible)
        runTransaction(db, async (tx) => {
          const lref = doc(db, 'outside_logs', ch.doc.id);
          const ls = await tx.get(lref);
          if (!ls.exists() || ls.data().status !== 'rejected' || ls.data().cutApplied === true) return;
          const cref = doc(db, 'credit_points', profile.uid);
          const cs = await tx.get(cref);
          const cur = cs.exists() ? Number(cs.data().taskScore) || 0 : 0;
          tx.set(cref, { taskScore: cur + CREDIT_POINTS.OUTSIDE_REJECT, updatedAt: Date.now() }, { merge: true });
          tx.update(lref, { cutApplied: true, cutPoints: CREDIT_POINTS.OUTSIDE_REJECT, cutAt: Date.now() });
        }).catch(() => {});
      });
    }, () => {});
    return () => unsub();
  }, [profile.uid, profile.role]);

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
  // wait nahi. Firestore persistentLocalCache writes offline bhi queue karta
  // hai — net band ho to bhi duty chalega, net aate hi dashboard pe sync.
  const toggleDuty = (next: boolean) => {
    if (next === isOnDuty) return;
    const at = Date.now(); // tap ka EXACT time — duty minute yahi se count hote hai
    setIsOnDuty(next);     // instant — button on the spot kaam karta hai
    setDoc(doc(db, 'staff_attendance', profile.uid), {
      uid: profile.uid,
      name: profile.name,
      isOnDuty: next,
      updatedAt: serverTimestamp()
    }, { merge: true }).catch((err: any) => window.alert('Duty status sync failed: ' + err.message));
    const fix = lastGpsFix(); // GPS ko internet nahi chahiye — real coords jab available
    const newPunch: PunchRecord = {
      uid: profile.uid,
      name: profile.name,
      type: next ? 'in' : 'out',
      at,
      lat: fix?.lat ?? 22.3039,
      lng: fix?.lng ?? 70.8022,
      dist: 10
    };
    addDoc(collection(db, 'punches'), newPunch).catch((err: any) => window.alert('Punch sync failed: ' + err.message));
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

  // ---------- Task Msgs feed (WhatsApp style, tasks se derive — koi naya write nahi) ----------
  const taskMsgs = useMemo<TaskMsg[]>(() => {
    const msgs: TaskMsg[] = [];
    [...tasks]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((t) => {
        msgs.push({
          key: `${t.id}-a`,
          at: t.createdAt,
          sender: isManager ? '' : t.byName,
          mine: isManager,
          text: t.title,
          meta: isManager
            ? `To: ${t.toName} • Deadline: ${fmtDate(t.deadlineAt)}`
            : `Deadline: ${fmtDate(t.deadlineAt)} (${t.days} day${t.days > 1 ? 's' : ''})`
        });
        if (t.verifiedAt) {
          const pts =
            t.pointsDelta !== undefined
              ? t.pointsDelta >= 0
                ? `+${t.pointsDelta} points`
                : `${t.pointsDelta} points`
              : '';
          msgs.push({
            key: `${t.id}-v`,
            at: t.verifiedAt,
            sender: isManager ? '' : t.byName,
            mine: isManager,
            verify: true,
            text: `Task verified: ${t.status === 'completed' ? 'Done' : 'Not Done'}`,
            meta: pts
          });
        }
      });
    return msgs.sort((a, b) => a.at - b.at);
  }, [tasks, isManager]);

  // ---------- Task verify (manager tap -> English Yes/No dialog) ----------
  const handleVerify = (t: Task) => {
    if (t.status !== 'pending' || !isManager) return;
    const yes = window.confirm(`Task: "${t.title}"\nAssigned to: ${t.toName}\n\nIs this task complete?`);
    const onTime = Date.now() <= t.deadlineAt;
    const delta = yes ? (onTime ? CREDIT_POINTS.TASK_EARLY : CREDIT_POINTS.TASK_LATE) : CREDIT_POINTS.TASK_REJECT;
    runTransaction(db, async (tx) => {
      const cref = doc(db, 'credit_points', t.toUid);
      const cs = await tx.get(cref);
      const cur = cs.exists() ? Number(cs.data().taskScore) || 0 : 0;
      tx.update(doc(db, 'tasks', t.id!), {
        status: yes ? 'completed' : 'rejected',
        verifiedAt: Date.now(),
        pointsDelta: delta
      });
      tx.set(cref, { taskScore: cur + delta, updatedAt: Date.now() }, { merge: true });
    }).catch((err: any) => window.alert('Verify failed: ' + err.message));
  };

  const pendingTasks = tasks.filter((t) => t.status === 'pending');
  const doneTasks = tasks
    .filter((t) => t.status !== 'pending')
    .sort((a, b) => (b.verifiedAt || b.createdAt) - (a.verifiedAt || a.createdAt));

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

      {/* HEADER HERO — brand eyebrow + staff name (gold, long-press = hidden logout) + star badge */}
      <div className="intro-rise relative z-10">
        <div className="glass-card flex items-center justify-between gap-3 rounded-[26px] px-5 py-4">
          <div className="min-w-0">
            <div className="shivam-silver shivam-silver-shine-slow text-[9px] font-bold uppercase tracking-[0.34em]">Shivam Staff</div>
            <span
              className="gold-text mt-0.5 block select-none truncate text-[22px] font-bold leading-tight"
              onTouchStart={startPress}
              onTouchEnd={cancelPress}
              onTouchMove={cancelPress}
              onMouseDown={startPress}
              onMouseUp={cancelPress}
              onMouseLeave={cancelPress}
              onContextMenu={(e) => e.preventDefault()}
            >
              {profile.name}
            </span>
          </div>
          {!isManager && (
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
              <span className="mt-1 rounded-full border border-amber-300/20 bg-amber-400/10 px-2.5 py-0.5 text-[9px] font-extrabold tracking-wide text-amber-300">
                Credit Points: {creditInfo.total}
              </span>
            </div>
          )}
        </div>
      </div>

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

      {/* PENDING TASK heading (+ New Task for manager) */}
      <div className="relative z-10 mt-6 mb-2.5 flex items-center justify-between">
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
              placeholder="e.g., Nail na khana saf karvana chhe"
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
      {pendingTasks.length === 0 ? (
        <div className="relative z-10 rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-6 text-center">
          <div className="text-[13.5px] font-medium text-slate-400">
            {isManager ? 'No pending tasks. Tap "+ New Task" to assign one.' : 'No pending tasks. Enjoy your day!'}
          </div>
        </div>
      ) : (
        <div className="relative z-10 space-y-2.5">
          {pendingTasks.map((t) => {
            const canTap = isManager;
            return (
              <button
                key={t.id}
                onClick={() => handleVerify(t)}
                disabled={!canTap}
                className="glass-card relative w-full overflow-hidden rounded-[20px] px-4 py-3.5 text-left transition active:scale-[0.985]"
              >
                <span className="absolute inset-y-0 left-0 w-[3.5px] bg-gradient-to-b from-sky-400 to-indigo-500" />
                <div className="flex items-start justify-between gap-2.5 pl-2">
                  <div className="text-[15.5px] font-semibold leading-snug text-[#7EB3FF]">{t.title}</div>
                  <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-400/10 px-2.5 py-1 text-[9px] font-extrabold tracking-[0.12em] text-amber-300">
                    PENDING
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-2">
                  <MetaChip icon={CalendarDays} label="Task Date" value={fmtDate(t.startAt)} />
                  <MetaChip icon={Timer} label="Duration" value={fmtDate(t.deadlineAt)} />
                  <MetaChip icon={UserRound} label={isManager ? 'To' : 'By'} value={isManager ? t.toName : t.byName} />
                </div>
                {canTap && (
                  <div className="mt-2 pl-2 text-[10px] font-extrabold tracking-wide text-[#4C9EFF]">Tap to verify →</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Completed / history — Done cards ya "Nil" */}
      <div className="relative z-10 mt-6">
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
                  <MetaChip icon={UserRound} label={isManager ? 'To' : 'By'} value={isManager ? t.toName : t.byName} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* TASK MSGS BOX — WhatsApp style chat feed (Boss order — WhatsApp look intact, premium shell) */}
      <div className="relative z-10 mt-6">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold text-[#B7C5F0]">Task Msgs</h2>
          <span className="sec-label">Live Feed</span>
        </div>
        <div className="overflow-hidden rounded-[24px] border border-white/10 shadow-[0_16px_44px_rgba(2,6,23,0.55)]">
          <div className="flex items-center gap-2 border-b border-black/40 bg-[#1F2C34] px-4 py-2.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-[10.5px] font-extrabold tracking-[0.16em] text-slate-300">TASK FEED</span>
            <span className="ml-auto text-[9px] font-semibold text-slate-500">WhatsApp style • live</span>
          </div>
          <div className="chat-scroll max-h-[420px] overflow-y-auto bg-[#0B141A] px-3 py-3.5">
            {taskMsgs.length === 0 ? (
              <div className="py-6 text-center text-[13px] text-[#8A93A6]">No task messages yet.</div>
            ) : (
              taskMsgs.map((m, i) => {
                const chip = i === 0 || fmtDate(taskMsgs[i - 1].at) !== fmtDate(m.at);
                return (
                  <div key={m.key}>
                    {chip && (
                      <div className="my-2.5 flex justify-center">
                        <span className="rounded-lg bg-[#1D2B47]/80 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-[#8A93A6]">
                          {fmtDate(m.at)}
                        </span>
                      </div>
                    )}
                    <div className={`flex pb-1.5 ${m.mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] px-3 py-2 shadow-md ${
                          m.mine
                            ? 'bg-[#005C4B] rounded-2xl rounded-tr-sm'
                            : 'bg-[#202C33] rounded-2xl rounded-tl-sm'
                        }`}
                      >
                        {!m.mine && m.sender && (
                          <div className="text-[11px] font-bold leading-tight text-[#53BDEB]">{m.sender}</div>
                        )}
                        <div
                          className={`whitespace-pre-wrap break-words text-[13.5px] leading-snug ${
                            m.verify ? 'font-semibold' : ''
                          } ${m.mine ? 'text-[#E9FFEC]' : 'text-slate-100'}`}
                        >
                          {m.text}
                        </div>
                        {m.meta && <div className="mt-0.5 text-[10.5px] text-[#8696A0]">{m.meta}</div>}
                        <div className="mt-0.5 flex items-center justify-end gap-1">
                          <span className="text-[9.5px] text-[#8696A0]">{fmtTime(m.at)}</span>
                          {m.mine && (
                            <span className="text-[10px] font-bold leading-none text-[#53BDEB]">✓✓</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* FIXED branch avatars (Boss: abhi fixed — premium gradient rings) */}
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

      {/* DUTY TOGGLE — FIXED bottom-LEFT (Boss order: left side adjust, app open
          hote hi on/off, upar-neeche scroll na kare. Poore app me EK hi instance.
          Same handlers/writes — ZERO logic change, sirf position.) */}
      <div
        className="glass-inset fixed left-4 z-40 flex items-center gap-1 rounded-full p-1 shadow-[0_12px_40px_rgba(2,6,23,0.7)]"
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

    </div>
  );
}
