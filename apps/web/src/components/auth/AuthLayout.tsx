import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Rings, Wordmark } from '@/components/brand/Logo';

/** Shared frame for setup and login: wordmark, left-aligned heading, one Paper panel, rings behind. */
export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-canvas">
      <Rings className="absolute top-1/2 left-1/2 w-[max(1100px,140vmin)] -translate-x-[18%] -translate-y-[62%] text-border" />
      <header className="relative px-5 pt-5 sm:px-8 sm:pt-7">
        <Wordmark />
      </header>
      <main className="relative flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
          {description && <p className="mt-2 text-base text-muted-foreground">{description}</p>}
          <div className="mt-7 rounded-xl border bg-background p-5 sm:p-7">{children}</div>
        </div>
      </main>
      <footer className="relative flex items-center gap-2 px-5 pb-5 text-xs text-muted-foreground sm:px-8 sm:pb-7">
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        {t('auth.selfHosted')}
      </footer>
    </div>
  );
}
