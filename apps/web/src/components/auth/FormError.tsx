import { CircleAlert } from 'lucide-react';

export function FormError({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/8 px-3 py-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}
