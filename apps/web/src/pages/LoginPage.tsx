import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ConnectionError } from '@/components/ConnectionError';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { safeNext } from '@/lib/next';

export function LoginPage() {
  const { t } = useTranslation();
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (status === 'authenticated' && !pending) return <Navigate to={next} replace />;
  if (status === 'needs-setup') return <Navigate to="/setup" replace />;
  if (status === 'error') return <ConnectionError />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setPending(true);
    try {
      await login(String(form.get('login') ?? '').trim(), String(form.get('password') ?? ''));
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 401 || err.status === 400) ? t('auth.invalid') : t('common.genericError'));
      setPending(false);
    }
  }

  return (
    <AuthLayout title={t('auth.loginTitle')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="login">{t('auth.login')}</Label>
          <Input id="login" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus
            aria-invalid={error ? true : undefined} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t('auth.password')}</Label>
          <PasswordInput id="password" name="password" autoComplete="current-password" required
            aria-invalid={error ? true : undefined} />
        </div>
        <FormError>{error}</FormError>
        <Button type="submit" size="lg" className="mt-1 w-full" disabled={pending}>
          {pending ? t('auth.submitting') : t('auth.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
