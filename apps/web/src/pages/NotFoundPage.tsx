import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { LogoMark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <LogoMark className="size-9" />
        <h1 className="mt-6 text-xl font-semibold">{t('shell.notFoundTitle')}</h1>
        <p className="mt-2 text-base text-muted-foreground">{t('shell.notFoundBody')}</p>
        <Button asChild className="mt-6">
          <Link to="/files">{t('shell.notFoundBack')}</Link>
        </Button>
      </div>
    </main>
  );
}
