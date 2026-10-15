import { X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { SsoError } from './forms';

export const notify = {
  success: (msg: string) => toast.success(msg, { position: 'bottom-center' }),
  error: (msg: string) => toast.error(msg, { position: 'bottom-center' }),
};

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity],
];

/** "3 hours ago" / "in 5 days". */
export function formatRelative(iso: string, locale: string, now: number = Date.now()): string {
  let v = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return rtf.format(Math.round(v), 'year');
}

/** Browser and OS from a user agent (either may be null). */
export function parseUserAgent(ua: string | null): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null };
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : /^Synclet/i.test(ua) ? 'Synclet'
              : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux'
            : null;
  return { browser, os };
}

/** "Firefox on macOS", or the raw user agent, or "Unknown client". */
export function useDescribeUserAgent() {
  const { t } = useTranslation();
  return (ua: string | null): string => {
    const { browser, os } = parseUserAgent(ua);
    if (browser && os) return t('admin.detail.uaOn', { browser, os });
    return browser ?? os ?? ua ?? t('admin.detail.uaUnknown');
  };
}

/** A titled block of the admin pages: heading + one-line description on the left, content below. */
export function Section({ title, description, actions, children, className, id }: {
  title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('py-6 first:pt-0', className)}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 id={id} className="text-lg font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 max-w-[68ch] text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function FieldError({ id, error }: { id: string; error: SsoError | undefined }) {
  const { t } = useTranslation();
  if (!error) return null;
  const text = typeof error === 'string' ? t(error) : 'raw' in error ? error.raw : t(error.key, error.values);
  return <p id={id} className="mt-1.5 text-xs text-destructive">{text}</p>;
}

/**
 * Free-form list input (groups, CIDRs): Enter, comma or Tab adds the typed value, Backspace on
 * an empty field removes the last one, pasted lists are split on commas, spaces and newlines.
 */
export function TagInput({ id, value, onChange, placeholder, invalid, describedBy, splitOnSpace = false }: {
  id: string;
  value: string[];
  onChange(next: string[]): void;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  /** Groups may contain spaces; CIDRs may not. */
  splitOnSpace?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const sep = splitOnSpace ? /[\s,;]+/ : /[,;\n\r\t]+/;
  const add = (raw: string) => {
    const parts = raw.split(sep).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
  };
  const commit = () => { if (draft.trim()) { add(draft); setDraft(''); } };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && draft.trim()) || (splitOnSpace && e.key === ' ')) {
      if (draft.trim() || e.key === 'Enter' || e.key === ',') e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (sep.test(text)) { e.preventDefault(); add(draft + text); setDraft(''); }
  };
  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input px-1.5 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        invalid && 'border-destructive ring-3 ring-destructive/20',
      )}
    >
      {value.map((v) => (
        <span key={v} className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-sm bg-muted pr-0.5 pl-2 text-sm text-foreground">
          <span className="truncate">{v}</span>
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== v))}
            aria-label={t('admin.tags.remove', { value: v })}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commit}
        placeholder={value.length ? undefined : placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="h-7 min-w-24 flex-1 bg-transparent px-1 text-[16px] outline-none placeholder:text-muted-foreground md:text-base"
      />
    </div>
  );
}

/** Native select styled like <Input>. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 rounded-md border border-input bg-background px-2 pr-7 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30',
        className,
      )}
      {...props}
    />
  );
}
