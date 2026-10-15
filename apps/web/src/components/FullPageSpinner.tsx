import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function FullPageSpinner() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas" role="status">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}
