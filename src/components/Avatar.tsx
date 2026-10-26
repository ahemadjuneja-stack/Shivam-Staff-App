// PROFILE AVATAR (Boss order 2026-10-27: "har jaga jaha unka naam aata hai
// waha DP bhi show hona chahiye"): photo ho to image, warna initials circle.
// Har naam-display ke saath yahi component use hota hai.
export default function Avatar({
  photo,
  name,
  size = 40,
  className = ''
}: {
  photo?: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const initials =
    (name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || '?';
  if (photo) {
    return (
      <img
        src={photo}
        alt={name}
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-full border border-white/15 bg-[#0B1526] object-cover ${className}`}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38) }}
      className={`flex shrink-0 items-center justify-center rounded-full border border-white/15 bg-gradient-to-br from-indigo-500/45 to-sky-500/30 font-bold text-slate-100 ${className}`}
    >
      {initials}
    </div>
  );
}
