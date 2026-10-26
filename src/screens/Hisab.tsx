import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  doc, 
  updateDoc, 
  increment,
  limit 
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { 
  UserProfile, 
  Sheet, 
  Customer, 
  CustomerBill, 
  LedgerEntry, 
  EntryKind, 
  PaymentMode 
} from '../types';

interface HisabProps {
  profile: UserProfile;
}

const DEFAULT_DEMO_CUSTOMERS: Customer[] = [
  { id: 'c_01', code: 'C001', name: 'Mahavir Textiles', opening: 50000, balance: 45200 },
  { id: 'c_02', code: 'C002', name: 'Gujarat Retail Stores', opening: 20000, balance: 18500 },
  { id: 'c_03', code: 'C003', name: 'Bhavani Trading Co.', opening: 80000, balance: 76000 },
  { id: 'c_04', code: 'C004', name: 'Shri Krishna Enterprise', opening: 15000, balance: 12300 },
];

export default function Hisab({ profile }: HisabProps) {
  const isDemo = profile.uid.startsWith('demo_') || !auth.currentUser;

  // Sheets & Customers
  const [sheets, setSheets] = useState<Sheet[]>(() => {
    if (isDemo) {
      return [
        {
          id: 'sheet_demo_1',
          month: new Date().toISOString().slice(0, 7),
          city: profile.city || 'Rajkot North',
          assignedTo: profile.uid,
          assignedName: profile.name,
          status: 'active',
          createdAt: Date.now() - 86400000 * 5,
        },
      ];
    }
    return [];
  });
  const [selectedSheet, setSelectedSheet] = useState<Sheet | null>(() => {
    if (isDemo) {
      return {
        id: 'sheet_demo_1',
        month: new Date().toISOString().slice(0, 7),
        city: profile.city || 'Rajkot North',
        assignedTo: profile.uid,
        assignedName: profile.name,
        status: 'active',
        createdAt: Date.now() - 86400000 * 5,
      };
    }
    return null;
  });

  const [customers, setCustomers] = useState<Customer[]>(() => {
    if (isDemo) {
      try {
        const stored = localStorage.getItem('shivam_demo_customers');
        if (stored) return JSON.parse(stored);
      } catch (e) {}
      return DEFAULT_DEMO_CUSTOMERS;
    }
    return [];
  });
  const [search, setSearch] = useState('');

  // Entries
  const [entries, setEntries] = useState<LedgerEntry[]>(() => {
    if (isDemo) {
      try {
        const stored = localStorage.getItem(`shivam_demo_entries_${profile.uid}`);
        if (stored) return JSON.parse(stored);
      } catch (e) {}
      return [
        {
          id: 'eid_01',
          kind: 'jama',
          cid: 'c_01',
          cname: 'Mahavir Textiles',
          amount: 4800,
          cash: 4800,
          mode: 1,
          byUid: profile.uid,
          byName: profile.name,
          at: Date.now() - 3600000 * 4,
          miracle: false,
          note: 'Recovery bill #104',
        },
        {
          id: 'eid_02',
          kind: 'kharcha',
          amount: 350,
          mode: 1,
          byUid: profile.uid,
          byName: profile.name,
          at: Date.now() - 3600000 * 2,
          miracle: true,
          note: 'Customer visit tempo diesel',
        },
      ];
    }
    return [];
  });

  const [showEntryModal, setShowEntryModal] = useState(false);

  // New Entry Form State
  const [entryKind, setEntryKind] = useState<EntryKind>('jama');
  const [targetCid, setTargetCid] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [cashPart, setCashPart] = useState<string>('');
  const [lessPart, setLessPart] = useState<string>('');
  const [rgoodsPart, setRgoodsPart] = useState<string>('');
  const [payMode, setPayMode] = useState<PaymentMode>(1);
  const [note, setNote] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);

  // New Customer Modal
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [newCustCode, setNewCustCode] = useState('');
  const [newCustName, setNewCustName] = useState('');
  const [newCustOpening, setNewCustOpening] = useState('');
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Fetch Sheets assigned to this user or all active (if not demo)
  useEffect(() => {
    if (isDemo) return;
    const q = query(collection(db, 'sheets'), where('status', '==', 'active'));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Sheet, 'id'>),
        }));
        setSheets(list);
        if (list.length > 0 && !selectedSheet) {
          const mySheet = list.find((s) => s.assignedTo === profile.uid) || list[0];
          setSelectedSheet(mySheet);
        }
      },
      (err) => {
        console.warn('Sheets snapshot warning:', err.message);
      }
    );
    return () => unsub();
  }, [profile.uid, isDemo]);

  // Fetch Customers (if not demo)
  useEffect(() => {
    if (isDemo) return;
    const q = query(collection(db, 'customers'), orderBy('name', 'asc'), limit(100));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Customer, 'id'>),
        }));
        setCustomers(list);
      },
      (err) => {
        console.warn('Customers snapshot warning:', err.message);
      }
    );
    return () => unsub();
  }, [isDemo]);

  // Fetch Recent Entries (if not demo)
  useEffect(() => {
    if (isDemo) return;
    const q = query(
      collection(db, 'entries'),
      where('byUid', '==', profile.uid),
      orderBy('at', 'desc'),
      limit(25)
    );
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<LedgerEntry, 'id'>),
        }));
        setEntries(list);
      },
      (err) => {
        console.warn('Entries snapshot warning:', err.message);
      }
    );
    return () => unsub();
  }, [profile.uid, isDemo]);

  // Filtered customer list
  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase())
  );

  // Open entry modal for a specific customer
  const handleOpenJamaForCustomer = (cust: Customer) => {
    setEntryKind('jama');
    setTargetCid(cust.id);
    setAmount('');
    setCashPart('');
    setLessPart('');
    setRgoodsPart('');
    setPayMode(1);
    setNote('');
    setShowEntryModal(true);
  };

  // Submit New Ledger Entry (Jama / Kharcha)
  const handleSubmitEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      alert('Please enter a valid amount.');
      return;
    }

    const selectedCust = customers.find((c) => c.id === targetCid);
    if (entryKind === 'jama' && !selectedCust) {
      alert('Please select a party for collection entry.');
      return;
    }

    setSavingEntry(true);

    // Get current GPS coords if available
    let currentCoords: { lat?: number; lng?: number } = {};
    try {
      if ('geolocation' in navigator) {
        const pos: any = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 4000 });
        });
        if (pos && pos.coords) {
          currentCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      }
    } catch (e) {
      // ignore
    }

    try {
      const newEntry: LedgerEntry = {
        id: `entry_${Date.now()}`,
        kind: entryKind,
        cid: entryKind === 'jama' ? targetCid : undefined,
        cname: entryKind === 'jama' && selectedCust ? selectedCust.name : undefined,
        amount: numericAmount,
        cash: cashPart ? parseFloat(cashPart) : undefined,
        less: lessPart ? parseFloat(lessPart) : undefined,
        rgoods: rgoodsPart ? parseFloat(rgoodsPart) : undefined,
        mode: payMode,
        note: note.trim() || undefined,
        byUid: profile.uid,
        byName: profile.name,
        at: Date.now(),
        lat: currentCoords.lat,
        lng: currentCoords.lng,
        miracle: false, // pending Miracle software copy
      };

      if (isDemo) {
        // Update local entries
        const updatedEntries = [newEntry, ...entries];
        setEntries(updatedEntries);
        try {
          localStorage.setItem(`shivam_demo_entries_${profile.uid}`, JSON.stringify(updatedEntries));
        } catch (e) {}

        // If Jama, update customer balance in demo
        if (entryKind === 'jama' && targetCid) {
          const updatedCusts = customers.map((c) => {
            if (c.id === targetCid) {
              return { ...c, balance: c.balance - numericAmount, updatedAt: Date.now() };
            }
            return c;
          });
          setCustomers(updatedCusts);
          try {
            localStorage.setItem('shivam_demo_customers', JSON.stringify(updatedCusts));
          } catch (e) {}
        }
      } else {
        await addDoc(collection(db, 'entries'), newEntry);

        // If Jama, reduce customer's outstanding balance
        if (entryKind === 'jama' && targetCid) {
          await updateDoc(doc(db, 'customers', targetCid), {
            balance: increment(-numericAmount),
            updatedAt: Date.now(),
          });
        }
      }

      setShowEntryModal(false);
      setAmount('');
      setCashPart('');
      setLessPart('');
      setRgoodsPart('');
      setNote('');
    } catch (err: any) {
      console.error('Entry save error:', err);
      alert('Error saving entry: ' + err.message);
    } finally {
      setSavingEntry(false);
    }
  };

  // Create New Customer
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim() || !newCustCode.trim()) {
      alert('Customer Name and Code are required.');
      return;
    }

    setSavingCustomer(true);
    try {
      const opening = parseFloat(newCustOpening) || 0;
      const newCust: Customer = {
        id: `cust_${Date.now()}`,
        code: newCustCode.trim().toUpperCase(),
        name: newCustName.trim(),
        opening: opening,
        balance: opening,
        updatedAt: Date.now(),
      };

      if (isDemo) {
        const updated = [...customers, newCust];
        setCustomers(updated);
        try {
          localStorage.setItem('shivam_demo_customers', JSON.stringify(updated));
        } catch (e) {}
      } else {
        await addDoc(collection(db, 'customers'), {
          code: newCust.code,
          name: newCust.name,
          opening: newCust.opening,
          balance: newCust.balance,
          updatedAt: Date.now(),
        });
      }

      setShowAddCustomerModal(false);
      setNewCustCode('');
      setNewCustName('');
      setNewCustOpening('');
    } catch (err: any) {
      alert('Error adding customer: ' + err.message);
    } finally {
      setSavingCustomer(false);
    }
  };

  return (
    <div className="space-y-4 p-1 text-slate-100 max-w-lg mx-auto">
      {/* Demo status banner if applicable */}
      {isDemo && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold">💼 Demo Mode Active:</span>
            <span>Local ledger &amp; recovery simulation</span>
          </div>
          <span className="font-mono text-[10px] bg-emerald-900/60 px-2 py-0.5 rounded text-emerald-300">
            {profile.name}
          </span>
        </div>
      )}

      {/* Header Info Banner */}
      <div className="rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-4 shadow-xl flex items-center justify-between">
        <div>
          <span className="text-xs uppercase tracking-wider text-[#8A93A6]">Hisab &amp; Recovery</span>
          <h2 className="text-base font-bold text-white flex items-center gap-1.5 mt-0.5">
            <span>💼</span> Sales Ledger
          </h2>
          <p className="text-xs text-[#38BDF8] mt-0.5">
            {selectedSheet ? `${selectedSheet.city} (${selectedSheet.month})` : 'Sheet: General City'}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => {
              setEntryKind('kharcha');
              setTargetCid('');
              setShowEntryModal(true);
            }}
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
          >
            - Expense
          </button>
          <button
            onClick={() => {
              setEntryKind('jama');
              setTargetCid(customers[0]?.id || '');
              setShowEntryModal(true);
            }}
            className="rounded-xl bg-[#10B981] px-3 py-2 text-xs font-bold text-slate-950 shadow-lg hover:bg-emerald-400"
          >
            + Collection
          </button>
        </div>
      </div>

      {/* Customer Search & Management */}
      <div className="rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-4 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            Party / Customer Accounts ({filteredCustomers.length})
          </h3>
          <button
            onClick={() => setShowAddCustomerModal(true)}
            className="text-[11px] font-bold text-[#38BDF8] hover:text-sky-300"
          >
            + Add New Party
          </button>
        </div>

        <div className="relative mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search party by name or code..."
            className="w-full rounded-xl border border-[#1D2B47] bg-[#050C18] px-3.5 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-[#F59300]"
          />
        </div>

        {/* Customer Cards List */}
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {filteredCustomers.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#8A93A6]">
              No customers found. Click &quot;+ Add New Party&quot; to create one.
            </div>
          ) : (
            filteredCustomers.map((cust) => (
              <div
                key={cust.id}
                className="flex items-center justify-between rounded-xl border border-[#1D2B47] bg-[#050C18] p-3 hover:border-slate-700 transition"
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] bg-[#121F36] px-1.5 py-0.5 rounded text-[#38BDF8] font-bold">
                      {cust.code}
                    </span>
                    <span className="font-bold text-xs text-white">{cust.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    <span className="text-[#8A93A6]">Balance:</span>
                    <span
                      className={`font-mono font-bold ${
                        cust.balance > 0 ? 'text-[#FBBF24]' : 'text-[#34D399]'
                      }`}
                    >
                      ₹{cust.balance.toLocaleString('en-IN')}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleOpenJamaForCustomer(cust)}
                    className="rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-600 hover:text-white transition"
                  >
                    Receive
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent Ledger Entries */}
      <div className="rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-4 shadow-xl">
        <div className="flex items-center justify-between mb-3 border-b border-[#1D2B47] pb-2">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            Recent Entries (Today / Shift)
          </h3>
          <span className="text-[10px] text-[#8A93A6]">Miracle Sync</span>
        </div>

        {entries.length === 0 ? (
          <p className="text-xs text-[#8A93A6] py-3 text-center">No collection entries recorded yet.</p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl border border-[#1D2B47] bg-[#050C18] p-2.5 text-xs flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        entry.kind === 'jama'
                          ? 'bg-[#10B981]/20 text-[#34D399]'
                          : 'bg-rose-500/20 text-rose-400'
                      }`}
                    >
                      {entry.kind === 'jama' ? 'COLLECTION' : 'EXPENSE'}
                    </span>
                    <span className="font-semibold text-slate-200">
                      {entry.cname || entry.note || (entry.kind === 'kharcha' ? 'General Expense' : 'Payment')}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-[#8A93A6]">
                    <span>
                      Mode: {entry.mode === 1 ? 'Cash' : entry.mode === 2 ? 'UPI' : 'Cheque'}
                    </span>
                    <span>•</span>
                    <span>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {entry.note && (
                      <>
                        <span>•</span>
                        <span className="italic truncate max-w-[120px]">{entry.note}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="text-right">
                  <span
                    className={`block font-mono text-sm font-black ${
                      entry.kind === 'jama' ? 'text-[#34D399]' : 'text-rose-400'
                    }`}
                  >
                    {entry.kind === 'jama' ? '+' : '-'}₹{entry.amount.toLocaleString('en-IN')}
                  </span>
                  <span
                    className={`inline-block text-[9px] font-bold px-1.5 py-0.2 rounded mt-0.5 ${
                      entry.miracle
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-[#121F36] text-[#8A93A6]'
                    }`}
                  >
                    {entry.miracle ? 'Miracle Synced' : 'Pending Miracle'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Entry Modal (Collection / Expense) */}
      {showEntryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-[#1D2B47] bg-[#0C1628] p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1D2B47] pb-3 mb-4">
              <h3 className="text-sm font-bold text-white">
                {entryKind === 'jama' ? '💰 Collection Entry' : '💸 Expense Entry'}
              </h3>
              <button
                onClick={() => setShowEntryModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitEntry} className="space-y-3">
              {entryKind === 'jama' && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Select Customer / Party *
                  </label>
                  <select
                    value={targetCid}
                    onChange={(e) => setTargetCid(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    required
                  >
                    <option value="">-- Choose Party --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} - {c.name} (Bal: ₹{c.balance})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Amount (₹) *
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 5000"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-base font-bold text-white outline-none focus:border-indigo-500"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Payment Mode
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 1, label: '💵 Cash' },
                    { id: 2, label: '📱 UPI' },
                    { id: 3, label: '📑 Cheque' },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setPayMode(m.id as PaymentMode)}
                      className={`rounded-xl border py-2 text-center text-xs font-bold transition ${
                        payMode === m.id
                          ? 'border-indigo-500 bg-indigo-600/30 text-indigo-300'
                          : 'border-slate-700 bg-slate-800 text-slate-400'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {entryKind === 'jama' && (
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Cash Part</label>
                    <input
                      type="number"
                      value={cashPart}
                      onChange={(e) => setCashPart(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Less / Disc</label>
                    <input
                      type="number"
                      value={lessPart}
                      onChange={(e) => setLessPart(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">R.Goods</label>
                    <input
                      type="number"
                      value={rgoodsPart}
                      onChange={(e) => setRgoodsPart(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Note / Remarks
                </label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Remarks, Cheque No, etc."
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingEntry}
                  className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg hover:bg-indigo-500 disabled:opacity-50"
                >
                  {savingEntry ? 'Saving...' : 'Save Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Party Modal */}
      {showAddCustomerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-sm font-bold text-white">Add New Customer / Party</h3>
              <button
                onClick={() => setShowAddCustomerModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateCustomer} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Party Code *
                </label>
                <input
                  type="text"
                  value={newCustCode}
                  onChange={(e) => setNewCustCode(e.target.value)}
                  placeholder="e.g. C001, RJ-102"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white uppercase outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Party Name *
                </label>
                <input
                  type="text"
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  placeholder="e.g. Mahavir Traders"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  Opening Balance (₹)
                </label>
                <input
                  type="number"
                  value={newCustOpening}
                  onChange={(e) => setNewCustOpening(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingCustomer}
                  className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white shadow-lg hover:bg-indigo-500 disabled:opacity-50"
                >
                  {savingCustomer ? 'Adding...' : 'Add Party Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
