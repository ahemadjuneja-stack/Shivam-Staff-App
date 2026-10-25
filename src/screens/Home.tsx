import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  doc,
  getDocs,
  setDoc,
  serverTimestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  UserProfile,
  PunchRecord,
  WorkLog,
  StarEvent,
  CreditDoc
} from '../types';
import HisabScreen from './Hisab';
import TasksScreen from './Tasks';
import DutyTimeSection from '../components/DutyTimeSection';
import { computeDutyMin, FALLBACK_TARGET_H } from '../lib/duty';
import { CREDIT_POINTS, totalOf, starsFor } from '../lib/credit';

interface HomeProps {
  profile: UserProfile;
  onLogout: () => void;
}

type SectionType = 'home' | 'attendance' | 'worklog' | 'sales' | 'profile' | 'tasks';

export default function Home({ profile, onLogout }: HomeProps) {
  const [activeSection, setActiveSection] = useState<SectionType>('home');
  // Slide direction: 'fwd' = section khula, 'back' = wapas home (hardware back gesture)
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd');

  // Section open (forward): history me push — taki phone ka back gesture smooth slide ke saath wapas le aaye
  const openSection = (s: SectionType) => {
    if (s === 'home' || s === activeSection) return;
    setNavDir('fwd');
    setActiveSection(s);
    window.history.pushState({ section: s }, '');
  };

  // Hardware back => popstate => slide-back animation ke saath home
  useEffect(() => {
    const onPop = () => {
      setNavDir('back');
      setActiveSection('home');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const slideCls = navDir === 'fwd' ? 'animate-slide-fwd' : 'animate-slide-back';

  // Duty / Attendance state
  const [isOnDuty, setIsOnDuty] = useState<boolean>(false);
  const [attendanceLoading, setAttendanceLoading] = useState<boolean>(false);

  // Stars state
  const [totalStars, setTotalStars] = useState<number>(0);
  const [, setStars] = useState<StarEvent[]>([]);

  // Work Logs state
  const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
  const [logText, setLogText] = useState('');
  const [submittingLog, setSubmittingLog] = useState(false);

  // Punches history state
  const [punches, setPunches] = useState<PunchRecord[]>([]);

  // Toast / notification notice for SOON modules
  const [notice, setNotice] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

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
      where('uid', '==', profile.uid)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StarEvent, 'id'>)
      })).sort((a, b) => b.at - a.at);
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
      where('uid', '==', profile.uid)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const logs = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<WorkLog, 'id'>)
      })).sort((a, b) => b.at - a.at);
      setWorkLogs(logs);
    });
    return () => unsub();
  }, [profile.uid]);

  // Real-time Punches listener
  useEffect(() => {
    const q = query(
      collection(db, 'punches'),
      where('uid', '==', profile.uid)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const records = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PunchRecord, 'id'>)
      })).sort((a, b) => b.at - a.at);
      setPunches(records);
    });
    return () => unsub();
  }, [profile.uid]);

  // ===================== CREDIT POINTS (Boss order 2026-10-25) =====================
  // Own credit doc — live (0-100 = clamp(taskScore + hoursScore))
  const [creditDoc, setCreditDoc] = useState<CreditDoc | null>(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'credit_points', profile.uid), (snap) => {
      setCreditDoc(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<CreditDoc, 'uid'>) }) : null);
    });
    return () => unsub();
  }, [profile.uid]);

  // Rank base: sab active staff (worker+sales) + unke credit docs (missing = 0)
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

  // hoursScore updater: staff ka apna app monthly duty on-track/peeche se set karta hai
  // (lib/duty ka wahi baseline calc — single source of truth)
  useEffect(() => {
    if (profile.role !== 'worker') return;
    const calc = computeDutyMin(punches, isOnDuty, FALLBACK_TARGET_H, profile.createdAt);
    const target = calc.monthDeltaMin >= 0 ? CREDIT_POINTS.HOURS_ONTRACK : CREDIT_POINTS.HOURS_BEHIND;
    if (creditDoc && (Number(creditDoc.hoursScore) || 0) === target) return;
    setDoc(doc(db, 'credit_points', profile.uid), { hoursScore: target, updatedAt: Date.now() }, { merge: true }).catch(() => {});
  }, [profile.role, profile.uid, profile.createdAt, punches, isOnDuty, creditDoc]);

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

      // Record punch
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
      alert('Work log submitted successfully for review.');
    } catch (err: any) {
      alert('Failed to submit work log: ' + err.message);
    } finally {
      setSubmittingLog(false);
    }
  };

  // Section title bar — koi back button nahi (phone ka back gesture use hota hai)
  const renderTopAppBar = (title: string) => (
    <div className="mb-5 flex items-center px-1">
      <span className="mr-2.5 h-5 w-1 rounded-full bg-[#F59300]" />
      <h2 className="text-lg font-extrabold text-white tracking-wide uppercase">{title}</h2>
    </div>
  );

  // Render Attendance Screen
  if (activeSection === 'attendance') {
    return (
      <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
        {renderTopAppBar('Attendance')}

        {/* Duty Punch Banner */}
        <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 mb-5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] flex items-center justify-between">
          <div>
            <span className="text-xs text-[#8A93A6] font-medium block">Current Duty Status</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`h-3 w-3 rounded-full ${isOnDuty ? 'bg-[#10B981] animate-pulse' : 'bg-[#64748B]'}`} />
              <span className="text-sm font-bold text-white">
                {isOnDuty ? 'ON DUTY' : 'OFF DUTY'}
              </span>
            </div>
          </div>
          <button
            onClick={toggleDuty}
            disabled={attendanceLoading}
            className={`rounded-xl px-5 py-2.5 text-xs font-black uppercase tracking-wider shadow-lg transition active:scale-95 ${
              isOnDuty
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-[#10B981] hover:bg-emerald-400 text-slate-950 font-extrabold'
            }`}
          >
            {attendanceLoading ? 'Updating...' : isOnDuty ? 'Punch Out' : 'Punch In'}
          </button>
        </div>

        {/* Punch History */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-[#5B677D] uppercase tracking-[2.4px] px-1">Punch History</h3>
          {punches.length === 0 ? (
            <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-6 text-center text-xs text-[#8A93A6]">
              No attendance punches recorded yet.
            </div>
          ) : (
            punches.map((p) => (
              <div key={p.id} className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-4 flex items-center justify-between shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-full font-bold text-xs ${p.type === 'in' ? 'bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/40' : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'}`}>
                    {p.type === 'in' ? 'IN' : 'OUT'}
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">{p.type === 'in' ? 'Punch In (Start)' : 'Punch Out (End)'}</h4>
                    <p className="text-[11px] text-[#8A93A6] font-mono mt-0.5">{new Date(p.at).toLocaleString()}</p>
                  </div>
                </div>
                <span className="text-[10px] font-mono text-[#8A93A6] bg-[#121F36] px-2.5 py-1 rounded-lg border border-[#1D2B47]">
                  {p.dist || 0}m dist
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // Render Tasks Screen (Boss order 2026-10-25)
  if (activeSection === 'tasks') {
    return <TasksScreen profile={profile} slideCls={slideCls} />;
  }

  // Render Work Log Screen
  if (activeSection === 'worklog') {
    return (
      <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
        {renderTopAppBar('Work Log')}

        <form onSubmit={handleWorkLogSubmit} className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] space-y-4 mb-6">
          <div>
            <label className="text-xs font-semibold text-[#8A93A6]">Today's Task Summary</label>
            <textarea
              rows={3}
              required
              value={logText}
              onChange={(e) => setLogText(e.target.value)}
              placeholder="e.g., Dispatched pending customer orders, verified inventory stock..."
              className="mt-1.5 w-full rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 text-xs text-white placeholder-slate-500 focus:border-[#F59300] focus:outline-none"
              disabled={submittingLog}
            />
          </div>
          <button
            type="submit"
            disabled={submittingLog || !logText.trim()}
            className="w-full rounded-xl bg-[#A855F7] py-3 text-xs font-bold text-white shadow-lg hover:bg-purple-500 disabled:opacity-50 transition active:scale-95"
          >
            {submittingLog ? 'Submitting...' : 'Submit Work Log'}
          </button>
        </form>

        <div className="space-y-3">
          <h3 className="text-xs font-bold text-[#5B677D] uppercase tracking-[2.4px] px-1">Recent Submitted Logs</h3>
          {workLogs.length === 0 ? (
            <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-6 text-center text-xs text-[#8A93A6]">
              No work logs submitted yet.
            </div>
          ) : (
            workLogs.map((log) => (
              <div key={log.id} className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-4 text-xs space-y-2 shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[#8A93A6] text-[11px]">{log.date}</span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                      log.status === 'approved'
                        ? 'bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/30'
                        : log.status === 'rejected'
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
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

  // Render Sales Screen
  if (activeSection === 'sales') {
    return (
      <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
        {renderTopAppBar('Sales & Ledger')}
        <HisabScreen profile={profile} />
      </div>
    );
  }

  // Render Profile Screen
  if (activeSection === 'profile') {
    return (
      <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
        {renderTopAppBar('Profile')}

        <div className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-6 shadow-[0_8px_24px_rgba(0,0,0,0.4)] space-y-5">
          <div className="flex items-center gap-4 border-b border-[#1D2B47] pb-4">
            <div className="h-14 w-14 rounded-full bg-[#0C1628] ring-2 ring-[#F59300] flex items-center justify-center font-black text-2xl text-[#FBBF24]">
              {profile.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">{profile.name}</h3>
              <p className="text-xs text-[#38BDF8] uppercase tracking-wider font-semibold">{profile.role} • {profile.city || 'Main'}</p>
            </div>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-[#1D2B47]/60">
              <span className="text-[#8A93A6]">Mobile Number</span>
              <span className="font-mono text-white font-medium">{profile.mobile}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#1D2B47]/60">
              <span className="text-[#8A93A6]">Account Status</span>
              <span className="font-bold text-[#34D399] uppercase">{profile.status}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#1D2B47]/60">
              <span className="text-[#8A93A6]">Total Stars Earned</span>
              <span className="font-extrabold text-[#FBBF24]">★ {totalStars} Points</span>
            </div>
            {profile.role !== 'manager' && (
              <>
                <div className="flex justify-between py-1 border-b border-[#1D2B47]/60">
                  <span className="text-[#8A93A6]">Credit Points (Live)</span>
                  <span className={`font-extrabold ${creditInfo.total >= 50 ? 'text-[#34D399]' : creditInfo.total >= 20 ? 'text-amber-300' : 'text-rose-400'}`}>
                    {creditInfo.total} / 100
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-[#1D2B47]/60">
                  <span className="text-[#8A93A6]">Performance Stars</span>
                  <span className="font-extrabold text-[#FBBF24] tracking-wider">
                    {'★'.repeat(creditInfo.stars)}{'☆'.repeat(5 - creditInfo.stars)}
                    <span className="text-[10px] text-[#8A93A6] font-semibold ml-1.5">#{creditInfo.rank} of {creditInfo.of}</span>
                  </span>
                </div>
              </>
            )}
          </div>

          <button
            onClick={onLogout}
            className="mt-4 w-full rounded-xl bg-rose-600/20 border border-rose-500/30 py-3 text-xs font-bold text-rose-400 hover:bg-rose-600/30 transition active:scale-95"
          >
            Logout from Shivam Staff
          </button>
        </div>
      </div>
    );
  }

  // MAIN HOME SCREEN VIEW (Matches Mockup Spec Exactly)
  return (
    <div className={`min-h-screen text-slate-100 p-4 pb-14 ${slideCls}`}>
      {/* Toast Notice */}
      {notice && (
        <div className="fixed left-1/2 z-50 -translate-x-1/2 bg-[#1D2B47] border border-[#F59300]/40 text-white text-xs px-4 py-2.5 rounded-full shadow-2xl animate-fade-in" style={{ top: 'calc(var(--sat) + 58px)' }}>
          {notice}
        </div>
      )}

      {/* DUTY TIME SECTION — Boss demo (TIME section): sirf worker role ko, sales ko nahi */}
      {profile.role === 'worker' && (
        <DutyTimeSection profile={profile} punches={punches} isOnDuty={isOnDuty} />
      )}

      {/* Menu Section Label */}
      <div className="text-[12px] font-bold uppercase tracking-[2.4px] text-[#5B677D] mb-3 px-1">
        MENU
      </div>

      {/* 2-Column Icon Grid */}
      <div className="grid grid-cols-2 gap-[14px]">
        {/* 1. Attendance */}
        <button
          onClick={() => openSection('attendance')}
          className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:border-[#2A3F68] transition group active:scale-[0.98]"
        >
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#F59300]/13 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
            <svg className="w-[34px] h-[34px] text-[#F59300]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Attendance</span>
        </button>

        {/* 2. Work Log */}
        <button
          onClick={() => openSection('worklog')}
          className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:border-[#2A3F68] transition group active:scale-[0.98]"
        >
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#A855F7]/13 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
            <svg className="w-[34px] h-[34px] text-[#A855F7]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <path d="M9 12h6" />
              <path d="M9 16h6" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Work Log</span>
        </button>

        {/* 3. Sales */}
        <button
          onClick={() => openSection('sales')}
          className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:border-[#2A3F68] transition group active:scale-[0.98]"
        >
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#F0B429]/13 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
            <svg className="w-[34px] h-[34px] text-[#F0B429]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
              <path d="M3 20h18" />
              <polyline points="15 6 19 2 19 6" />
              <line x1="11" y1="10" x2="19" y2="2" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Sales</span>
        </button>

        {/* 4. Profile */}
        <button
          onClick={() => openSection('profile')}
          className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:border-[#2A3F68] transition group active:scale-[0.98]"
        >
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#38BDF8]/13 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
            <svg className="w-[34px] h-[34px] text-[#38BDF8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Profile</span>
        </button>

        {/* 5. Tasks (Boss order 2026-10-25 — manager assign/verify, staff view) */}
        <button
          onClick={() => openSection('tasks')}
          className="bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:border-[#2A3F68] transition group active:scale-[0.98]"
        >
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#34D399]/13 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
            <svg className="w-[34px] h-[34px] text-[#34D399]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <path d="m9 14 2 2 4-4" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Tasks</span>
        </button>

        {/* 6. Hisab XL (SOON) */}
        <button
          onClick={() => showToast('Hisab XL module is coming soon!')}
          className="relative bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] opacity-80 hover:opacity-100 transition active:scale-[0.98]"
        >
          <span className="absolute top-3 right-3 bg-[#1D2B47] border border-[#2A3F68] text-[#7C8AA5] text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
            SOON
          </span>
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#7C8AA5]/13 flex items-center justify-center mb-3">
            <svg className="w-[34px] h-[34px] text-[#7C8AA5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <line x1="8" y1="6" x2="16" y2="6" />
              <line x1="16" y1="14" x2="16" y2="18" />
              <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Hisab XL</span>
        </button>

        {/* 7. Polls (SOON) */}
        <button
          onClick={() => showToast('Polls module is coming soon!')}
          className="relative bg-[#0C1628] border border-[#1D2B47] rounded-[22px] p-5 flex flex-col items-center justify-center text-center shadow-[0_8px_24px_rgba(0,0,0,0.3)] opacity-80 hover:opacity-100 transition active:scale-[0.98]"
        >
          <span className="absolute top-3 right-3 bg-[#1D2B47] border border-[#2A3F68] text-[#7C8AA5] text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
            SOON
          </span>
          <div className="h-[62px] w-[62px] rounded-[19px] bg-[#7C8AA5]/13 flex items-center justify-center mb-3">
            <svg className="w-[34px] h-[34px] text-[#7C8AA5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <span className="text-white text-[15px] font-semibold">Polls</span>
        </button>
      </div>
    </div>
  );
}
