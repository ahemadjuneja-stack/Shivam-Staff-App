import React, { useState, useEffect } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  doc,
  limit,
  setDoc,
  serverTimestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  UserProfile,
  PunchRecord,
  WorkLog,
  StarEvent
} from '../types';
import {
  ShoppingCart,
  ClipboardList,
  CalendarClock,
  User,
  ArrowLeft,
  Star,
  CheckCircle2,
  LogOut
} from 'lucide-react';

interface HomeProps {
  profile: UserProfile;
}

type ActiveModule = 'home' | 'sale' | 'worklog' | 'attendance' | 'profile';

export default function Home({ profile }: HomeProps) {
  const [activeModule, setActiveModule] = useState<ActiveModule>('home');

  // Duty / Attendance state
  const [isOnDuty, setIsOnDuty] = useState<boolean>(false);
  const [attendanceLoading, setAttendanceLoading] = useState<boolean>(false);

  // Stars state
  const [totalStars, setTotalStars] = useState<number>(0);
  const [stars, setStars] = useState<StarEvent[]>([]);

  // Work Logs state
  const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
  const [logText, setLogText] = useState('');
  const [submittingLog, setSubmittingLog] = useState(false);

  // Punches history state
  const [punches, setPunches] = useState<PunchRecord[]>([]);

  // Sale / Order state
  const [customerName, setCustomerName] = useState('');
  const [itemDetails, setItemDetails] = useState('');
  const [amount, setAmount] = useState('');
  const [submittingSale, setSubmittingSale] = useState(false);
  const [saleSuccess, setSaleSuccess] = useState(false);

  // Fetch current duty status
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'staff_attendance', profile.uid), (docSnap) => {
      if (docSnap.exists()) {
        setIsOnDuty(docSnap.data().isOnDuty === true);
      }
    });
    return () => unsub();
  }, [profile.uid]);

  // Real-time Stars listener
  useEffect(() => {
    const q = query(
      collection(db, 'stars'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StarEvent, 'id'>)
      }));
      setStars(records);
      const total = records.reduce((sum, item) => sum + (item.delta || 0), 0);
      setTotalStars(total);
    });
    return () => unsub();
  }, [profile.uid]);

  // Real-time Work Logs listener
  useEffect(() => {
    const q = query(
      collection(db, 'worklogs'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<WorkLog, 'id'>)
      }));
      setWorkLogs(logs);
    });
    return () => unsub();
  }, [profile.uid]);

  // Real-time Punches listener
  useEffect(() => {
    const q = query(
      collection(db, 'punches'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PunchRecord, 'id'>)
      }));
      setPunches(records);
    });
    return () => unsub();
  }, [profile.uid]);

  // Toggle Duty Status
  const toggleDuty = async () => {
    try {
      setAttendanceLoading(true);
      const nextStatus = !isOnDuty;
      await setDoc(doc(db, 'staff_attendance', profile.uid), {
        uid: profile.uid,
        name: profile.name,
        isOnDuty: nextStatus,
        updatedAt: serverTimestamp()
      }, { merge: true });

      // Also record punch
      const newPunch: PunchRecord = {
        uid: profile.uid,
        name: profile.name,
        type: nextStatus ? 'in' : 'out',
        at: Date.now(),
        lat: 22.3039,
        lng: 70.8022,
        dist: 10
      };
      await addDoc(collection(db, 'punches'), newPunch);
      setIsOnDuty(nextStatus);
    } catch (err: any) {
      alert('Failed to update duty status: ' + err.message);
    } finally {
      setAttendanceLoading(false);
    }
  };

  // Submit Work Log
  const handleWorkLogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!logText.trim()) return;
    try {
      setSubmittingLog(true);
      const todayStr = new Date().toISOString().split('T')[0];
      await addDoc(collection(db, 'worklogs'), {
        uid: profile.uid,
        name: profile.name,
        date: todayStr,
        text: logText.trim(),
        status: 'pending',
        at: Date.now()
      });
      setLogText('');
      alert('Work log submitted successfully for owner review.');
    } catch (err: any) {
      alert('Failed to submit work log: ' + err.message);
    } finally {
      setSubmittingLog(false);
    }
  };

  // Submit Sale Order
  const handleSaleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim() || !amount) return;
    try {
      setSubmittingSale(true);
      await addDoc(collection(db, 'ledger_entries'), {
        kind: 'jama',
        cname: customerName.trim(),
        amount: parseFloat(amount) || 0,
        mode: 2, // UPI/Cash
        note: itemDetails.trim(),
        byUid: profile.uid,
        byName: profile.name,
        at: Date.now(),
        miracle: false
      });
      setSaleSuccess(true);
      setCustomerName('');
      setItemDetails('');
      setAmount('');
      setTimeout(() => setSaleSuccess(false), 3000);
    } catch (err: any) {
      alert('Failed to save sale order: ' + err.message);
    } finally {
      setSubmittingSale(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('shivam_staff_logged_user');
    window.location.reload();
  };

  if (activeModule === 'sale') {
    return (
      <div className="space-y-4 p-4 text-slate-100 max-w-lg mx-auto">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
          <button onClick={() => setActiveModule('home')} className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-white">New Sale / Order Entry</h2>
            <p className="text-xs text-slate-400">Create customer order & record entry</p>
          </div>
        </div>

        {saleSuccess && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            <span>Sale order successfully recorded!</span>
          </div>
        )}

        <form onSubmit={handleSaleSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl">
          <div>
            <label className="text-xs text-slate-400">Customer Name / Firm</label>
            <input
              type="text"
              required
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Shree Ganesh Packaging"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Item Details & Quantity</label>
            <input
              type="text"
              required
              value={itemDetails}
              onChange={(e) => setItemDetails(e.target.value)}
              placeholder="5 Rolls Blue Strapping, 2 Rolls Stretch Film"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Total Amount (₹)</label>
            <input
              type="number"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10500"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={submittingSale}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50"
          >
            {submittingSale ? 'Saving Order...' : 'Submit Sale Order'}
          </button>
        </form>
      </div>
    );
  }

  if (activeModule === 'worklog') {
    return (
      <div className="space-y-4 p-4 text-slate-100 max-w-lg mx-auto">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
          <button onClick={() => setActiveModule('home')} className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-white">Daily Work Log</h2>
            <p className="text-xs text-slate-400">Submit today's task summary for review</p>
          </div>
        </div>

        <form onSubmit={handleWorkLogSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl">
          <div>
            <label className="text-xs text-slate-400">Today's Work Summary</label>
            <textarea
              rows={3}
              required
              value={logText}
              onChange={(e) => setLogText(e.target.value)}
              placeholder="Dispatched orders, verified inventory stock, godown cleaning..."
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 p-3 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              disabled={submittingLog}
            />
          </div>
          <button
            type="submit"
            disabled={submittingLog || !logText.trim()}
            className="w-full rounded-xl bg-indigo-600 py-3 text-xs font-bold text-white shadow hover:bg-indigo-500 disabled:opacity-50"
          >
            {submittingLog ? 'Submitting...' : 'Submit Work Log'}
          </button>
        </form>

        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Recent Submitted Logs</h3>
          {workLogs.length === 0 ? (
            <p className="text-xs text-slate-500">No work logs submitted yet.</p>
          ) : (
            workLogs.map((log) => (
              <div key={log.id} className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 text-xs">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-slate-400 text-[11px]">{log.date}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      log.status === 'approved'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : log.status === 'rejected'
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-amber-500/20 text-amber-400'
                    }`}
                  >
                    {log.status.toUpperCase()}
                  </span>
                </div>
                <p className="text-slate-200 leading-relaxed">{log.text}</p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (activeModule === 'attendance') {
    return (
      <div className="space-y-4 p-4 text-slate-100 max-w-lg mx-auto">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
          <button onClick={() => setActiveModule('home')} className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-white">Duty & Attendance History</h2>
            <p className="text-xs text-slate-400">Punch logs and attendance records</p>
          </div>
        </div>

        <div className="space-y-2.5">
          {punches.length === 0 ? (
            <p className="text-xs text-slate-500">No attendance punches recorded yet.</p>
          ) : (
            punches.map((p) => (
              <div key={p.id} className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-full font-bold text-white ${p.type === 'in' ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                    {p.type === 'in' ? 'IN' : 'OUT'}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">{p.type === 'in' ? 'Punch In (Duty Start)' : 'Punch Out (Duty End)'}</h4>
                    <p className="text-xs text-slate-400 font-mono mt-0.5">{new Date(p.at).toLocaleString()}</p>
                  </div>
                </div>
                <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-1 rounded-lg">
                  {p.dist}m dist
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (activeModule === 'profile') {
    return (
      <div className="space-y-4 p-4 text-slate-100 max-w-lg mx-auto">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
          <button onClick={() => setActiveModule('home')} className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:bg-slate-700">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-white">Staff Profile & Help</h2>
            <p className="text-xs text-slate-400">Account details and settings</p>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 shadow-2xl space-y-4">
          <div className="flex items-center gap-4 border-b border-slate-800 pb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/25 text-indigo-400 text-2xl font-black">
              {profile.name.charAt(0)}
            </div>
            <div>
              <h3 className="text-lg font-black text-white">{profile.name}</h3>
              <p className="text-xs text-indigo-400 capitalize font-semibold">{profile.role} • {profile.city}</p>
            </div>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Mobile Number</span>
              <span className="font-mono text-white">{profile.mobile}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/60">
              <span className="text-slate-400">Account Status</span>
              <span className="font-bold text-emerald-400 uppercase">{profile.status}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Total Stars Earned</span>
              <span className="font-black text-amber-400">★ {totalStars} Points</span>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600/20 border border-rose-500/30 py-3 text-xs font-bold text-rose-400 hover:bg-rose-600/30"
          >
            <LogOut className="h-4 w-4" />
            Logout from Shivam Staff
          </button>
        </div>
      </div>
    );
  }

  // Main Home Grid View (Clean remaining modules)
  return (
    <div className="space-y-5 p-4 text-slate-100 max-w-lg mx-auto">
      {/* Top Header & Duty Status Section */}
      <div className="rounded-3xl border border-slate-800 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-black text-white tracking-wide">{profile.name}</h1>
            <p className="text-xs text-indigo-400 capitalize font-semibold mt-0.5">{profile.role} • {profile.city}</p>
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            <span className="text-sm font-black text-amber-400">{totalStars}</span>
          </div>
        </div>

        {/* Duty Toggle Button */}
        <div className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <div>
            <span className="text-xs text-slate-400 block">Duty Status</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-block h-3 w-3 rounded-full ${isOnDuty ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-sm font-bold text-white">
                {isOnDuty ? 'ON DUTY' : 'OFF DUTY'}
              </span>
            </div>
          </div>
          <button
            onClick={toggleDuty}
            disabled={attendanceLoading}
            className={`rounded-xl px-5 py-2.5 text-xs font-black uppercase tracking-wider shadow-lg transition ${
              isOnDuty
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/25'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/25'
            }`}
          >
            {attendanceLoading ? 'Updating...' : isOnDuty ? 'Punch Out' : 'Punch In'}
          </button>
        </div>
      </div>

      {/* Main Action Grid (Remaining Module Cards) */}
      <div>
        <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 px-1">
          Staff App Modules
        </h2>

        <div className="grid grid-cols-2 gap-3.5">
          {/* New Sale / Order */}
          <button
            onClick={() => setActiveModule('sale')}
            className="flex flex-col items-start rounded-2xl border border-slate-800 bg-slate-900/90 p-4 text-left transition hover:border-indigo-500/50 hover:bg-slate-850 shadow-xl group"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-600/15 text-amber-400 group-hover:scale-110 transition">
              <ShoppingCart className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-bold text-white">New Sale / Order</h3>
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">
              Record customer sales & orders.
            </p>
          </button>

          {/* Daily Work Log */}
          <button
            onClick={() => setActiveModule('worklog')}
            className="flex flex-col items-start rounded-2xl border border-slate-800 bg-slate-900/90 p-4 text-left transition hover:border-indigo-500/50 hover:bg-slate-850 shadow-xl group"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-purple-600/15 text-purple-400 group-hover:scale-110 transition">
              <ClipboardList className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-bold text-white">Daily Work Log</h3>
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">
              Submit today's task summary for review.
            </p>
          </button>

          {/* Duty & Attendance History */}
          <button
            onClick={() => setActiveModule('attendance')}
            className="flex flex-col items-start rounded-2xl border border-slate-800 bg-slate-900/90 p-4 text-left transition hover:border-indigo-500/50 hover:bg-slate-850 shadow-xl group"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/15 text-blue-400 group-hover:scale-110 transition">
              <CalendarClock className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-bold text-white">Attendance Log</h3>
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">
              View punch times & history logs.
            </p>
          </button>

          {/* Profile & Help */}
          <button
            onClick={() => setActiveModule('profile')}
            className="flex flex-col items-start rounded-2xl border border-slate-800 bg-slate-900/90 p-4 text-left transition hover:border-indigo-500/50 hover:bg-slate-850 shadow-xl group"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-rose-600/15 text-rose-400 group-hover:scale-110 transition">
              <User className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-bold text-white">Profile & Help</h3>
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">
              Staff details & account settings.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
