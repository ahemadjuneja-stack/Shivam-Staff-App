import { useEffect } from 'react';
import type { ReactNode } from 'react';

// ============================================================
// PRIVACY POLICY (Boss order 2026-11-17 + v2 feedback: "sab kuch short me
// aur English me likho, Hinglish nahi"). ConsentGate se bhi khulti hai
// (permission lene se PEHLE padhne ka mauka). Hosted copy: public/privacy.html
// (same text — dono ko saath me change karo).
// ============================================================

export const POLICY_VERSION = 3;
export const POLICY_DATE = '17 November 2026';

interface PrivacyPolicyProps {
  onBack: () => void;
  backLabel?: string;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mt-4">
    <h2 className="text-[14.5px] font-bold text-white">{title}</h2>
    <div className="mt-1.5 space-y-2 text-[12.5px] leading-relaxed text-slate-300">{children}</div>
  </div>
);

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="space-y-1">
    {items.map((it, i) => (
      <li key={i} className="flex gap-2">
        <span className="mt-[2px] shrink-0 text-indigo-300">•</span>
        <span>{it}</span>
      </li>
    ))}
  </ul>
);

export default function PrivacyPolicy({ onBack, backLabel }: PrivacyPolicyProps) {
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
          <h1 className="text-[19px] font-extrabold tracking-tight text-white">Privacy Policy</h1>
          <button
            onClick={onBack}
            className="rounded-full bg-indigo-500/20 px-4 py-2 text-[12.5px] font-semibold text-indigo-200 active:scale-95"
          >
            {backLabel || 'Back'}
          </button>
        </div>
        <p className="mt-1 text-[11.5px] text-slate-400">
          Version {POLICY_VERSION} — {POLICY_DATE} — Shivam Staff App
        </p>

        <Section title="1. About">
          <p>
            This app is for company work — attendance, duty, tour tracking, accounts
            and alerts. It collects work data because you work here. You accept this
            once in the consent screen (Terms &amp; Conditions checkbox).
          </p>
        </Section>

        <Section title="2. Data we collect">
          <Bullets
            items={[
              'Account: name, mobile number, role, work city.',
              'Location (GPS + network): shop check-in, duty tracking, tour trail.',
              'Cell tower info: tower id (mcc-mnc-lac-cid) and signal — works even without GPS or internet.',
              'Nearby Wi-Fi router IDs and signal strength (shop workers, at the shop): used only to confirm you are inside the shop — no Wi-Fi is ever connected to and no network traffic is read.',
              'Shop presence status (shop workers): inside / outside the shop and duty lock state.',
              'Silent tower pings (sales staff, when NOT on a tour): every 15 minutes the connected tower id is sent to management so your work location is known — with no notification, no GPS.',
              'Battery level and charging state.',
              'Motion signal (activity recognition) — only to save battery.',
              'Duty punches, visit logs and sales accounts (bills, payments, notes).',
              'App usage time (shop staff only, during shop time only): which app was open and for how long — minutes only.',
            ]}
          />
        </Section>

        <Section title="3. What we NEVER collect">
          <Bullets
            items={[
              'Photos, videos, files or contacts.',
              'Messages, chats or call recordings.',
              'Browsing content (only total minutes of an app, never what is inside).',
              'App usage outside the shop — personal time is not tracked.',
              'Microphone or camera — never turned on.',
            ]}
          />
        </Section>

        <Section title="4. Storage and who can see it">
          <p>
            Data is stored on the company&apos;s Google Firebase account. Only the
            management can see it. It is never sold and never used for advertising.
          </p>
        </Section>

        <Section title="5. Permissions used">
          <Bullets
            items={[
              'Location (foreground + background): check-in, presence and duty trail — background keeps the trail alive when the app is closed.',
              'Wi-Fi: scan nearby router ids and signal strength — shop presence detection only (needs location permission on Android).',
              'Notifications: duty and alert messages.',
              'Motion (activity recognition): GPS stays off when you are standing still — saves battery.',
              'Battery-optimization exemption: phone battery-saver cannot stop tracking.',
              'Usage access (optional, shop staff): reads app usage minutes recorded by Android.',
            ]}
          />
        </Section>

        <Section title="6. Fake GPS">
          <p>
            Mock locations and GPS-vs-tower mismatch are detected and recorded. Only
            the management can see this record.
          </p>
        </Section>

        <Section title="7. Data keeping, deletion and consent">
          <p>
            Data is kept while you work here. Ask the management to delete it or to
            answer any question. Turning a permission off in phone settings turns
            that feature off — the app detects it automatically. This page is always
            the latest version (now: version {POLICY_VERSION}, {POLICY_DATE}).
          </p>
        </Section>

        <button
          onClick={onBack}
          className="mt-5 w-full rounded-2xl bg-indigo-500 py-4 text-[15px] font-bold text-white active:scale-[0.98]"
        >
          {backLabel || 'Back'}
        </button>
      </div>
    </div>
  );
}
