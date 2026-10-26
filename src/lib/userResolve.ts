// USER-DOC RESOLVER (Task 59-b — duplicate-registration logout loop fix):
// Ek hi phone ka DO users docs ho sakte hain (active original + rejected
// duplicate re-registration) aur Firebase Auth account DUPLICATE wala ho
// sakta hai (standard email {phone}@shivamstaff.app duplicate ne le liya hota
// hai). Isliye app identity hamesha PHONE + ACTIVE STATUS se resolve karegi —
// Auth-uid doc sirf normal case me use hota hai.
//
// Boss phone 9898904578 live case: doc XWKjH81l (active, sales) + doc yZMqUtrc
// (rejected, role none) — Auth signIn standard email par DUPLICATE (rejected)
// account deta hai. Resolver hamesha ACTIVE doc prefer karega.

import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

export interface ResolvedUserDoc {
  id: string;
  data: any;
}

// phone -> users docs -> status 'active' wala pehle; na mile to pehla doc.
// Query fail / empty par null (caller apna fallback use karega).
export const resolveUserDocByPhone = async (
  phone: string
): Promise<ResolvedUserDoc | null> => {
  const clean = (phone || '').replace(/\D/g, '');
  if (!clean) return null;
  try {
    const q = query(collection(db, 'users'), where('phone', '==', clean));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const active = snap.docs.find((d) => (d.data() as any)?.status === 'active');
    const chosen = active || snap.docs[0];
    return { id: chosen.id, data: chosen.data() };
  } catch {
    return null;
  }
};
