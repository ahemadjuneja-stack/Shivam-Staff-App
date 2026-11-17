import { useEffect } from 'react';
import type { ReactNode } from 'react';

// ============================================================
// PRIVACY POLICY (Boss order 2026-11-17: "privacy policy jisme jo-jo humne
// use kiya hai, jo-jo unke data le rahe hai wo privacy policy page par
// likh do — permission dete waqt wo padh bhi sakta hai")
//
// Ye screen ConsentGate se bhi khulti hai (permission lene se PEHLE padhne
// ka mauka) aur policy ka poora sach likha hai — kya collect hota hai, kyun,
// kahan jata hai, kya NAHI hota. Hosted copy: public/privacy.html (same text).
// Policy ka text ek hi jagah change karna ho to yahan + privacy.html dono.
// ============================================================

export const POLICY_VERSION = 1;
export const POLICY_DATE = '17 November 2026';

interface PrivacyPolicyProps {
  onBack: () => void;
  backLabel?: string;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mt-5">
    <h2 className="text-[15px] font-bold text-white">{title}</h2>
    <div className="mt-1.5 space-y-2 text-[13px] leading-relaxed text-slate-300">{children}</div>
  </div>
);

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="space-y-1.5">
    {items.map((it, i) => (
      <li key={i} className="flex gap-2">
        <span className="mt-[2px] shrink-0 text-indigo-300">•</span>
        <span>{it}</span>
      </li>
    ))}
  </ul>
);

export default function PrivacyPolicy({ onBack, backLabel }: PrivacyPolicyProps) {
  // Screen khulte hi top par le jao (consent dialog ke scroll position se na aaye)
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="relative flex min-h-[86vh] justify-center px-5 py-6 text-slate-100">
      <div className="ambient-orb -top-10 -left-14 h-56 w-56 bg-indigo-500/15" />
      <div className="glass-card relative z-10 w-full max-w-md rounded-[26px] px-5 py-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[19px] font-extrabold tracking-tight text-white">
            Privacy Policy
          </h1>
          <button
            onClick={onBack}
            className="rounded-full bg-indigo-500/20 px-4 py-2 text-[12.5px] font-semibold text-indigo-200 active:scale-95"
          >
            {backLabel || 'Wapas'}
          </button>
        </div>
        <p className="mt-1 text-[11.5px] text-slate-400">
          Version {POLICY_VERSION} — {POLICY_DATE} — Shivam Staff App
        </p>

        <Section title="1. Ye policy kis baare me hai">
          <p>
            Ye app (Shivam Staff App) dukan/company ke kaam ke liye hai — attendance,
            duty, tour tracking, hisab aur alerts. Ye policy saaf-saaf batati hai ki
            app aapka kya data leta hai, kyun leta hai, kahan rakhta hai, aur kya
            KABHI nahi leta. Data collect karne ka base aapka employment hai —
            aap company ke liye kaam karte ho, isliye kaam se juda data company
            rakhti hai (aap consent dialog me iski manzoori dekh kar tick karte ho).
          </p>
        </Section>

        <Section title="2. Kya data collect hota hai">
          <Bullets
            items={[
              'Account: naam, mobile number, role (worker / sales / manager), kaam ki city.',
              'Location: GPS aur network se aapki position — dukan/tour tracking, app-open gate (dukan ke 100 meter area ka check).',
              'Mobile tower info: kis tower se phone juda hai (tower id — mcc-mnc-lac-cid), signal, aur usi se andaza ki city kaunsi hai. Ye GPS ke bina bhi chalta hai taaki internet/location band hone par bhi pata rahe.',
              'Battery: battery % aur charging on/off — taaki pata chale tracking ruki to phone band thi ya kuch aur.',
              'Motion hint (chalne/haath hilne ka sensor signal) — sirf battery bachane ke liye, GPS bewajah on na ho.',
              'Duty punches: aane/jaane ka time, tour me mile visit log (kahan kitni der ruke), sales ka hisab (bills, diye paise, note) — ye business record hai.',
              'App usage (sirf worker aur sales, sirf dukan ke time): kaun si app kitni der khuli rahi — sirf MINUTES ka total. Screen ka content, aapki chats, photos — kuch nahi dekha jata.',
            ]}
          />
        </Section>

        <Section title="3. Kya KABHI collect nahi hota">
          <Bullets
            items={[
              'Aapki photos, videos, files, contacts — kabhi nahi.',
              'Aapke messages, WhatsApp ki chats, calls ki recording — kabhi nahi.',
              'Browser me kya dekha — nahi (sirf "Chrome 1h 10m" jaisa total time, wo bhi sirf dukan ke time).',
              'Dukan se bahar ka app usage — nahi. Personal time track nahi hota.',
              'Microphone/camera — kabhi on nahi hote.',
            ]}
          />
        </Section>

        <Section title="4. Data kahan jata hai aur kaun dekhta hai">
          <p>
            Data company ke Google Firebase (Google Cloud) account par store hota
            hai. Ye dekh sakta hai: sirf management/boss (manager dashboard) —
            presence, tour, alerts aur hisab ke records. Koi teesri company ko
            becha nahi jata, advertising use nahi hota.
          </p>
        </Section>

        <Section title="5. Permission kyun chahiye">
          <Bullets
            items={[
              'Location (foreground + background): app khulne par gate + dukan par presence + tour tracking. Background taaki app band ho to bhi trail bane (boss ka order: app khule ya na khule, duty ka pata chale).',
              'Notification: duty/alerts ki jankari, tracking chalu hone ki soochi.',
              'Motion (Activity recognition): chalne ka signal mile to GPS turant on ho, khade rehne par band rahe — battery bachat hai.',
              'Battery optimization exemption: phone ka battery-saver tracking ko na roke.',
              'Usage access (optional, worker/sales): upar likhe app-usage totals ke liye — ye Android ka apna record hai, hum bas minutes padhte hain.',
            ]}
          />
        </Section>

        <Section title="6. Fake GPS / location game">
          <p>
            Agar koi fake-location app se galat jagah bhejne ki koshish ho, app usko
            pakad kar record karti hai (mock flag, GPS vs tower mismatch). Ye record
            sirf management dikh sakta hai.
          </p>
        </Section>

        <Section title="7. Data kitne din rakha jata hai">
          <p>
            Jab tak aap company me kaam karte ho. Kaam khatam hone par management
            apni policy se records rakh/saf kar sakti hai. Data delete karane ki
            request seedhe management ko do.
          </p>
        </Section>

        <Section title="8. Consent aur usko hatana">
          <p>
            Pehli baar app kholte hi permissions + ye policy dikhti hai — checkbox
            tick karne par aap terms &amp; conditions aur data-use ki manzoori dete
            ho (kyunki aap company ke liye kaam karte ho). Permission phone
            settings se band kar do to app ke tracking wale features bhi band ho
            jate hain (app ye khud pakad leti hai). Koi sawal ho to seedhe
            management/dukan malik se baat karo.
          </p>
        </Section>

        <Section title="9. Policy badalne par">
          <p>
            Naya data collect karne se pehle policy update hoga aur app me dobara
            consent dialog aa sakta hai. Is page par hamesha latest version aur
            date likhi hoti hai (abhi: version {POLICY_VERSION}, {POLICY_DATE}).
          </p>
        </Section>

        <div className="mt-6 rounded-2xl bg-slate-800/60 px-4 py-3 text-[12px] leading-relaxed text-slate-400">
          Ye policy app ke andar bhi hai (offline bhi khulti hai) aur website par
          bichhi copy se same hai. Koi confusion ho to management se puchho —
          likha sab kuch wahi hai jo app asal me karta hai.
        </div>

        <button
          onClick={onBack}
          className="mt-5 w-full rounded-2xl bg-indigo-500 py-4 text-[15px] font-bold text-white active:scale-[0.98]"
        >
          {backLabel || 'Wapas'}
        </button>
      </div>
    </div>
  );
}
