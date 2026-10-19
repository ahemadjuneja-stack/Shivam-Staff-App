import React from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
}

export default function ShivamLogo({ size = 'md', subtitle }: LogoProps) {
  const sizeClasses = {
    sm: 'text-base tracking-[0.2em]',
    md: 'text-xl tracking-[0.25em]',
    lg: 'text-2xl tracking-[0.3em]'
  };

  return (
    <div className="flex flex-col items-center select-none">
      <div className={`font-light relative inline-block ${sizeClasses[size]}`}>
        <span className="animate-text-shine drop-shadow-[0_0_12px_rgba(255,255,255,0.3)]">
          S H I V A M
        </span>
      </div>
      {subtitle && (
        <span className="text-[10px] uppercase tracking-[0.2em] text-indigo-300/80 mt-1 font-sans">
          {subtitle}
        </span>
      )}
    </div>
  );
}
