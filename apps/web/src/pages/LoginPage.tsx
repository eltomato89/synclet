import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ConnectionError } from '@/components/ConnectionError';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { OrDivider, SsoButton } from '@/components/auth/SsoButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  oidcStartUrl, passwordErrorKey, pendingAppLoginSso, showPasswordForm, ssoErrorKey, useLoginMethods,
} from '@/features/auth/sso';
import { useAuth } from '@/lib/auth';
import { safeNext } from '@/lib/next';

export function LoginPage() {
  const { t } = useTranslation();
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const local = params.get('local') === '1';
  const ssoError = ssoErrorKey(params.get('sso_error'));
  const methods = useLoginMethods();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // After a failed SSO started from the app login page, offer the way back to it.
  const [appLoginPath] = useState(() => (ssoError ? pendingAppLoginSso() : null));

  if (status === 'authenticated' && !pending) return <Navigate to={next} replace />;
  if (status === 'needs-setup') return <Navigate to="/setup" replace />;
  if (status === 'error') return <ConnectionError />;
  if (status === 'loading' || methods.isPending) return <FullPageSpinner />;

  const oidc = methods.data?.oidc.enabled ? methods.data.oidc : null;
  const password = showPasswordForm(methods.data, local);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setPending(true);
    try {
      await login(String(form.get('login') ?? '').trim(), String(form.get('password') ?? ''));
      navigate(next, { replace: true });
    } catch (err) {
      setError(t(passwordErrorKey(err)));
      setPending(false);
    }
  }

  return (
    <AuthLayout title={t('auth.loginTitle')}>
      <div className="flex flex-col gap-5">
        {ssoError && (
          <div className="flex flex-col gap-2">
            <FormError>{t(ssoError)}</FormError>
            {appLoginPath && (
              <Link to={appLoginPath} className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline">
                {t('sso.backToAppLogin')}
              </Link>
            )}
          </div>
        )}
        {oidc && <SsoButton href={oidcStartUrl(next)} label={oidc.label} primary={!local} />}
        {oidc && !password && <p className="text-sm text-muted-foreground">{t('sso.redirectHint')}</p>}
        {oidc && password && <OrDivider />}
        {password && (
          <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="login">{t('auth.login')}</Label>
              <Input id="login" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required
                autoFocus={!oidc || local} aria-invalid={error ? true : undefined} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <PasswordInput id="password" name="password" autoComplete="current-password" required
                aria-invalid={error ? true : undefined} />
            </div>
            <FormError>{error}</FormError>
            <Button type="submit" size="lg" variant={oidc && !local ? 'outline' : 'default'} className="mt-1 w-full" disabled={pending}>
              {pending ? t('auth.submitting') : t('auth.submit')}
            </Button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
