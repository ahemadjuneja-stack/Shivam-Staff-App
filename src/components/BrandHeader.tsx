import React from 'react';

/**
 * Upar header — LEFT side me SHIVAM (Aboreto, silver shine).
 * Har screen par dikhta hai (App root me sticky). Status bar ke
 * safe-area ke neeche baithta hai, screen ke navy theme me blend.
 * BOSS RULE: design sirf wahi jo Boss ne bola — koi extra element NAHI.
 */
export default function BrandHeader() {
  return (
    <header
      className="sticky top-0 z-[80] flex items-center px-4 pb-2.5 pointer-events-none select-none"
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
    </header>
  );
}
