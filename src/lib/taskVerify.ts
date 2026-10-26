// ============================================================
// TASK VERIFY — SHARED DECISION ENGINE (bug fix, Boss order 2026-10-26)
// Boss report: "task par sirf dekhne ke liye click karte hai, verify puchta
// hai, yes/no kuch bhi nahi dete box band kar dete hai to automatically task
// complete nahi kiya dikha deta hai aur points down kar deta hai"
//
// ROOT CAUSE: window.confirm — Cancel/back = false = explicit NO jaisa treat,
// turant status 'rejected' + TASK_REJECT (-5) cut.
// FIX: decision SIRF explicit Yes/No par (TaskVerifyModal buttons se);
// dismiss/close par ye function call HI nahi hota — task pending rehta hai.
//
// Points (Boss 3-5 rule, lib/credit.ts):
//   Yes on-time: TASK_EARLY (+5) | Yes late: TASK_LATE (-3) | No: TASK_REJECT (-5)
// Atomic: tasks doc + credit_points/{toUid}.taskScore + history entry ek
// transaction me (partial update kabhi nahi).
// ============================================================
import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { Task } from '../types';
import { CREDIT_POINTS } from './credit';
import { txHistoryEntry } from './history';

export function verifyTask(t: Task, yes: boolean): Promise<void> {
  const onTime = Date.now() <= t.deadlineAt;
  const delta = yes
    ? onTime
      ? CREDIT_POINTS.TASK_EARLY
      : CREDIT_POINTS.TASK_LATE
    : CREDIT_POINTS.TASK_REJECT;
  return runTransaction(db, async (tx) => {
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
    // Credit history (Boss Task 51): task outcome score ke saath atomic
    txHistoryEntry(
      tx,
      t.toUid,
      'task',
      yes
        ? onTime
          ? `Task completed on time: "${t.title}"`
          : `Task completed late: "${t.title}"`
        : `Task marked NO by manager: "${t.title}"`,
      delta
    );
  });
}
