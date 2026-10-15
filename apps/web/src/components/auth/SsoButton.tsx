import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Single sign-on: a plain link, the browser leaves for the identity provider. */
export function SsoButton({ href, label, primary = true, onNavigate }: {
  href: string; label: string; primary?: boolean; onNavigate?: () => void;
}) {
  return (
    <Button asChild size="lg" variant={primary ? 'default' : 'outline'} className="w-full">
      <a href={href} onClick={onNavigate}>
        <KeyRound aria-hidden="true" />
        {label}
      </a>
    </Button>
  );
}

/** Separates the single sign-on button from the password form. */
export function OrDivider() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {t('sso.orPassword')}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
