import { cn } from '@/lib/utils';
import type { Segment } from './highlight';

/** Renders segments as text; marked runs inside `<mark>`. Nothing is interpreted as HTML. */
export function Highlighted({ segments, markClassName }: { segments: Segment[]; markClassName?: string }) {
  return (
    <>
      {segments.map((s, i) => (s.mark
        ? <mark key={i} className={cn('rounded-[3px] bg-primary/15 box-decoration-clone px-px text-foreground', markClassName)}>{s.text}</mark>
        : <span key={i}>{s.text}</span>))}
    </>
  );
}
