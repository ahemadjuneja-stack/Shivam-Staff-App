import React, { useEffect, useRef, useState } from 'react';

/**
 * Brand intro — app khulte hi sabse pehle ye screen.
 * Navy gradient + silver S + SHIVAM (Aboreto) with metallic shine.
 * ~3.2s baad auto fade-out (tap = skip).
 */
export default function IntroScreen({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFading(true);
    setTimeout(onDone, 550);
  };

  useEffect(() => {
    const t = setTimeout(finish, 2700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={finish}
      className={`fixed inset-0 z-[60] flex items-center justify-center transition-opacity duration-500 ${
        fading ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        background:
          'linear-gradient(180deg, #1A3852 0%, #10264A 42%, #0A1535 75%, #081027 100%)'
      }}
    >
      <div className="flex flex-col items-center select-none">
        <div className="intro-rise">
          <span className="shivam-silver shivam-silver-shine text-[104px] leading-none drop-shadow-[0_2px_28px_rgba(180,210,250,0.3)]">
            S
          </span>
        </div>
        <div className="intro-rise intro-rise-delay mt-7">
          <span className="shivam-silver shivam-silver-shine text-[21px] tracking-[0.5em] pl-[0.5em]">
            SHIVAM
          </span>
        </div>
        <div
          className="intro-rise intro-rise-delay mt-10 h-px w-24"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(226,236,250,0.55), transparent)'
          }}
        />
      </div>
    </div>
  );
}
