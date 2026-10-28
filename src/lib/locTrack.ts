// ============================================================
// LOCATION TRACK + SESSIONS (Boss order 2026-10-26 — SALES duty system):
// "Salesmen ko on off duty ka button bhi nahi hona chahiye, unka duty
//  location par hi chalega. Location se har information dashboard me
//  aani chahiye — usne last kaha location on kiya kaha off kiya,
//  location on hote huwe wo kaha kaha ghuma poora road map chahiye,
//  staff inventory me unki sari information aani chahiye, mobile model,
//  jab jab wo location aur net dono on kare uski sari information bhejni hai."
//
// DATA MODEL (dashboard Staff Detail panel isi ko padhta hai):
//   loc_sessions/{ls-{uid}-{startedAt}}:
//     { uid, name, startedAt, status:'open'|'closed', endedAt?, closedReason?,
//       startLat, startLng, endLat?, endLng?,
//       points: [{lat,lng,at,acc?}...]  <- road map (har 3 min fresh fix)
//       versionCode, deviceModel, osVersion, appVersionCode }
//   loc_events/{le-{uid}-{at}}:
//     { uid, name, type:'on'|'off', lat?, lng?, at, versionCode, deviceModel }
//     <- location ON kahan/kiya + OFF kahan/kiya history
//
// RULES:
//   - SALES ONLY (worker ka apna geofence/outside system hai, manager bypass)
//   - Session = location ON period: gate pass par OPEN, location off /
//     permission revoke par CLOSE (wahi moment jab app lock hoti hai)
//   - App kill: session 'open' reh jata hai — agla gate pass STALE close
//     karke fresh session kholta hai (koi zombie session nahi)
//   - Points sirf FRESH fix (fetchLocation maximumAge:0 — koi cache nahi)
//   - Net off: Firestore persistent cache writes queue karta hai — net on
//     hote hi khud sync (reportDeviceAndLocation + ye dono milke "sari info")
//   - GPS ko net nahi chahiye — slow net par bhi tracking chalti hai
// ============================================================
import { collection, doc, getDocs, limit as fsLimit, orderBy, query, setDoc, updateDoc, where, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';
import { fetchLocation, parseDeviceInfo, fetchAppVersionInfo } from './reporting';
import { diagLog } from './diag';

export interface TrackFix {
  lat: number;
  lng: number;
  accuracy?: number;
}

const MAX_POINTS = 600; // session doc 1MB cap se dur — 8h*20/h = ~160 normal

interface DeviceInfoLite {
  deviceModel: string;
  osVersion: string;
  appVersionCode: number;
}

async function deviceInfo(): Promise<DeviceInfoLite> {
  const d = parseDeviceInfo();
  const v = await fetchAppVersionInfo();
  return { deviceModel: d.deviceModel, osVersion: d.osVersion, appVersionCode: v.appVersionCode };
}

// ---------- LOCATION EVENT (on/off history — kahan kiya, kab kiya) ----------
async function writeLocEvent(uid: string, name: string, type: 'on' | 'off', fix: TrackFix | null, dev: DeviceInfoLite) {
  const at = Date.now();
  const payload: Record<string, unknown> = {
    uid,
    name,
    type,
    at,
    versionCode: dev.appVersionCode,
    deviceModel: dev.deviceModel
  };
  if (fix) {
    payload.lat = fix.lat;
    payload.lng = fix.lng;
    if (typeof fix.accuracy === 'number') payload.accuracy = fix.accuracy;
  }
  await setDoc(doc(db, 'loc_events', `le-${uid}-${at}`), payload);
}

// ---------- OPEN (location ON — gate pass moment) ----------
// Purana open session mila to: aaj ka / recent (12h) = RESUME (points continue),
// warna STALE close (app kill tha) + fresh open. Return: session doc id.
export async function openLocationSession(uid: string, name: string, fix: TrackFix | null): Promise<string | null> {
  if (!uid) return null;
  try {
    const dev = await deviceInfo();
    const openQ = query(
      collection(db, 'loc_sessions'),
      where('uid', '==', uid),
      where('status', '==', 'open'),
      orderBy('startedAt', 'desc'),
      fsLimit(1)
    );
    const snap = await getDocs(openQ);
    let staleDocId: string | null = null;
    let staleLastAt = 0;
    snap.forEach((d) => {
      const data = d.data() as { startedAt?: number; points?: { at: number }[] };
      const pts = Array.isArray(data.points) ? data.points : [];
      const lastAt = pts.length ? pts[pts.length - 1].at : Number(data.startedAt || 0);
      if (Date.now() - lastAt < 12 * 60 * 60 * 1000) {
        staleDocId = null; // recent — RESUME eligible
        staleLastAt = -1; // marker: resume
      } else {
        staleDocId = d.id;
        staleLastAt = lastAt;
      }
    });
    if (staleLastAt === -1) {
      // RESUME — wahi session continue hoga (app restart / re-gate pass)
      diagLog('track_resume');
      return snap.docs[0].id;
    }
    if (staleDocId) {
      // app kill hua tha — purana session close karo (end = last known point)
      await updateDoc(doc(db, 'loc_sessions', staleDocId), {
        status: 'closed',
        endedAt: staleLastAt || Date.now(),
        closedReason: 'stale'
      }).catch(() => {});
    }
    const startedAt = Date.now();
    const first: Record<string, unknown> = { at: startedAt };
    if (fix) {
      first.lat = fix.lat;
      first.lng = fix.lng;
      if (typeof fix.accuracy === 'number') first.acc = fix.accuracy;
    }
    const payload: Record<string, unknown> = {
      uid,
      name,
      startedAt,
      status: 'open',
      points: [first],
      ...dev
    };
    if (fix) {
      payload.startLat = fix.lat;
      payload.startLng = fix.lng;
    }
    const id = `ls-${uid}-${startedAt}`;
    await setDoc(doc(db, 'loc_sessions', id), payload);
    await writeLocEvent(uid, name, 'on', fix, dev);
    diagLog('track_open');
    return id;
  } catch {
    diagLog('track_open_err');
    return null;
  }
}

// ---------- TRACK POINT (road map sample — har 3 min, FRESH fix only) ----------
// Current open session doc me arrayUnion — offline me cache queue, net on
// hote hi Firebase tak. Same call 'location + net dono on' info push bhi hai.
export async function appendTrackPoint(uid: string): Promise<void> {
  if (!uid) return;
  try {
    const loc = await fetchLocation(); // maximumAge:0 — koi cached point nahi
    if (!loc) return; // is sample me fix nahi mila — next sample try karega
    const openQ = query(
      collection(db, 'loc_sessions'),
      where('uid', '==', uid),
      where('status', '==', 'open'),
      orderBy('startedAt', 'desc'),
      fsLimit(1)
    );
    const snap = await getDocs(openQ);
    if (snap.empty) return; // session open nahi — kuch nahi karna
    const sref = snap.docs[0].ref;
    const sdata = snap.docs[0].data() as { points?: unknown[] };
    if (Array.isArray(sdata.points) && sdata.points.length >= MAX_POINTS) return;
    const pt: Record<string, unknown> = { lat: loc.lat, lng: loc.lng, at: loc.at };
    if (typeof loc.accuracy === 'number') pt.acc = loc.accuracy;
    await updateDoc(sref, { points: arrayUnion(pt) });
  } catch {
    // offline / slow net — Firestore cache queue sambhalta hai
  }
}

// ---------- CLOSE (location OFF — lock moment: gps-off-live / permission) ----------
export async function closeLocationSession(uid: string, name: string, reason: 'loc_off' | 'permission' | 'stale'): Promise<void> {
  if (!uid) return;
  try {
    const dev = await deviceInfo();
    const openQ = query(
      collection(db, 'loc_sessions'),
      where('uid', '==', uid),
      where('status', '==', 'open'),
      orderBy('startedAt', 'desc'),
      fsLimit(1)
    );
    const snap = await getDocs(openQ);
    if (snap.empty) {
      // session open nahi tha (app kabhi pass nahi hua ya pehle hi close) —
      // OFF event phir bhi log karo (Boss: kaha OFF kiya — hamesha record)
      await writeLocEvent(uid, name, 'off', null, dev);
      return;
    }
    const sref = snap.docs[0].ref;
    const sdata = snap.docs[0].data() as { points?: { lat: number; lng: number; at: number }[] };
    const pts = Array.isArray(sdata.points) ? sdata.points : [];
    const lastPt = pts.length ? pts[pts.length - 1] : null;
    const endedAt = Date.now();
    await updateDoc(sref, {
      status: 'closed',
      endedAt,
      closedReason: reason,
      ...(lastPt ? { endLat: lastPt.lat, endLng: lastPt.lng } : {})
    });
    await writeLocEvent(
      uid,
      name,
      'off',
      lastPt ? { lat: lastPt.lat, lng: lastPt.lng } : null,
      dev
    );
    diagLog('track_close', { reason });
  } catch {
    diagLog('track_close_err');
  }
}

