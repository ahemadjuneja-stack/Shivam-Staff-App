import React from 'react';

/**
 * Har screen par left edge me SHIVAM (Aboreto, silver shine).
 * Fixed overlay — kisi screen ke layout ko touch nahi karta.
 */
export default function BrandBadge() {
  return (
    <div
      aria-hidden
      className="fixed left-0 top-0 z-30 flex h-full w-5 items-center justify-center pointer-events-none select-none opacity-80"
    >
      <span
        className="shivam-silver shivam-silver-shine-slow text-[10px] uppercase"
        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', letterSpacing: '0.42em' }}
      >
        SHIVAM
      </span>
    </div>
  );
}
