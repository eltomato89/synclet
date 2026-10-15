import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { ConnectionError } from '@/components/ConnectionError';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const MIN_PASSWORD = 10;

interface FieldErrors { username?: string; password?: string }

export function SetupPage() {
  const { t } = useTranslation();
  const { completeSetup, status, retry } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'error') return <ConnectionError />;
  if (status === 'authenticated' && !pending) return <Navigate to="/files" replace />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    const email = String(form.get('email') ?? '').trim();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setFieldErrors({ password: t('auth.passwordTooShort') });
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      await completeSetup({
        username: username.trim(),
        displayName: String(form.get('displayName') ?? '').trim(),
        ...(email ? { email } : {}),
        password,
      });
      navigate('/files', { replace: true });
    } catch (err) {
      setPending(false);
      if (!(err instanceof ApiError)) { setError(t('common.genericError')); return; }
      if (err.code === 'setup_done') {
        toast.info(t('auth.setupDone'));
        retry(); // re-probe: status leaves 'needs-setup', so /login no longer redirects back here
        navigate('/login', { replace: true });
      } else if (err.code === 'invalid_request') {
        setFieldErrors({ username: t('auth.usernameInvalid') });
      } else if (err.code === 'name_conflict') {
        setFieldErrors({ username: t('auth.usernameTaken') });
      } else {
        setError(t('common.genericError'));
      }
    }
  }

  const folder = username.trim() || '…';

  return (
    <AuthLayout title={t('auth.setupTitle')} description={t('auth.setupHint')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="username">{t('auth.username')}</Label>
          <Input id="username" name="username" value={username} onChange={(e) => { setUsername(e.target.value); if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined })); }}
            autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus maxLength={64}
            aria-invalid={fieldErrors.username ? true : undefined} aria-describedby="username-hint" />
          <p id="username-hint" className={cn('text-xs', fieldErrors.username ? 'text-destructive' : 'text-muted-foreground')}>
            {fieldErrors.username ?? t('auth.folderHint', { username: folder })}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="displayName">{t('auth.displayName')}</Label>
          <Input id="displayName" name="displayName" autoComplete="name" required maxLength={100} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t('auth.email')}</Label>
          <Input id="email" name="email" type="email" autoComplete="email" spellCheck={false} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t('auth.password')}</Label>
          <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200}
            aria-invalid={fieldErrors.password ? true : undefined} aria-describedby="password-hint" />
          <p id="password-hint" className={cn('text-xs', fieldErrors.password ? 'text-destructive' : 'text-muted-foreground')}>
            {fieldErrors.password ?? t('auth.passwordHint')}
          </p>
        </div>
        <FormError>{error}</FormError>
        <Button type="submit" size="lg" className="mt-1 w-full" disabled={pending}>
          {pending ? t('auth.creating') : t('auth.createAdmin')}
        </Button>
      </form>
    </AuthLayout>
  );
}
