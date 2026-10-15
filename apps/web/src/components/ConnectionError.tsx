import { RotateCw, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

/** Shown when the initial session check failed for transient reasons (network / 5xx). */
export function ConnectionError() {
  const { t } = useTranslation();
  const { retry } = useAuth();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm" role="alert">
        <ServerOff className="size-6 text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold">{t('common.connectionErrorTitle')}</h1>
        <p className="mt-2 text-base text-muted-foreground">{t('common.connectionErrorBody')}</p>
        <Button className="mt-6" onClick={retry}>
          <RotateCw />
          {t('common.retry')}
        </Button>
      </div>
    </main>
  );
}
