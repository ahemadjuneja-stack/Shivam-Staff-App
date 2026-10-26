import { X } from 'lucide-react';
import { Task } from '../types';
import { CREDIT_POINTS } from '../lib/credit';

// ============================================================
// TASK VERIFY MODAL (bug fix — Boss order 2026-10-26)
// PURANA FLOW: window.confirm — box band karne par (Cancel/back) bhi 'false'
// milta tha, isliye SIRF DEKHNE ke liye tap karke box band karne par bhi task
// 'rejected' ho kar staff ke points -5 cut ho jate the.
// NAYA FLOW: decision SIRF explicit YES / NO buttons par. X icon, backdrop
// tap ya bina choose kiye band karne par KUCH NAHI hota — task pending rehta
// hai, koi point change nahi.
// 100% English UI (permanent rule).
// ============================================================

interface TaskVerifyModalProps {
  task: Task | null;
  busy?: boolean;
  onClose: () => void;
  onDecide: (yes: boolean) => void;
}

export default function TaskVerifyModal({ task, busy = false, onClose, onDecide }: TaskVerifyModalProps) {
  if (!task) return null;
  return (
    <div
      onClick={() => { if (!busy) onClose(); }}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm rounded-[22px] border border-[#1D2B47] bg-[#0C1628] p-5 shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
      >
        <button
          onClick={onClose}
          disabled={busy}
          title="Close"
          className="absolute right-3.5 top-3.5 rounded-lg p-1.5 text-[#8A93A6] hover:bg-white/5 hover:text-white transition"
        >
          <X className="h-5 w-5" />
        </button>

        <p className="text-[9px] font-extrabold uppercase tracking-[0.25em] text-[#F59300]">Task Verify</p>
        <h3 className="mt-1.5 pr-6 text-[13.5px] font-bold leading-relaxed text-white">{task.title}</h3>
        <p className="mt-0.5 text-[11px] text-[#8A93A6]">Assigned to: {task.toName}</p>

        <p className="mt-3.5 text-[13px] font-semibold text-white">Is this task complete?</p>
        <p className="mt-1 text-[10px] font-medium text-[#8A93A6]">
          Yes on time: +{CREDIT_POINTS.TASK_EARLY} · Yes late: {CREDIT_POINTS.TASK_LATE} · No: {CREDIT_POINTS.TASK_REJECT}
        </p>

        <div className="mt-4 flex gap-3">
          <button
            onClick={() => onDecide(true)}
            disabled={busy}
            className="flex-1 rounded-xl bg-[#10B981] py-3 text-[11px] font-extrabold text-slate-950 shadow-lg disabled:opacity-50 transition active:scale-95"
          >
            {busy ? 'Saving...' : 'YES, Completed'}
          </button>
          <button
            onClick={() => onDecide(false)}
            disabled={busy}
            className="flex-1 rounded-xl border border-rose-500/40 bg-rose-500/10 py-3 text-[11px] font-extrabold text-rose-400 disabled:opacity-50 transition active:scale-95"
          >
            NO, Not Done
          </button>
        </div>

        <p className="mt-3 text-center text-[9.5px] font-medium text-[#5B677D]">
          Closing without choosing will not change anything — the task stays pending.
        </p>
      </div>
    </div>
  );
}
