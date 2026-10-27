import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from '../types';
import {
  TourShopEntry, TourDeposit, TourHisabDoc, totalsOf, saveShopEntry,
  addDeposit, parseMoneyInput, fmtMoney, modeLabel, MODES
} from '../lib/tourHisab';
import { useSwipeBack, SWIPE_OVERLAY_STYLE } from '../lib/swipeBack';
import {
  Truck, MapPin, Store, ChevronDown, ChevronRight, Wallet, Landmark,
  CheckCircle2, Loader2, HandCoins
} from 'lucide-react';

// ============================================================
// TOUR HISAB SCREEN (Task 93, Boss order 2026-10-28 — SALES):
// Line Schedule ke niche tour box tap -> YE screen khulti hai.
// Cities -> shops -> salesman hisab bharta hai (GR, Less, kitna
// paisa diya + moad + note) aur JAMA add karta hai (kitna + KAHA
// jama kiya). Dashboard par sab LIVE dikhta hai (same collection).
// BOSS RULE: koi back button nahi — left-edge slide se band.
// ============================================================

interface RTBill { date: string; days: number; amtP: number; balP: number; recvP: number; lessP: number; mode: number }
interface RTShop { key: string; code: string; name: string; billsP: number; recvP: number; balP: number; bills: RTBill[] }
interface RTCity { name: string; date?: string; shops: RTShop[] }

const numIn = (p: number): string => (p ? String(p / 100) : '');

export default function TourHisabScreen({
  profile,
  tourId,
  onBack
}: {
  profile: UserProfile;
  tourId: string;
  onBack: () => void;
}) {
  const slideRef = useSwipeBack(onBack);

  const [tour, setTour] = useState<{ name: string; date?: string; cities: RTCity[] } | null>(null);
  const [tourMissing, setTourMissing] = useState(false);
  const [hisab, setHisab] = useState<TourHisabDoc | null>(null);
  const [openCity, setOpenCity] = useState<number | null>(null);
  const [openShop, setOpenShop] = useState('');
  const [fGr, setFGr] = useState('');
  const [fLess, setFLess] = useState('');
  const [fPaid, setFPaid] = useState('');
  const [fMode, setFMode] = useState(1);
  const [fNote, setFNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState('');
  const [showJama, setShowJama] = useState(false);
  const [jAmt, setJAmt] = useState('');
  const [jPlace, setJPlace] = useState('');
  const [jMode, setJMode] = useState(1);
  const [jNote, setJNote] = useState('');
  const [savingJ, setSavingJ] = useState(false);

  // tour doc LIVE — dashboard naya paste kare to turant dikhe
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'tours', tourId),
      (s) => {
        if (!s.exists()) { setTourMissing(true); return; }
        const v = s.data() as Record<string, unknown>;
        const citiesRaw = Array.isArray(v.cities) ? (v.cities as Array<Record<string, unknown>>) : [];
        const cities: RTCity[] = citiesRaw.map((c) => ({
          name: String(c?.name || ''),
          date: typeof c?.date === 'string' ? c.date : undefined,
          shops: (Array.isArray(c?.shops) ? (c.shops as Array<Record<string, unknown>>) : []).map((sh) => ({
            key: String(sh?.key || ''),
            code: String(sh?.code || ''),
            name: String(sh?.name || ''),
            billsP: typeof sh?.billsP === 'number' ? sh.billsP : 0,
            recvP: typeof sh?.recvP === 'number' ? sh.recvP : 0,
            balP: typeof sh?.balP === 'number' ? sh.balP : 0,
            bills: (Array.isArray(sh?.bills) ? (sh.bills as Array<Record<string, unknown>>) : []).map((b) => ({
              date: String(b?.date || ''),
              days: typeof b?.days === 'number' ? b.days : 0,
              amtP: typeof b?.amtP === 'number' ? b.amtP : 0,
              balP: typeof b?.balP === 'number' ? b.balP : 0,
              recvP: typeof b?.recvP === 'number' ? b.recvP : 0,
              lessP: typeof b?.lessP === 'number' ? b.lessP : 0,
              mode: typeof b?.mode === 'number' ? b.mode : 0
            }))
          })).filter((sh) => sh.name)
        }));
        setTour({ name: String(v.name || 'Tour'), date: typeof v.date === 'string' ? v.date : undefined, cities });
      },
      () => {}
    );
    return () => unsub();
  }, [tourId]);

  // apna hisab doc LIVE — dobara kholo to bhara hua dikhe, dashboard bhi dekhta hai
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'tours', tourId, 'hisab', profile.uid),
      (s) => { setHisab(s.exists() ? (s.data() as TourHisabDoc) : null); },
      () => {}
    );
    return () => unsub();
  }, [tourId, profile.uid]);

  const totals = useMemo(() => totalsOf(hisab?.entries, hisab?.deposits), [hisab]);
  const deposits = useMemo(() => [...(hisab?.deposits || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [hisab]);

  const openShopForm = (sh: RTShop) => {
    if (openShop === sh.key) { setOpenShop(''); return; }
    const e = hisab?.entries?.[sh.key];
    setFGr(e ? numIn(e.grP) : '');
    setFLess(e ? numIn(e.lessP) : '');
    setFPaid(e ? numIn(e.paidP) : '');
    setFMode(e?.mode && e.mode >= 1 && e.mode <= 3 ? e.mode : 1);
    setFNote(e?.note || '');
    setOpenShop(sh.key);
  };

  const saveEntry = async (city: RTCity, sh: RTShop) => {
    if (saving) return;
    const grP = fGr.trim() ? parseMoneyInput(fGr) : 0;
    const lessP = fLess.trim() ? parseMoneyInput(fLess) : 0;
    const paidP = fPaid.trim() ? parseMoneyInput(fPaid) : 0;
    if (fGr.trim() && grP === null) { window.alert('GR amount sahi likho (jaise 2500)'); return; }
    if (fLess.trim() && lessP === null) { window.alert('Less amount sahi likho'); return; }
    if (fPaid.trim() && paidP === null) { window.alert('Paisa diya amount sahi likho'); return; }
    if (!grP && !lessP && !paidP) { window.alert('Kuch to bharo — GR, Less ya Paisa Diya me se'); return; }
    const e: TourShopEntry = {
      shopKey: sh.key,
      cityName: city.name,
      shopCode: sh.code,
      shopName: sh.name,
      grP: grP || 0,
      lessP: lessP || 0,
      paidP: paidP || 0,
      mode: fMode,
      note: fNote.trim() || undefined,
      at: Date.now()
    };
    setSaving(true);
    try {
      await saveShopEntry(tourId, profile.uid, profile.name, e);
      setOpenShop('');
      setSavedTick(sh.key);
      window.setTimeout(() => setSavedTick(''), 2500);
    } catch (err) {
      window.alert('Save nahi hua: ' + String((err as Error)?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const saveJama = async () => {
    if (savingJ) return;
    const amtP = parseMoneyInput(jAmt);
    if (!amtP) { window.alert('Jama ka amount likho'); return; }
    if (!jPlace.trim()) { window.alert('Kaha jama kiya? — jagah ka naam likho (jaise: JND T. T shop)'); return; }
    const d: TourDeposit = { at: Date.now(), amtP, mode: jMode, place: jPlace.trim(), note: jNote.trim() || undefined };
    setSavingJ(true);
    try {
      await addDeposit(tourId, profile.uid, profile.name, d);
      setJAmt(''); setJPlace(''); setJNote(''); setShowJama(false);
    } catch (err) {
      window.alert('Jama save nahi hua: ' + String((err as Error)?.message || err));
    } finally {
      setSavingJ(false);
    }
  };

  const fmtT = (at: number) => {
    try {
      return new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    } catch { return ''; }
  };

  return (
    <div
      ref={slideRef}
      className="fixed inset-0 z-[60] overflow-y-auto text-slate-100 px-4"
      style={SWIPE_OVERLAY_STYLE}
    >
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-cyan-500/15" />
      <div className="ambient-orb top-[45%] -left-20 h-56 w-56 bg-emerald-400/10" />

      {/* header — tour ka naam (yahi naam dashboard se aaya) */}
      <div className="relative z-10 mb-4">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-cyan-300/25 bg-gradient-to-br from-cyan-400/25 to-teal-500/15">
            <Truck className="h-4.5 w-4.5 text-cyan-300" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-slate-400">Tour Hisab</h2>
            <p className="truncate text-[17px] font-extrabold text-white">
              {tour ? tour.name : tourMissing ? 'Tour nahi mila' : '...'}
              {tour?.date && <span className="ml-2 text-[11px] font-bold text-slate-400">{tour.date}</span>}
            </p>
          </div>
        </div>
      </div>

      {tourMissing && (
        <div className="glass-card relative z-10 rounded-[20px] p-5 text-center text-xs text-slate-400">
          Ye tour dashboard se delete ho gaya ya nahi bana. Peeche slide karke jao.
        </div>
      )}

      {tour && (
        <>
          {/* ============ MERA HISAB (live totals) ============ */}
          <div className="glass-card intro-rise relative z-10 mb-3 rounded-[20px] p-4">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <span className="sec-label">Mera Hisab</span>
              <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2.5 py-1 text-[9.5px] font-extrabold tracking-[0.12em] text-emerald-300">
                {totals.filled}/{tour.cities.reduce((a, c) => a + c.shops.length, 0)} SHOPS
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="glass-inset rounded-2xl px-2 py-3 text-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Diya</p>
                <p className="mt-0.5 text-[13px] font-extrabold text-emerald-300">{fmtMoney(totals.paidP)}</p>
              </div>
              <div className="glass-inset rounded-2xl px-2 py-3 text-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Jama</p>
                <p className="mt-0.5 text-[13px] font-extrabold text-sky-300">{fmtMoney(totals.jamaP)}</p>
              </div>
              <div className="glass-inset rounded-2xl px-2 py-3 text-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Haath me</p>
                <p className={`mt-0.5 text-[13px] font-extrabold ${totals.haathP >= 0 ? 'text-amber-300' : 'text-rose-300'}`}>{fmtMoney(totals.haathP)}</p>
              </div>
              <div className="glass-inset rounded-2xl px-2 py-3 text-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">GR / Less</p>
                <p className="mt-0.5 text-[13px] font-extrabold text-slate-200">{fmtMoney(totals.grP)}<span className="text-slate-500"> / </span>{fmtMoney(totals.lessP)}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 px-1">
              <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[9px] font-extrabold text-emerald-300">CASH {fmtMoney(totals.cashP)}</span>
              <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[9px] font-extrabold text-sky-300">UPI {fmtMoney(totals.upiP)}</span>
              <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[9px] font-extrabold text-violet-300">CHEQUE {fmtMoney(totals.cheqP)}</span>
            </div>
          </div>

          {/* ============ JAMA (jaha jama kiya) ============ */}
          <div className="glass-card intro-rise relative z-10 mb-3 rounded-[20px] p-4">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <span className="sec-label flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5 text-sky-300" /> Jama</span>
              <button
                onClick={() => setShowJama((v) => !v)}
                className={`rounded-full px-3.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider shadow-lg transition active:scale-95 ${
                  showJama ? 'border border-white/10 bg-white/10 text-slate-200 shadow-none' : 'bg-gradient-to-r from-sky-400 to-cyan-500 text-slate-950 shadow-sky-500/25'
                }`}
              >
                {showJama ? '× Close' : '+ Jama Kiya'}
              </button>
            </div>

            {showJama && (
              <div className="glass-inset mb-3 space-y-2.5 rounded-2xl p-3.5">
                <div className="flex gap-2">
                  <input
                    value={jAmt}
                    onChange={(e) => setJAmt(e.target.value)}
                    inputMode="decimal"
                    placeholder="Kitna ₹ (jaise 25000)"
                    className="glass-inset min-w-0 flex-1 rounded-xl p-3 text-xs font-bold text-white placeholder-slate-500 focus:outline-none"
                  />
                  <input
                    value={jPlace}
                    onChange={(e) => setJPlace(e.target.value)}
                    placeholder="Kaha jama kiya? (jaise JND T. T shop)"
                    className="glass-inset min-w-0 flex-[1.6] rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setJMode(m.id)}
                      className={`flex-1 rounded-xl border py-2 text-center text-[11px] font-extrabold transition ${
                        jMode === m.id ? 'border-sky-300/40 bg-sky-400/15 text-sky-300' : 'border-white/10 bg-white/5 text-slate-400'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <input
                  value={jNote}
                  onChange={(e) => setJNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="glass-inset w-full rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none"
                />
                <button
                  onClick={saveJama}
                  disabled={savingJ}
                  className="w-full rounded-xl bg-gradient-to-r from-sky-400 to-cyan-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-sky-500/25 transition active:scale-95 disabled:opacity-50"
                >
                  {savingJ ? 'Saving...' : 'Jama Save Karo'}
                </button>
              </div>
            )}

            {deposits.length === 0 ? (
              <p className="px-1 text-[11px] font-semibold text-slate-500">Abhi koi jama nahi — paisa jama kiya to "+ Jama Kiya" se likho</p>
            ) : (
              <div className="space-y-1.5">
                {deposits.map((d, i) => (
                  <div key={i} className="glass-inset flex items-center gap-2 rounded-xl px-3 py-2.5">
                    <Wallet className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                    <span className="text-[13px] font-extrabold text-sky-300">{fmtMoney(d.amtP)}</span>
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-extrabold text-slate-300">{modeLabel(d.mode)}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-300">@ {d.place}</span>
                    <span className="shrink-0 text-[9px] font-semibold text-slate-500">{fmtT(d.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ============ CITIES -> SHOPS -> HISAB ============ */}
          <div className="relative z-10 mb-2 mt-5 flex items-center justify-between px-1">
            <h2 className="text-[17px] font-semibold text-[#B7C5F0]">Cities & Shops</h2>
            <span className="text-[10px] font-bold text-slate-500">{tour.cities.length} cities</span>
          </div>
          <div className="relative z-10 space-y-2.5 pb-6">
            {tour.cities.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-5 text-center text-xs text-slate-500">
                Is tour me koi city nahi
              </div>
            )}
            {tour.cities.map((city, ci) => {
              const cityOpen = openCity === ci;
              const cityEntries = city.shops.filter((sh) => hisab?.entries?.[sh.key]).length;
              return (
                <div key={ci} className="glass-card intro-rise overflow-hidden rounded-[20px]">
                  <button
                    onClick={() => { setOpenCity(cityOpen ? null : ci); setOpenShop(''); }}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-400/10">
                      <MapPin className="h-4.5 w-4.5 text-amber-300" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-extrabold text-white">{city.name}</span>
                      <span className="block text-[11px] font-semibold text-slate-400">
                        {city.shops.length} shops{city.date ? ` · ${city.date}` : ''} · hisab {cityEntries}/{city.shops.length}
                      </span>
                    </span>
                    {cityEntries === city.shops.length && city.shops.length > 0 && (
                      <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-400" />
                    )}
                    {cityOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
                  </button>

                  {cityOpen && (
                    <div className="space-y-2 border-t border-white/5 p-3">
                      {city.shops.length === 0 && (
                        <p className="px-1 py-2 text-center text-[11px] text-slate-500">Is city me koi shop nahi</p>
                      )}
                      {city.shops.map((sh) => {
                        const e = hisab?.entries?.[sh.key];
                        const shopOpen = openShop === sh.key;
                        return (
                          <div key={sh.key} className="glass-inset overflow-hidden rounded-2xl">
                            <button onClick={() => openShopForm(sh)} className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left">
                              <Store className="h-4 w-4 shrink-0 text-slate-400" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-extrabold text-white">{sh.name}</span>
                                <span className="block truncate text-[10px] font-semibold text-slate-500">
                                  {sh.code}{sh.bills.length ? ` · ${sh.bills.length} bills · bal ${fmtMoney(sh.balP)}` : ''}
                                </span>
                              </span>
                              {savedTick === sh.key ? (
                                <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-1 text-[9px] font-extrabold text-emerald-300">SAVED</span>
                              ) : e ? (
                                <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-1 text-[9.5px] font-extrabold text-emerald-300">
                                  {fmtMoney(e.paidP)} {e.mode ? `· ${modeLabel(e.mode)}` : ''}
                                </span>
                              ) : (
                                <span className="shrink-0 rounded-full bg-amber-400/10 px-2 py-1 text-[9px] font-extrabold text-amber-300">HISAB PENDING</span>
                              )}
                              {shopOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                            </button>

                            {shopOpen && (
                              <div className="space-y-2.5 border-t border-white/5 p-3.5">
                                {/* miracle context */}
                                {sh.bills.length > 0 && (
                                  <div className="rounded-xl bg-white/[0.03] px-3 py-2">
                                    <p className="mb-1 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">Miracle hisab (dashboard ka data)</p>
                                    <div className="max-h-24 space-y-0.5 overflow-y-auto">
                                      {sh.bills.slice(-6).map((b, bi) => (
                                        <div key={bi} className="flex items-center gap-2 text-[10px] text-slate-400">
                                          <span className="w-16 shrink-0">{b.date}</span>
                                          <span className="tabular-nums">bill {fmtMoney(b.amtP)}</span>
                                          <span className="ml-auto tabular-nums text-slate-500">bal {fmtMoney(b.balP)}</span>
                                          {b.recvP > 0 && <span className="tabular-nums text-emerald-400/80">recv {fmtMoney(b.recvP)}</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {/* hisab form */}
                                <div className="flex gap-2">
                                  <div className="min-w-0 flex-1">
                                    <label className="mb-1 block px-1 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">GR (R.Goods ₹)</label>
                                    <input value={fGr} onChange={(ev) => setFGr(ev.target.value)} inputMode="decimal" placeholder="0"
                                      className="glass-inset w-full rounded-xl p-3 text-xs font-bold text-white placeholder-slate-600 focus:outline-none" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <label className="mb-1 block px-1 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">Less ₹</label>
                                    <input value={fLess} onChange={(ev) => setFLess(ev.target.value)} inputMode="decimal" placeholder="0"
                                      className="glass-inset w-full rounded-xl p-3 text-xs font-bold text-white placeholder-slate-600 focus:outline-none" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <label className="mb-1 block px-1 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">Paisa Diya ₹</label>
                                    <input value={fPaid} onChange={(ev) => setFPaid(ev.target.value)} inputMode="decimal" placeholder="0"
                                      className="glass-inset w-full rounded-xl p-3 text-xs font-bold text-white placeholder-slate-600 focus:outline-none" />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  {MODES.map((m) => (
                                    <button key={m.id} onClick={() => setFMode(m.id)}
                                      className={`flex-1 rounded-xl border py-2 text-center text-[11px] font-extrabold transition ${
                                        fMode === m.id ? 'border-emerald-300/40 bg-emerald-400/15 text-emerald-300' : 'border-white/10 bg-white/5 text-slate-400'
                                      }`}>
                                      {m.label}
                                    </button>
                                  ))}
                                </div>
                                <input value={fNote} onChange={(ev) => setFNote(ev.target.value)} placeholder="Note (optional — jaise cheque no.)"
                                  className="glass-inset w-full rounded-xl p-3 text-xs text-white placeholder-slate-500 focus:outline-none" />
                                <button onClick={() => saveEntry(city, sh)} disabled={saving}
                                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 py-3 text-xs font-extrabold text-slate-950 shadow-lg shadow-emerald-500/25 transition active:scale-95 disabled:opacity-50">
                                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
                                  {saving ? 'Saving...' : 'Hisab Save Karo'}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
