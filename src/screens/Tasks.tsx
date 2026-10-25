import { useMemo, useState, useEffect } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  addDoc,
  runTransaction
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, Task } from '../types';
import { CREDIT_POINTS, MAX_ACTIVE_TASKS_PER_STAFF } from '../lib/credit';

// ============================================================
// TASKS SCREEN (Boss order 2026-10-25)
// - MANAGER/ADMIN: task assign karta hai (staff picker, start date, kitne din,
//   deadline auto) — ek staff pe max 5 ACTIVE tasks (popup block)
// - STAFF (worker/sales): SIRF apne tasks dikhte hain — kisne diya, dates, status
// - VERIFY: manager tap -> English dialog "Is this task complete?" Yes/No
//   Yes on-time +10 | Yes late -5 | No -10  (credit_points/{uid}.taskScore atomic)
// - Visibility: task sirf usi staff ko dikhta hai jisko diya; verify sirf usi
//   manager jo diya (queries byUid/toUid scoped)
// ============================================================

interface TasksScreenProps {
  profile: UserProfile;
  slideCls: string;
}

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getFullYear()).slice(2)}`;
};

const localDayStart = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

export default function TasksScreen({ profile, slideCls }: TasksScreenProps) {
  const isManager = profile.role === 'manager';

  const [tasks, setTasks] = useState<Task[]>([]);
  const [staffList, setStaffList] = useState<UserProfile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // form state
  const [toUid, setToUid] = useState('');
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [days, setDays] = useState(1);

  // Task listener: manager = uske diye tasks | staff = usko mile tasks (visibility rule)
  useEffect(() => {
    const field = isManager ? 'byUid' : 'toUid';
    const q = query(collection(db, 'tasks'), where(field, '==', profile.uid));
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Task, 'id'>) }));
      rows.sort((a, b) => {
        const rank = (s: Task['status']) => (s === 'pending' ? 0 : 1); // pending pehle
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
        return b.createdAt - a.createdAt;
      });
      setTasks(rows);
    });
    return () => unsub();
  }, [profile.uid, isManager]);

  // Manager: active staff list (worker + sales) — assign form picker ke liye
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

  const deadlineAt = useMemo(() => {
    const start = localDayStart(startDate);
    const d = Math.max(1, Math.floor(days) || 1);
    return start + d * 86400000 - 1; // end of the days-th day (Boss: 20 ko diya, 3 din -> 23 tak)
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
    // Zyada pe popup — "bahut zyada kaam hai, pehle wo clear karne de".
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

  // VERIFY (Boss rule): sirf yahi manager jo task diya; tap -> English Yes/No
  const handleVerify = (t: Task) => {
    if (t.status !== 'pending' || !isManager) return;
    const yes = window.confirm(`Task: "${t.title}"\nAssigned to: ${t.toName}\n\nIs this task complete?`);
    const onTime = Date.now() <= t.deadlineAt;
    const delta = yes ? (onTime ? CREDIT_POINTS.TASK_EARLY : CREDIT_POINTS.TASK_LATE) : CREDIT_POINTS.TASK_REJECT;
    runTransaction(db, async (tx) => {
      // NOTE: transaction me saare reads PEHLE, phir writes (Firestore rule)
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

  const statusChip = (t: Task) => {
    if (t.status === 'pending') {
      return <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-lg bg-amber-400/15 text-amber-300 border border-amber-400/30">PENDING</span>;
    }
    if (t.status === 'completed') {
      return <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-lg bg-[#10B981]/15 text-[#34D399] border border-[#10B981]/40">COMPLETED {t.pointsDelta !== undefined && t.pointsDelta >= 0 ? `+${t.pointsDelta}` : t.pointsDelta}</span>;
    }
    return <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-400 border border-rose-500/40">REJECTED {t.pointsDelta}</span>;
  };

  const topBar = (
    <div className="mb-5 flex items-center px-1">
      <span className="mr-2.5 h-5 w-1 rounded-full bg-[#F59300]" />
      <h2 className="text-lg font-extrabold text-white tracking-wide uppercase">Tasks</h2>
    </div>
  );

  return (
    <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
      {topBar}

      {/* Manager: Assign Task Button Polish */}
      {isManager && (
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-full mb-5 rounded-xl bg-[#10B981] hover:bg-emerald-600 py-3.5 px-4 text-xs font-bold text-slate-950 flex items-center justify-center gap-2 shadow-lg active:scale-[0.98] transition"
        >
          {showForm ? (
            <span>× Close</span>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
              <span>+ New Task</span>
            </>
          )}
        </button>
      )}

      {/* Manager: Assign form */}
      {isManager && showForm && (
        <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] mb-6 space-y-4">
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
            <span className="text-[11px] font-bold text-[#38BDF8]">{fmtDate(deadlineAt)}</span>
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

      {/* Task list */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-[#5B677D] uppercase tracking-[2.4px] px-1">
          {isManager ? 'Tasks Assigned By Me' : 'My Tasks'}
        </h3>
        {tasks.length === 0 ? (
          <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-6 text-center text-xs text-[#8A93A6]">
            {isManager ? 'No tasks assigned yet. Tap "+ New Task" to create one.' : 'No tasks assigned to you yet.'}
          </div>
        ) : (
          tasks.map((t) => {
            const pending = t.status === 'pending';
            const canTap = isManager && pending;
            return (
              <button
                key={t.id}
                onClick={() => handleVerify(t)}
                disabled={!canTap}
                className={`w-full text-left bg-[#0C1628] border rounded-[22px] p-4 shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition active:scale-[0.99] hover:bg-slate-800/40 ${
                  canTap ? 'border-[#2A3F68]' : 'border-[#1D2B47]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-xs font-bold text-white leading-relaxed">{t.title}</h4>
                    <p className="text-[11px] text-[#8A93A6] mt-1">
                      {isManager ? `To: ${t.toName}` : `By: ${t.byName}`}
                    </p>
                  </div>
                  {statusChip(t)}
                </div>
                <div className="flex items-center gap-4 mt-2.5">
                  <span className="text-[10px] font-mono text-[#8A93A6] bg-[#121F36] px-2.5 py-1 rounded-lg border border-[#1D2B47]">
                    Start: {fmtDate(t.startAt)}
                  </span>
                  <span className="text-[10px] font-mono text-[#8A93A6] bg-[#121F36] px-2.5 py-1 rounded-lg border border-[#1D2B47]">
                    Deadline: {fmtDate(t.deadlineAt)}
                  </span>
                  {canTap && (
                    <span className="text-[10px] font-bold text-[#38BDF8] ml-auto">Tap to verify →</span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
