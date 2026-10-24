import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

/**
 * Upar header — LEFT side me SHIVAM (Aboreto, silver shine), RIGHT side me
 * version tag (v29). v-tag tap karne par manual update-check hota hai —
 * staff ke paas hamesha ek pakka rasta hai, aur support me version turant pata chalta hai.
 * Har screen par dikhta hai (App root me sticky). Status bar ke safe-area ke
 * neeche baithta hai, screen ke navy theme me blend.
 */
export default function BrandHeader() {
  const [vc, setVc] = useState<number | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let alive = true;
    CapApp.getInfo()
      .then((i) => {
        if (!alive) return;
        const n = Number((i as any).versionCode ?? (i as any).build);
        if (Number.isFinite(n) && n > 0) setVc(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const checkUpdate = () => {
    window.dispatchEvent(new CustomEvent('shivam:update-check'));
  };

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between px-4 pb-2.5 pointer-events-none select-none"
      style={{
        paddingTop: 'calc(var(--sat) + 6px)',
        background:
          'linear-gradient(180deg, rgba(10,21,53,0.88) 0%, rgba(10,21,53,0.55) 62%, rgba(10,21,53,0) 100%)'
      }}
    >
      <span
        className="shivam-silver shivam-silver-shine-slow text-[15px] uppercase"
        style={{ letterSpacing: '0.5em', textShadow: '0 1px 10px rgba(180,210,250,0.18)' }}
      >
        SHIVAM
      </span>
      {vc !== null && (
        <button
          onClick={checkUpdate}
          className="pointer-events-auto rounded-md border border-slate-500/25 bg-slate-900/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-slate-400 transition-transform active:scale-90"
          style={{ fontFamily: 'Aboreto, sans-serif' }}
        >
          v{vc}
        </button>
      )}
    </header>
  );
}
