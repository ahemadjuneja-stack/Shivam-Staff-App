import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

// ============================================================
// EDGE-SWIPE BACK (Boss rule 2026-10-27: "back button kahi nahi
// hona chahiye, sirf slide se chalega") — iOS-style interactive
// slide-back:
//   - Left edge (~44px) se touch start ho to screen UNGLI KE SAATH
//     slide karti hai (translateX = finger)
//   - Chhodne par: 32%+ doori ya tez fling = page band (onBack),
//     warna wapas snap
//   - Vertical drag = normal scroll (direction-lock, koi conflict nahi)
//   - Tap (bina drag) = normal button/input click (koi interception nahi)
//
// ANDROID HARDWARE BACK bhi isi overlay ko band karta hai (app
// minimize NAHI hota): App.tsx ka backButton listener dekhta hai
// body[data-swipe-overlay] counter > 0 -> 'shivam:hw-back' event
// dispatch karta hai -> ye hook us event par onBack chalata hai.
// Counter isliye hai ki kabhi 2 overlays ek saath khule to bhi
// flag sahi rahe.
// ============================================================

const EDGE_PX = 44;      // left-edge detection zone
const OPEN_RATIO = 0.32; // 32%+ drag = close
const FLING_V = 0.45;    // px/ms — tez chhota swipe bhi close
const EDGE_ZONE_START = 12; // isse kam move = abhi decide nahi

export function useSwipeBack(onBack: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onBack);
  cbRef.current = onBack;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // ---- hardware-back bridge (overlay counter) ----
    const openCount = Number(document.body.dataset.swipeOverlay || '0') + 1;
    document.body.dataset.swipeOverlay = String(openCount);
    const onHwBack = () => cbRef.current();
    window.addEventListener('shivam:hw-back', onHwBack);

    // ---- interactive edge swipe ----
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let vw = 360;
    let t0 = 0;
    let tracking = false;
    let dragging = false;
    let closeTimer = 0;

    const reset = () => {
      tracking = false;
      dragging = false;
      dx = 0;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE_PX) return; // sirf left edge
      startX = t.clientX;
      startY = t.clientY;
      vw = window.innerWidth || 360;
      t0 = Date.now();
      tracking = true;
      dragging = false;
      dx = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      const mx = t.clientX - startX;
      const my = t.clientY - startY;
      if (!dragging) {
        if (Math.abs(mx) < EDGE_ZONE_START && Math.abs(my) < EDGE_ZONE_START) return;
        if (Math.abs(my) > Math.abs(mx) || mx <= 0) {
          // vertical scroll intent ya galat direction — swipe cancel
          reset();
          return;
        }
        dragging = true;
        el.style.transition = 'none';
      }
      dx = Math.max(0, mx);
      el.style.transform = `translateX(${dx}px)`;
      if (e.cancelable) e.preventDefault(); // drag ke dauraan content scroll/click nahi
    };

    const onEnd = () => {
      if (!tracking) return;
      const wasDragging = dragging;
      reset();
      if (!wasDragging) return;
      const dur = Math.max(1, Date.now() - t0);
      const v = dx / dur;
      const close = dx > vw * OPEN_RATIO || (dx > 56 && v > FLING_V);
      el.style.transition = 'transform 200ms cubic-bezier(0.22, 0.9, 0.3, 1)';
      el.style.transform = close ? `translateX(${vw + 40}px)` : 'translateX(0px)';
      if (close) closeTimer = window.setTimeout(() => cbRef.current(), 185);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);

    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('shivam:hw-back', onHwBack);
      window.clearTimeout(closeTimer);
      const cur = Number(document.body.dataset.swipeOverlay || '0');
      if (cur <= 1) delete document.body.dataset.swipeOverlay;
      else document.body.dataset.swipeOverlay = String(cur - 1);
      el.style.transform = '';
      el.style.transition = '';
    };
  }, []);

  return ref;
}

// Slide-overlay container ki shared look: opaque navy (body ke gradient
// jaisa hi) — overlay ke NEECHE wala screen (Home) mounted rehta hai,
// isliye slide karte hi wahi reveal hota hai (iOS-style slide-back).
// touchAction pan-y = horizontal gesture JS ko milta hai, vertical scroll
// browser handle karta hai. overscroll contain = overlay ke content ke
// scroll-end par neeche wale page ka scroll chain nahi hota.
export const SWIPE_OVERLAY_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, #1A3852 0%, #10264A 42%, #0A1535 75%, #081027 100%)',
  paddingTop: 'calc(var(--sat) + 50px)',
  paddingBottom: 'calc(var(--sab) + 24px)',
  overscrollBehavior: 'contain',
  touchAction: 'pan-y',
  boxShadow: '-28px 0 64px rgba(2, 6, 23, 0.6)'
};
