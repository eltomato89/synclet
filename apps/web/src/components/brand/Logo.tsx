import { cn } from '@/lib/utils';

/** The Synclet mark: two arcs and two dots, two devices kept in sync. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <g className="stroke-primary-foreground" fill="none" strokeWidth="2.4" strokeLinecap="round">
        <path d="M9.5 18.5A7 7 0 0 1 20.5 10.6" />
        <path d="M22.5 13.5A7 7 0 0 1 11.5 21.4" />
      </g>
      <g className="fill-primary-foreground">
        <circle cx="20.5" cy="10.6" r="2" />
        <circle cx="11.5" cy="21.4" r="2" />
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-[17px] leading-none font-semibold tracking-[-0.02em] text-foreground">Synclet</span>
    </span>
  );
}

/** Faint concentric rings, the mark's arcs scaled up; decorative background for auth screens. */
export function Rings({ className }: { className?: string }) {
  const radii = [120, 200, 280, 360, 440, 520];
  return (
    <svg viewBox="0 0 1200 1200" aria-hidden="true" className={cn('pointer-events-none', className)} fill="none">
      {radii.map((r, i) => (
        <circle key={r} cx="600" cy="600" r={r} stroke="currentColor" strokeWidth="1.25" opacity={1 - i * 0.13} />
      ))}
      <circle cx={600 + 280 * Math.cos(-0.9)} cy={600 + 280 * Math.sin(-0.9)} r="6" className="fill-primary" opacity="0.55" />
      <circle cx={600 + 440 * Math.cos(2.35)} cy={600 + 440 * Math.sin(2.35)} r="6" className="fill-primary" opacity="0.35" />
    </svg>
  );
}
