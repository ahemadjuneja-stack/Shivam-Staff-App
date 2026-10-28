// ============================================================
// TEST: tourHisab lib (Task 93) — totalsOf / parseMoneyInput /
// fmtMoney / tourLiteOf. Run: cd /home/z/my-project/staff-app &&
// npx tsx scripts/test_tourHisab.ts
// ============================================================
import {
  totalsOf, parseMoneyInput, fmtMoney, tourLiteOf,
  TourShopEntry, TourDeposit
} from '../src/lib/tourHisab';

let pass = 0, fail = 0;
const ok = (cond: unknown, label: string) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const e = (shopKey: string, paidP: number, mode: number, grP = 0, lessP = 0): TourShopEntry =>
  ({ shopKey, cityName: 'C', shopCode: 'X', shopName: 'S' + shopKey, grP, lessP, paidP, mode, at: 1 });

console.log('\n=== T1: totalsOf ===');
const entries: Record<string, TourShopEntry> = {
  'c0-s0': e('c0-s0', 100000, 1, 2000, 500),    // cash 1000, gr 20, less 5
  'c0-s1': e('c0-s1', 50000, 2),                // upi 500
  'c1-s0': e('c1-s0', 25000, 3),                // cheque 250
  'c1-s1': e('c1-s1', 0, 1, 750)                // sirf GR
};
const deposits: TourDeposit[] = [
  { at: 1, amtP: 40000, mode: 1, place: 'JND T. T shop' },
  { at: 2, amtP: 10000, mode: 1, place: 'Line Kharcho' }
];
const t = totalsOf(entries, deposits);
ok(t.paidP === 175000, 'paidP = 1750 — got ' + t.paidP);
ok(t.cashP === 100000, 'cashP = 1000');
ok(t.upiP === 50000, 'upiP = 500');
ok(t.cheqP === 25000, 'cheqP = 250');
ok(t.grP === 2750, 'grP = 27.50 — got ' + t.grP);
ok(t.lessP === 500, 'lessP = 5');
ok(t.jamaP === 50000, 'jamaP = 500');
ok(t.haathP === 50000, 'haathP = cash - jama = 500 — got ' + t.haathP);
ok(t.filled === 4, 'filled = 4');
ok(totalsOf(undefined, undefined).paidP === 0 && totalsOf(undefined, undefined).filled === 0, 'empty -> sab 0');
ok(totalsOf({}, []).haathP === 0, 'khaali -> haath 0');

console.log('\n=== T2: parseMoneyInput (real ₹) ===');
ok(parseMoneyInput('3456') === 345600, '"3456" -> 345600 paise');
ok(parseMoneyInput('3,456.50') === 345650, '"3,456.50" -> 345650');
ok(parseMoneyInput('0') === 0, '"0" -> 0');
ok(parseMoneyInput('') === null, 'empty -> null');
ok(parseMoneyInput('-5') === null, 'negative -> null');
ok(parseMoneyInput('12.345') === null, '3 decimal -> null');
ok(parseMoneyInput('abc') === null, 'abc -> null');

console.log('\n=== T3: fmtMoney ===');
ok(fmtMoney(345600) === '₹3,456', '345600 -> ₹3,456');
ok(fmtMoney(345650) === '₹3,456.50', '345650 -> ₹3,456.50');
ok(fmtMoney(0) === '₹0', '0 -> ₹0');
ok(fmtMoney(-500) === '-₹5', '-500 -> -₹5');

console.log('\n=== T4: tourLiteOf (Home box) ===');
const lt = tourLiteOf('tour-1', {
  name: 'PORBANDAR', date: '24/10/2026', createdAt: 99, active: true,
  cities: [
    { name: 'PORBANDAR', shops: [{}, {}, {}] },
    { name: 'JAMNAGAR', shops: [{}] },
    { name: '' }, // junk city — skip
  ]
});
ok(!!lt && lt.name === 'PORBANDAR', 'name');
ok(!!lt && lt.cities.length === 2, 'junk city skip — 2 cities');
ok(!!lt && lt.shopCount === 4, 'shopCount = 4');
ok(!!lt && lt.createdAt === 99, 'createdAt');
const inact = tourLiteOf('t', { name: 'X', active: false, cities: [], createdAt: 1 });
ok(inact === null, 'active:false -> null (app me nahi dikhega)');
const noName = tourLiteOf('t', { cities: [] });
ok(noName === null, 'name missing -> null');
ok(tourLiteOf('t', undefined) === null, 'undefined doc -> null');

console.log('\n========================================');
console.log(`PASS: ${pass}  FAIL: ${fail}`);
console.log(fail === 0 ? 'ALL TOUR-HISAB TESTS GREEN ✓' : '!!! FAILURES !!!');
process.exit(fail === 0 ? 0 : 1);
