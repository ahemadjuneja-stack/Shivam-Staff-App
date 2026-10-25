import { useEffect, useMemo, useState } from 'react';
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
import { UserProfile, PunchRecord, Task, CreditDoc } from '../types';
import { computeDutyMin, FALLBACK_TARGET_H } from '../lib/duty';
import { CREDIT_POINTS, MAX_ACTIVE_TASKS_PER_STAFF, totalOf, starsFor } from '../lib/credit';

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
// Unclear cheezo pe SOON chip (Boss: "dhire dhire sab samaj ajayga")
// ============================================================

interface HomeProps {
  profile: UserProfile;
  onLogout: () => void;
}

// Fixed branch avatars (Boss: "Abhi fixed" — aage real branch data)
const FIXED_BRANCHES = [
  { initials: 'ZS', city: 'Patan Gujarat' },
  { initials: 'RR', city: 'Godhra, Gujarat' },
  { initials: 'SK', city: 'Mangrol, Gujarat' }
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

  // ---------- Duty state ----------
  const [isOnDuty, setIsOnDuty] = useState<boolean>(false);
  const [attendanceLoading, setAttendanceLoading] = useState<boolean>(false);
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

  const [allCredits, setAllCredits] = useState<{ uid: string; taskScore: number; hoursScore: number }[]>([]);
  const [staffRoleMap, setStaffRoleMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'credit_points'), (snap) => {
      setAllCredits(snap.docs.map((d) => ({ uid: d.id, taskScore: Number(d.data().taskScore) || 0, hoursScore: Number(d.data().hoursScore) || 0 })));
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

  // ---------- Duty toggle (On/Off pills) ----------
  const toggleDuty = async (next: boolean) => {
    if (attendanceLoading || next === isOnDuty) return;
    try {
      setAttendanceLoading(true);
      await setDoc(doc(db, 'staff_attendance', profile.uid), {
        uid: profile.uid,
        name: profile.name,
        isOnDuty: next,
        updatedAt: serverTimestamp()
      }, { merge: true });
      const newPunch: PunchRecord = {
        uid: profile.uid,
        name: profile.name,
        type: next ? 'in' : 'out',
        at: Date.now(),
        lat: 22.3039,
        lng: 70.8022,
        dist: 10
      };
      await addDoc(collection(db, 'punches'), newPunch);
      setIsOnDuty(next);
    } catch (err: any) {
      window.alert('Failed to update duty status: ' + err.message);
    } finally {
      setAttendanceLoading(false);
    }
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
    <div className="min-h-screen text-slate-100 px-4 pb-16">
      {/* Toast (SOON modules) */}
      {notice && (
        <div
          className="fixed left-1/2 z-50 -translate-x-1/2 bg-[#1D2B47] border border-[#38BDF8]/40 text-white text-xs px-4 py-2.5 rounded-full shadow-2xl animate-fade-in"
          style={{ top: 'calc(var(--sat) + 58px)' }}
        >
          {notice}
        </div>
      )}

      {/* HEADER ROW — staff name (gold) + star badge with live credit points */}
      <div className="flex items-center justify-end gap-2.5 pb-3">
        <span className="text-[17px] font-bold text-[#FBBF24]">{profile.name}</span>
        {!isManager && (
          <div className="relative flex h-11 w-11 items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-11 w-11 text-[#F59300] drop-shadow-[0_2px_6px_rgba(245,147,0,0.35)]" fill="currentColor">
              <path d="M12 1.7l3.1 6.4 7 1-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-1z" />
            </svg>
            <span className="absolute text-[12px] font-black text-[#3B2302]">{creditInfo.total}</span>
          </div>
        )}
      </div>

      {/* DUTY STRIP — compact 2 rows (worker only, jaisa pehle) */}
      {profile.role === 'worker' && (
        <div className="border-y border-[#2A3F68]/60 py-2.5 mb-4">
          <div className="flex items-center justify-between py-1">
            <span className={`text-[15px] font-extrabold tracking-tight ${dayPositive ? 'text-[#34D399]' : dayNegative ? 'text-[#FB7185]' : 'text-[#8A93A6]'}`}>
              {dayLabel}
            </span>
            <span className="text-[15px] font-extrabold text-[#4C9EFF]">{dayFraction}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className={`text-[15px] font-extrabold tracking-tight ${monthPositive ? 'text-[#34D399]' : monthNegative ? 'text-[#FB7185]' : 'text-[#8A93A6]'}`}>
              {monthLabel}
            </span>
            <span className="text-[15px] font-extrabold text-[#4C9EFF]">{monthFraction}</span>
          </div>
        </div>
      )}

      {/* PENDING TASK heading (+ New Task for manager) */}
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[17px] font-semibold text-[#B7C5F0]">Pending Task :</h2>
        {isManager && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="text-[11px] font-extrabold uppercase tracking-wider text-[#34D399] active:scale-95 transition"
          >
            {showForm ? '× Close' : '+ New Task'}
          </button>
        )}
      </div>

      {/* Assign form (manager only) */}
      {isManager && showForm && (
        <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] mb-5 space-y-4">
          <div>
            <label className="text-xs font-semibold text-[#8A93A6]">Staff Member</label>
            <select
              value={toUid}
              onChange={(e) => setToUid(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-xs text-white focus:border-[#F59300] focus:outline-none"
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
            <label className="text-xs font-semibold text-[#8A93A6]">Task Details</label>
            <textarea
              rows={2}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Nail na khana saf karvana chhe"
              className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-xs text-white placeholder-slate-500 focus:border-[#F59300] focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-[#8A93A6]">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-xs text-white focus:border-[#F59300] focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-[#8A93A6]">Complete In (Days)</label>
              <input
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-xs text-white focus:border-[#F59300] focus:outline-none"
              />
            </div>
          </div>
          <div className="rounded-xl bg-[#121F36] border border-[#1D2B47] px-4 py-3">
            <span className="text-[11px] text-[#8A93A6] font-medium">Deadline: </span>
            <span className="text-[11px] font-bold text-[#4C9EFF]">{fmtDate(deadlineAt)}</span>
            <span className="text-[11px] text-[#8A93A6]"> (within {Math.max(1, Math.floor(days) || 1)} day(s) from {fmtDate(localDayStart(startDate))})</span>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleAssign}
              disabled={saving}
              className="flex-1 rounded-xl bg-[#10B981] py-3 text-xs font-extrabold text-slate-950 shadow-lg disabled:opacity-50 transition active:scale-95"
            >
              {saving ? 'Assigning...' : 'Assign Task'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-xl bg-[#1D2B47] px-5 py-3 text-xs font-bold text-[#8A93A6] transition active:scale-95"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pending task cards — demo strip style */}
      {pendingTasks.length === 0 ? (
        <div className="border-b border-[#1D2B47]/70 py-4 text-[15px] text-[#8A93A6]">
          {isManager ? 'No pending tasks. Tap "+ New Task" to assign one.' : 'No pending tasks.'}
        </div>
      ) : (
        pendingTasks.map((t) => {
          const canTap = isManager;
          return (
            <button
              key={t.id}
              onClick={() => handleVerify(t)}
              disabled={!canTap}
              className="w-full text-left border-b border-[#1D2B47]/70 py-3.5 active:opacity-80 transition"
            >
              <div className="text-[16px] font-medium text-[#7EB3FF] leading-snug">{t.title}</div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-300">
                <span>Task Date: {fmtDate(t.startAt)}</span>
                <span>Duration: {fmtDate(t.deadlineAt)}</span>
                <span>{isManager ? `To: ${t.toName}` : `By: ${t.byName}`}</span>
                <span>Status: <span className="font-bold text-[#34D399]">Pending</span></span>
              </div>
              {canTap && (
                <div className="mt-1 text-[10px] font-bold text-[#4C9EFF]">Tap to verify →</div>
              )}
            </button>
          );
        })
      )}

      {/* Completed / history — Done cards ya "Nil" */}
      <div className="mt-1">
        {doneTasks.length === 0 ? (
          <div className="border-b border-[#1D2B47]/70 py-3.5">
            <div className="text-[16px] text-[#8A93A6]">Nil</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#8A93A6]">
              <span>Task Date:</span>
              <span>Duration:</span>
              <span>By:</span>
              <span>Status: <span className="font-bold text-slate-400">Done</span></span>
            </div>
          </div>
        ) : (
          doneTasks.map((t) => (
            <div key={t.id} className="border-b border-[#1D2B47]/70 py-3.5">
              <div className="text-[16px] font-medium text-[#9FB3D9]/85 leading-snug">{t.title}</div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#8A93A6]">
                <span>Task Date: {fmtDate(t.startAt)}</span>
                <span>Duration: {fmtDate(t.deadlineAt)}</span>
                <span>{isManager ? `To: ${t.toName}` : `By: ${t.byName}`}</span>
                <span>
                  Status:{' '}
                  <span className={`font-bold ${t.status === 'completed' ? 'text-slate-400' : 'text-[#FB7185]'}`}>
                    {t.status === 'completed' ? 'Done' : 'Not Done'}
                    {t.pointsDelta !== undefined ? (t.pointsDelta >= 0 ? ` +${t.pointsDelta}` : ` ${t.pointsDelta}`) : ''}
                  </span>
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* FIXED branch avatars (Boss: abhi fixed — demo jaisa) */}
      <div className="mt-5 border-t border-[#2A3F68]/60 pt-4 flex items-start gap-5 overflow-x-auto">
        {FIXED_BRANCHES.map((b) => (
          <div key={b.initials} className="flex flex-col items-center gap-1.5 min-w-[72px]">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#232E44] border border-[#31405C] text-[20px] font-bold text-slate-200">
              {b.initials}
            </div>
            <span className="text-[11px] font-medium text-slate-200 whitespace-nowrap">{b.city}</span>
          </div>
        ))}
        <span className="ml-auto self-center text-2xl font-light text-[#4C9EFF] select-none">›</span>
      </div>

      {/* BOTTOM ROW — Polls (SOON) | Salary Info. (SOON) | On/Off duty toggle */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => showToast('Polls — coming soon!')}
          className="relative rounded-full bg-[#0E2233] border border-[#1D2B47] px-6 py-3 text-[16px] font-bold text-[#FBBF24] active:scale-95 transition"
        >
          Polls
          <span className="absolute -top-1.5 -right-1 bg-[#1D2B47] border border-[#2A3F68] text-[#7C8AA5] text-[8px] font-extrabold px-1.5 py-px rounded-full">SOON</span>
        </button>
        <button
          onClick={() => showToast('Salary Info — coming soon!')}
          className="relative rounded-full bg-[#0E2233] border border-[#1D2B47] px-6 py-3 text-[16px] font-bold text-[#2DD4BF] active:scale-95 transition"
        >
          Salary Info.
          <span className="absolute -top-1.5 -right-1 bg-[#1D2B47] border border-[#2A3F68] text-[#7C8AA5] text-[8px] font-extrabold px-1.5 py-px rounded-full">SOON</span>
        </button>
        <div className="ml-auto flex items-center gap-2.5">
          <button
            onClick={() => toggleDuty(true)}
            disabled={attendanceLoading || isOnDuty}
            className={`rounded-full px-5 py-3 text-[15px] font-bold transition active:scale-95 ${
              isOnDuty ? 'bg-[#10B981] text-slate-950' : 'bg-[#334155] text-slate-300'
            } ${attendanceLoading ? 'opacity-60' : ''}`}
          >
            On
          </button>
          <button
            onClick={() => toggleDuty(false)}
            disabled={attendanceLoading || !isOnDuty}
            className={`rounded-full px-5 py-3 text-[15px] font-bold transition active:scale-95 ${
              !isOnDuty ? 'bg-[#DC2626] text-white' : 'bg-[#334155] text-slate-300'
            } ${attendanceLoading ? 'opacity-60' : ''}`}
          >
            Off
          </button>
        </div>
      </div>

      {/* Logout — subtle (functional zaroori hai, purana style nahi) */}
      <div className="mt-9 mb-1 text-center">
        <button
          onClick={onLogout}
          className="text-[11px] font-semibold text-[#64748B] underline underline-offset-2 active:opacity-70"
        >
          Logout
        </button>
      </div>
    </div>
  );
}
