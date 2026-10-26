// ============================================================
// POINTS GUIDE (Boss order 2026-10-26, Task 51):
// "Har staff mambers me ek page dikhao ke konsa task poora karne
//  se uske points up huwe ya jaldi aane par uske points up huwe
//  aur kon si galati karne par uske points down huwe"
//
// Ek full page jo har staff ko dikhata hai: kya karne se points UP
// hote hain, kaunsi galti se DOWN. Values lib/credit.ts ke constants
// se aati hain — future tune par guide AUTOMATIC update (hardcode nahi).
// 100% English UI (Boss permanent rule).
// ============================================================
import { CREDIT_POINTS, CREDIT_DAILY, HOURLY_ON_DUTY_CUT, MAX_CREDIT, POINTS_PER_STAR } from '../lib/credit';
import { useSwipeBack, SWIPE_OVERLAY_STYLE } from '../lib/swipeBack';

interface PointsGuideProps {
  onBack: () => void;
}

const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export default function PointsGuide({ onBack }: PointsGuideProps) {
  // BOSS RULE: back button kahi nahi — sirf left-edge slide se band hota hai
  // (screen ungli ke saath slide hoti hai, neeche Home reveal hota hai).
  const slideRef = useSwipeBack(onBack);
  const ups: { label: string; desc: string; delta: number }[] = [
    { label: 'Task completed on time', desc: 'Manager verified your task before the deadline', delta: CREDIT_POINTS.TASK_EARLY },
    { label: 'Back from outside on time', desc: 'You returned within the time you told the manager', delta: CREDIT_POINTS.OUTSIDE_ONTIME },
    { label: 'Full day duty', desc: 'You worked the full daily duty target', delta: CREDIT_DAILY.FULL_DAY },
    { label: 'Half day duty', desc: 'You worked at least half of the daily target', delta: CREDIT_DAILY.HALF_DAY },
    { label: 'Some work done', desc: 'You worked less than half of the daily target', delta: CREDIT_DAILY.SOME_WORK },
    { label: 'Monthly duty on track', desc: 'Your month duty hours are on track', delta: CREDIT_POINTS.HOURS_ONTRACK }
  ];

  const downs: { label: string; desc: string; delta: number | string }[] = [
    { label: 'Every hour on duty', desc: 'Points come from WORK, not from just staying on duty', delta: `${HOURLY_ON_DUTY_CUT} per hour` },
    { label: 'Task completed late', desc: 'Manager verified the task after the deadline', delta: CREDIT_POINTS.TASK_LATE },
    { label: 'Task marked NO by manager', desc: 'Manager checked and said the task was not done', delta: CREDIT_POINTS.TASK_REJECT },
    { label: 'Outside work rejected', desc: 'Manager said NO on your outside work log', delta: CREDIT_POINTS.OUTSIDE_REJECT },
    { label: 'Late return from outside', desc: 'You did not return within the allowed time', delta: CREDIT_POINTS.OUTSIDE_LATE },
    { label: 'Went outside without notice', desc: 'You went out without telling the manager', delta: CREDIT_POINTS.OUTSIDE_NO_NOTICE },
    { label: 'Monthly duty behind', desc: 'Your month duty hours are behind the target', delta: CREDIT_POINTS.HOURS_BEHIND }
  ];

  return (
    <div
      ref={slideRef}
      className="fixed inset-0 z-[60] overflow-y-auto text-slate-100 px-4 pb-10"
      style={SWIPE_OVERLAY_STYLE}
    >
      <div className="ambient-orb -top-12 -right-16 h-64 w-64 bg-amber-400/10" />
      <div className="ambient-orb top-[40%] -left-20 h-56 w-56 bg-emerald-400/10" />

      {/* Header — koi back button nahi (Boss rule: sirf slide se band) */}
      <div className="relative z-10 pb-4">
        <div>
          <h1 className="text-[18px] font-bold text-white">Points Guide</h1>
          <p className="text-[11px] font-semibold text-slate-400">How your credit points go up and down</p>
        </div>
      </div>

      {/* Score explanation */}
      <div className="glass-card intro-rise relative z-10 rounded-[22px] px-4 py-4 text-center">
        <p className="text-[12.5px] leading-relaxed text-slate-300">
          Your score stays between <b className="text-amber-300">1 and {MAX_CREDIT}</b> — it can never reach zero.
          Stars adjust automatically with your points: every <b className="text-amber-300">{POINTS_PER_STAR} points = 1 star</b>,
          so <b className="text-amber-300">{MAX_CREDIT} points = 5 stars</b>.
        </p>
      </div>

      {/* UP section */}
      <div className="glass-card intro-rise intro-rise-delay relative z-10 mt-3 rounded-[22px] px-4 py-4">
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-400/10 text-emerald-300">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h2 className="text-[14px] font-extrabold tracking-wide text-emerald-300">Points Go UP When You...</h2>
        </div>
        <div className="space-y-2">
          {ups.map((item, i) => (
            <div key={i} className="glass-inset flex items-center justify-between gap-3 rounded-2xl px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-white">{item.label}</p>
                <p className="text-[10.5px] leading-snug text-slate-400">{item.desc}</p>
              </div>
              <span className="shrink-0 rounded-xl border border-emerald-300/25 bg-emerald-400/10 px-3 py-1.5 text-[13px] font-black tabular-nums text-emerald-300">
                {fmt(item.delta)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* DOWN section */}
      <div className="glass-card intro-rise intro-rise-delay relative z-10 mt-3 rounded-[22px] px-4 py-4">
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-rose-300/25 bg-rose-400/10 text-rose-300">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M19 12l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h2 className="text-[14px] font-extrabold tracking-wide text-rose-300">Points Go DOWN When You...</h2>
        </div>
        <div className="space-y-2">
          {downs.map((item, i) => (
            <div key={i} className="glass-inset flex items-center justify-between gap-3 rounded-2xl px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-white">{item.label}</p>
                <p className="text-[10.5px] leading-snug text-slate-400">{item.desc}</p>
              </div>
              <span className="shrink-0 rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-1.5 text-[13px] font-black tabular-nums text-rose-300">
                {typeof item.delta === 'number' ? fmt(item.delta) : item.delta}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer note */}
      <div className="glass-inset relative z-10 mt-3 rounded-2xl px-4 py-3 text-center">
        <p className="text-[10.5px] leading-relaxed font-semibold text-slate-400">
          Work honestly, complete your tasks on time and stay at the shop —
          your points will keep going up.
        </p>
      </div>
    </div>
  );
}
