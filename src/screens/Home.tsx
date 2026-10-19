import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  doc, 
  getDoc,
  limit 
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { 
  UserProfile, 
  ShopConfig, 
  PunchRecord, 
  WorkLog, 
  StarEvent, 
  ViolationRecord 
} from '../types';

interface HomeProps {
  profile: UserProfile;
}

// Haversine formula to compute distance in meters between 2 coordinates
function getDistanceFromLatLonInMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export default function Home({ profile }: HomeProps) {
  const isDemo = profile.uid.startsWith('demo_') || !auth.currentUser;

  // Shop Config
  const [shop, setShop] = useState<ShopConfig>({
    name: 'Shivam Main Shop',
    lat: 22.3039,
    lng: 70.8022,
    radius: 100,
    shiftStart: '09:00',
  });

  // GPS State
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [locating, setLocating] = useState<boolean>(false);

  // Duty & Punches
  const [punches, setPunches] = useState<PunchRecord[]>(() => {
    if (isDemo) {
      try {
        const stored = localStorage.getItem(`shivam_punches_${profile.uid}`);
        if (stored) return JSON.parse(stored);
      } catch (e) {}
      return [
        {
          id: 'demo_punch_1',
          uid: profile.uid,
          name: profile.name,
          type: 'in',
          at: Date.now() - 3600000 * 3, // 3 hours ago
          lat: 22.3039,
          lng: 70.8022,
          dist: 12,
        },
      ];
    }
    return [];
  });
  const [punching, setPunching] = useState<boolean>(false);

  // Work Logs
  const [workLogs, setWorkLogs] = useState<WorkLog[]>(() => {
    if (isDemo) {
      try {
        const stored = localStorage.getItem(`shivam_worklogs_${profile.uid}`);
        if (stored) return JSON.parse(stored);
      } catch (e) {}
      const todayStr = new Date().toISOString().split('T')[0];
      return [
        {
          id: 'demo_wl_1',
          uid: profile.uid,
          name: profile.name,
          date: todayStr,
          text: 'Dispatched 22 carton rolls to Saurashtra transport. Checked godown stock.',
          status: 'pending',
          at: Date.now() - 3600000 * 2,
        },
        {
          id: 'demo_wl_0',
          uid: profile.uid,
          name: profile.name,
          date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
          text: 'Loaded tempo MH-04-1234. Customer receipt collection verified.',
          status: 'approved',
          at: Date.now() - 86400000,
          verifiedAt: Date.now() - 72000000,
        },
      ];
    }
    return [];
  });
  const [logText, setLogText] = useState('');
  const [submittingLog, setSubmittingLog] = useState(false);

  // Stars
  const [stars, setStars] = useState<StarEvent[]>(() => {
    if (isDemo) {
      try {
        const stored = localStorage.getItem(`shivam_stars_${profile.uid}`);
        if (stored) return JSON.parse(stored);
      } catch (e) {}
      return [
        { id: 'st_1', uid: profile.uid, type: 'full-week', delta: 5, note: 'Punctual attendance full week', at: Date.now() - 86400000 * 2 },
        { id: 'st_2', uid: profile.uid, type: 'verify', delta: 1, note: 'Daily work log approved by owner', at: Date.now() - 86400000 },
      ];
    }
    return [];
  });
  const [totalStars, setTotalStars] = useState<number>(() => {
    if (isDemo) return 6;
    return 0;
  });

  // Load shop config (remote if real, else default)
  useEffect(() => {
    if (isDemo) return;
    async function fetchShop() {
      try {
        const snap = await getDoc(doc(db, 'config', 'shop'));
        if (snap.exists()) {
          setShop(snap.data() as ShopConfig);
        }
      } catch (err) {
        console.warn('Using default shop config:', err);
      }
    }
    fetchShop();
  }, [isDemo]);

  // Continuous Geolocation Tracking & Location-off detection
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsError('Geolocation is not supported by your browser/device.');
      return;
    }

    setLocating(true);
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsError(null);
        setLocating(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setUserLoc({ lat, lng, accuracy: pos.coords.accuracy });

        const dist = getDistanceFromLatLonInMeters(lat, lng, shop.lat, shop.lng);
        setDistance(dist);
      },
      async (err) => {
        console.warn('GPS Error:', err.message);
        setLocating(false);
        setGpsError('GPS permission denied or unavailable. Kripya Location turn ON karein.');

        // If punched in and location is turned off or denied, log a violation record (if not demo)
        if (!isDemo) {
          const lastPunch = punches[0];
          if (lastPunch && lastPunch.type === 'in') {
            try {
              const violation: ViolationRecord = {
                uid: profile.uid,
                at: Date.now(),
                kind: 'location-off',
                reason: `Location turned off or denied during active duty: ${err.message}`,
              };
              await addDoc(collection(db, 'violations'), violation);
            } catch (e) {
              console.warn('Failed to log violation to Firestore:', e);
            }
          }
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [shop, punches, profile.uid, isDemo]);

  // Real-time Punches listener (only if authenticated)
  useEffect(() => {
    if (isDemo) return;
    const q = query(
      collection(db, 'punches'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(10)
    );
    const unsub = onSnapshot(
      q, 
      (snapshot) => {
        const records = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<PunchRecord, 'id'>),
        }));
        setPunches(records);
      },
      (err) => {
        console.warn('Punches Firestore listener warning:', err.message);
      }
    );
    return () => unsub();
  }, [profile.uid, isDemo]);

  // Real-time Work Logs listener (only if authenticated)
  useEffect(() => {
    if (isDemo) return;
    const q = query(
      collection(db, 'worklogs'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(15)
    );
    const unsub = onSnapshot(
      q, 
      (snapshot) => {
        const logs = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<WorkLog, 'id'>),
        }));
        setWorkLogs(logs);
      },
      (err) => {
        console.warn('Worklogs Firestore listener warning:', err.message);
      }
    );
    return () => unsub();
  }, [profile.uid, isDemo]);

  // Real-time Stars listener (only if authenticated)
  useEffect(() => {
    if (isDemo) {
      const total = stars.reduce((sum, item) => sum + (item.delta || 0), 0);
      setTotalStars(total);
      return;
    }
    const q = query(
      collection(db, 'stars'),
      where('uid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(
      q, 
      (snapshot) => {
        const starRecords = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<StarEvent, 'id'>),
        }));
        setStars(starRecords);
        const total = starRecords.reduce((sum, item) => sum + (item.delta || 0), 0);
        setTotalStars(total);
      },
      (err) => {
        console.warn('Stars Firestore listener warning:', err.message);
      }
    );
    return () => unsub();
  }, [profile.uid, isDemo, stars]);

  // Refresh Location manually
  const refreshLocation = () => {
    if (!('geolocation' in navigator)) return;
    setLocating(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setUserLoc({ lat, lng, accuracy: pos.coords.accuracy });
        const dist = getDistanceFromLatLonInMeters(lat, lng, shop.lat, shop.lng);
        setDistance(dist);
      },
      (err) => {
        setLocating(false);
        setGpsError('Location update nahi ho paayi: ' + err.message);
      },
      { enableHighAccuracy: true }
    );
  };

  const lastPunch = punches[0];
  const isPunchedIn = lastPunch && lastPunch.type === 'in';
  // Allow punch action when inside radius or in demo mode with test toggle
  const isWithinRadius = distance !== null && distance <= shop.radius;

  // Punch Action
  const handlePunch = async () => {
    // If real GPS is outside radius and not forced in demo
    if (!userLoc && !isDemo) {
      alert('Kripya GPS location capture hone dein.');
      return;
    }

    const currentDist = distance !== null ? distance : 25;
    if (!isWithinRadius && !isDemo) {
      alert(`Aap shop se ${currentDist}m door hain. Geofence radius ${shop.radius}m ke andar hona zaroori hai.`);
      return;
    }

    const nextType: 'in' | 'out' = isPunchedIn ? 'out' : 'in';
    const confirmMsg = nextType === 'in' 
      ? `Punch IN karein? Location: ${shop.name}` 
      : `Duty complete karke Punch OUT karein?`;
    
    if (!window.confirm(confirmMsg)) return;

    try {
      setPunching(true);
      const newPunch: PunchRecord = {
        id: `punch_${Date.now()}`,
        uid: profile.uid,
        name: profile.name,
        type: nextType,
        at: Date.now(),
        lat: userLoc ? userLoc.lat : shop.lat,
        lng: userLoc ? userLoc.lng : shop.lng,
        dist: currentDist,
      };

      if (isDemo) {
        const updated = [newPunch, ...punches];
        setPunches(updated);
        try {
          localStorage.setItem(`shivam_punches_${profile.uid}`, JSON.stringify(updated));
        } catch (e) {}
      } else {
        await addDoc(collection(db, 'punches'), newPunch);
      }
    } catch (err: any) {
      console.error('Punch error:', err);
      alert('Punch record save karne me samasya: ' + err.message);
    } finally {
      setPunching(false);
    }
  };

  // Submit Daily Work Log
  const handleSubmitWorkLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!logText.trim()) return;

    try {
      setSubmittingLog(true);
      const todayStr = new Date().toISOString().split('T')[0];
      const newLog: WorkLog = {
        id: `wl_${Date.now()}`,
        uid: profile.uid,
        name: profile.name,
        date: todayStr,
        text: logText.trim(),
        status: 'pending',
        at: Date.now(),
      };

      if (isDemo) {
        const updated = [newLog, ...workLogs];
        setWorkLogs(updated);
        try {
          localStorage.setItem(`shivam_worklogs_${profile.uid}`, JSON.stringify(updated));
        } catch (e) {}
      } else {
        await addDoc(collection(db, 'worklogs'), newLog);
      }
      setLogText('');
    } catch (err: any) {
      console.error('Work log error:', err);
      alert('Log submit karne me samasya: ' + err.message);
    } finally {
      setSubmittingLog(false);
    }
  };

  // Demo Geofence Simulator button
  const setDemoLocationNearShop = () => {
    setUserLoc({ lat: shop.lat, lng: shop.lng, accuracy: 5 });
    setDistance(15);
    setGpsError(null);
  };

  return (
    <div className="space-y-4 p-4 text-slate-100 max-w-lg mx-auto">
      {isDemo && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-2.5 text-xs text-indigo-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold">⚡ Demo Active:</span>
            <span>Local duty simulation mode</span>
          </div>
          <button
            onClick={setDemoLocationNearShop}
            className="rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-indigo-500"
          >
            Simulate Shop GPS
          </button>
        </div>
      )}

      {/* Stars & Profile Banner */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 p-4 shadow-lg">
        <div>
          <span className="text-xs uppercase tracking-wider text-slate-400">Total Stars</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-3xl font-black text-amber-400">★ {totalStars}</span>
            <span className="text-xs text-slate-400">Score</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-400">{profile.city}</div>
          <div className="text-xs font-bold text-indigo-400 mt-1 px-2.5 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 inline-block">
            Shift: {shop.shiftStart}
          </div>
        </div>
      </div>

      {/* Geofence & Punch In/Out Card */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-1.5">
              <span>📍</span> Geofenced Attendance
            </h2>
            <p className="text-xs text-slate-400">{shop.name} (Max {shop.radius}m)</p>
          </div>
          <button
            onClick={refreshLocation}
            disabled={locating}
            className="rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-700"
          >
            {locating ? 'Locating...' : 'Refresh GPS'}
          </button>
        </div>

        {/* GPS Status Indicator */}
        <div className="mt-4 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3.5">
          {gpsError && !isDemo ? (
            <div className="text-xs text-red-400 flex items-start gap-2">
              <span className="text-base">⚠️</span>
              <div>
                <p className="font-semibold">{gpsError}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Attendance ke liye GPS permission zaroori hai.</p>
              </div>
            </div>
          ) : userLoc && distance !== null ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-3 w-3 rounded-full ${isWithinRadius ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                  <span className="text-xs font-bold text-white">
                    {isWithinRadius ? 'Shop Geofence Ke Andar' : 'Shop Se Bahar'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Doori: <strong className={isWithinRadius ? 'text-emerald-400' : 'text-red-400'}>{distance} meters</strong>
                  <span className="text-[10px] text-slate-500 ml-1.5">(Accuracy ±{Math.round(userLoc.accuracy)}m)</span>
                </p>
              </div>
              <div className="text-right">
                <span className={`text-xs font-black px-2 py-1 rounded-md ${isWithinRadius ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                  {isWithinRadius ? 'READY' : 'OUT OF RANGE'}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"></div>
                GPS location check ki jaa rahi hai...
              </div>
              {isDemo && (
                <button
                  onClick={setDemoLocationNearShop}
                  className="text-xs font-bold text-indigo-400 underline"
                >
                  Set Inside Range
                </button>
              )}
            </div>
          )}
        </div>

        {/* Current Punch State & Action Button */}
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between text-xs">
            <span className="text-slate-400">Current Status:</span>
            <span className={`font-bold px-2 py-0.5 rounded-full ${isPunchedIn ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
              {isPunchedIn ? '🟢 ON DUTY' : '⚪ OFF DUTY'}
            </span>
          </div>

          <button
            onClick={handlePunch}
            disabled={punching || (!isWithinRadius && !isDemo)}
            className={`w-full rounded-xl py-3.5 text-sm font-black tracking-wide shadow-lg transition disabled:opacity-50 ${
              isPunchedIn
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/25'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/25'
            }`}
          >
            {punching
              ? 'Saving Punch...'
              : isPunchedIn
              ? 'PUNCH OUT (Duty End)'
              : 'PUNCH IN (Duty Start)'}
          </button>

          {!isWithinRadius && distance !== null && !isDemo && (
            <p className="mt-2 text-center text-[11px] text-amber-400">
              Shop ke {shop.radius}m daayre mein aane par hi Punch button enable hoga.
            </p>
          )}
        </div>
      </div>

      {/* Daily Work Log Section */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl">
        <h2 className="text-sm font-bold text-white mb-2 flex items-center gap-1.5">
          <span>📝</span> Daily Work Log
        </h2>
        <p className="text-xs text-slate-400 mb-3">
          Aaj ka kaam aur summary yahan likhein (Owner verification ke baad Star milega).
        </p>

        <form onSubmit={handleSubmitWorkLog} className="space-y-3">
          <textarea
            rows={2}
            value={logText}
            onChange={(e) => setLogText(e.target.value)}
            placeholder="Aaj kitna kaam kiya, kaunse orders dispatch huye, remarks..."
            className="w-full rounded-xl border border-slate-700 bg-slate-800/80 p-3 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500"
            disabled={submittingLog}
          />
          <button
            type="submit"
            disabled={submittingLog || !logText.trim()}
            className="w-full rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white shadow hover:bg-indigo-500 disabled:opacity-50"
          >
            {submittingLog ? 'Submitting...' : 'Submit Work Log'}
          </button>
        </form>

        {/* Recent Work Logs List */}
        {workLogs.length > 0 && (
          <div className="mt-4 space-y-2 border-t border-slate-800 pt-3">
            <span className="text-[11px] font-semibold text-slate-400">Recent Logs</span>
            {workLogs.slice(0, 3).map((log) => (
              <div key={log.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-slate-400 font-mono text-[10px]">{log.date}</span>
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
                <p className="text-slate-200 leading-relaxed text-xs">{log.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Star History & Punches History */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Star History */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl">
          <h3 className="text-xs font-bold text-amber-400 mb-2 flex items-center gap-1.5">
            <span>⭐</span> Star Timeline
          </h3>
          {stars.length === 0 ? (
            <p className="text-[11px] text-slate-500">Abhi koi star events nahi hain.</p>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {stars.map((st) => (
                <div key={st.id} className="flex items-center justify-between rounded-lg bg-slate-950/60 p-2 text-xs">
                  <div>
                    <span className="font-semibold text-slate-300">{st.note || st.type}</span>
                    <span className="block text-[10px] text-slate-500 font-mono">
                      {new Date(st.at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className={`font-black ${st.delta >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                    {st.delta >= 0 ? `+${st.delta}` : st.delta} ★
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Punch History */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl">
          <h3 className="text-xs font-bold text-slate-300 mb-2 flex items-center gap-1.5">
            <span>⏱️</span> Recent Punches
          </h3>
          {punches.length === 0 ? (
            <p className="text-[11px] text-slate-500">Abhi koi punches record nahi hain.</p>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {punches.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg bg-slate-950/60 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${p.type === 'in' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                    <span className="font-semibold text-slate-200">
                      {p.type === 'in' ? 'Punch In' : 'Punch Out'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[11px] text-slate-300 font-mono">
                      {new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="block text-[10px] text-slate-500">{p.dist}m away</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
