import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Strip above a folder the user can only read (a space with the `read` role, or a read-only storage). */
export function ReadOnlyBanner() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t('spaces.readOnly')}
      className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground md:px-6"
    >
      <Lock aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium text-foreground">{t('spaces.readOnly')}</span>
      <span className="truncate max-sm:hidden">{t('spaces.readOnlyBody')}</span>
    </div>
  );
}
