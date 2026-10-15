import { useQuery } from '@tanstack/react-query';
import { AppWindow, Laptop, Lock, RotateCw, Smartphone } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { OrDivider, SsoButton } from '@/components/auth/SsoButton';
import { LogoMark } from '@/components/brand/Logo';
import { ConnectionError } from '@/components/ConnectionError';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, isTransientError, refreshSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { initials } from '@/lib/utils';
import {
  type AppLoginParams, appHandoff, appLoginPath, appRedirectUrl, fetchAppClient, oidcStartUrl, parseAppLoginParams,
  passwordErrorKey, pendingAppLoginSso, rememberAppLoginSso, showPasswordForm, useLoginMethods, type ValidatedAppClient,
} from './sso';

/**
 * Browser sign-in of the native apps (OAuth 2.0 Authorization Code + PKCE). The app opens
 * `/app-login?client_id&redirect_uri&code_challenge&code_challenge_method=S256&state[&login_hint]`;
 * after the user signs in (password, SSO or the current web session) the page sends a one-time code
 * to the redirect URI. Nothing is ever sent to a redirect URI the server has not confirmed for the client.
 */
export function AppLoginPage() {
  const [q] = useSearchParams();
  const params = useMemo(() => parseAppLoginParams(q), [q]);
  if (!params) return <AppLoginProblem message="appLogin.invalidLink" />;
  return <AppLogin params={params} />;
}

function AppLogin({ params }: { params: AppLoginParams }) {
  const [q] = useSearchParams();
  const client = useQuery({
    queryKey: ['auth', 'app-client', params.clientId, params.redirectUri],
    queryFn: ({ signal }) => fetchAppClient(params, signal),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const methods = useLoginMethods();
  const { status } = useAuth();

  if (client.isError) {
    return isTransientError(client.error)
      ? <AppLoginProblem message="appLogin.unreachable" onRetry={() => void client.refetch()} />
      : <AppLoginProblem message="appLogin.invalidClient" />;
  }
  if (status === 'error') return <ConnectionError />;
  if (client.isPending || methods.isPending || status === 'loading') return <FullPageSpinner />;
  return <AppLoginForm params={params} client={client.data} local={q.get('local') === '1'} />;
}

type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; url: string };

function AppLoginForm({ params, client, local }: { params: AppLoginParams; client: ValidatedAppClient; local: boolean }) {
  const { t } = useTranslation();
  const { status, user } = useAuth();
  const methods = useLoginMethods();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [otherAccount, setOtherAccount] = useState(false);
  const signedIn = status === 'authenticated' && user !== null;

  const handOff = useCallback((code: string) => {
    const url = appRedirectUrl(client, code, params.state);
    setPhase({ kind: 'done', url });
    appHandoff.go(url);
  }, [client, params.state]);

  const pkce = useMemo(() => ({
    clientId: params.clientId, redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge, codeChallengeMethod: params.codeChallengeMethod,
  }), [params]);

  const continueWithSession = useCallback(async () => {
    setError(null);
    setPhase({ kind: 'busy' });
    const authorize = () => api<{ code: string }>('/auth/app/authorize/session', { method: 'POST', json: pkce });
    try {
      let res: { code: string };
      try {
        res = await authorize();
      } catch (e) {
        // `/auth/*` calls are not refreshed automatically; the access token may have expired.
        if (!(e instanceof ApiError && e.status === 401) || !(await refreshSession())) throw e;
        res = await authorize();
      }
      handOff(res.code);
    } catch (e) {
      setError(t(e instanceof ApiError && e.status === 401 ? 'appLogin.sessionExpired' : 'common.genericError'));
      setPhase({ kind: 'idle' });
    }
  }, [handOff, pkce, t]);

  // Back from an SSO round trip that this tab started for this very request: continue right away.
  const autoContinued = useRef(false);
  useEffect(() => {
    if (!signedIn || autoContinued.current) return;
    if (pendingAppLoginSso() !== appLoginPath(params)) return;
    autoContinued.current = true;
    pendingAppLoginSso(true);
    void continueWithSession();
  }, [signedIn, params, continueWithSession]);

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    setPhase({ kind: 'busy' });
    try {
      const res = await api<{ code: string }>('/auth/app/authorize', {
        method: 'POST',
        json: { login: String(form.get('login') ?? '').trim(), password: String(form.get('password') ?? ''), ...pkce },
      });
      handOff(res.code);
    } catch (err) {
      setError(t(passwordErrorKey(err)));
      setPhase({ kind: 'idle' });
    }
  }

  if (phase.kind === 'done') {
    return (
      <AuthLayout title={t('appLogin.doneTitle')}>
        <div className="flex flex-col gap-5">
          <p className="text-base text-muted-foreground">{t('appLogin.doneBody', { app: client.name })}</p>
          <Button asChild size="lg" className="w-full">
            <a href={phase.url}>{t('appLogin.openApp')}</a>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const busy = phase.kind === 'busy';
  const oidc = methods.data?.oidc.enabled ? methods.data.oidc : null;
  const password = showPasswordForm(methods.data, local);
  const host = window.location.host;

  return (
    <AuthLayout title={t('appLogin.title', { name: client.name })}>
      <Handoff client={client} host={host} />
      <p className="mt-5 text-base text-muted-foreground">{t('appLogin.explain', { app: client.name, host })}</p>
      <div className="mt-5 flex flex-col gap-5">
        <FormError>{error}</FormError>
        {signedIn && !otherAccount ? (
          <>
            <div className="flex items-center gap-3">
              <Avatar className="size-9 rounded-md">
                <AvatarFallback className="rounded-md bg-accent-soft text-xs font-semibold text-primary">
                  {initials(user.displayName || user.username)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{user.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">{user.username}</span>
              </span>
            </div>
            <Button size="lg" className="w-full" disabled={busy} onClick={() => void continueWithSession()}>
              {busy ? t('appLogin.connecting') : t('appLogin.continueAs', { name: user.displayName || user.username })}
            </Button>
            <Button variant="ghost" className="self-center" disabled={busy} onClick={() => { setError(null); setOtherAccount(true); }}>
              {t('appLogin.otherAccount')}
            </Button>
          </>
        ) : (
          <>
            {oidc && (
              <SsoButton href={oidcStartUrl(appLoginPath(params))} label={oidc.label} primary={!local}
                onNavigate={() => rememberAppLoginSso(params)} />
            )}
            {oidc && password && <OrDivider />}
            {password && (
              <form onSubmit={onPassword} className="flex flex-col gap-5" noValidate>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="login">{t('auth.login')}</Label>
                  <Input id="login" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required
                    defaultValue={params.loginHint} autoFocus={(!oidc || local) && !params.loginHint} aria-invalid={error ? true : undefined} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <PasswordInput id="password" name="password" autoComplete="current-password" required
                    autoFocus={(!oidc || local) && !!params.loginHint} aria-invalid={error ? true : undefined} />
                </div>
                <Button type="submit" size="lg" variant={oidc && !local ? 'outline' : 'default'} className="mt-1 w-full" disabled={busy}>
                  {busy ? t('appLogin.connecting') : t('auth.submit')}
                </Button>
              </form>
            )}
            {signedIn && (
              <Button variant="ghost" className="self-center" disabled={busy} onClick={() => { setError(null); setOtherAccount(false); }}>
                {t('appLogin.backToCurrent', { name: user.displayName || user.username })}
              </Button>
            )}
          </>
        )}
      </div>
    </AuthLayout>
  );
}

function DeviceIcon({ clientId }: { clientId: string }) {
  const Icon = clientId === 'ios' || clientId === 'android' ? Smartphone
    : clientId === 'macos' || clientId === 'windows' || clientId === 'linux' ? Laptop : AppWindow;
  return <Icon className="size-5 text-foreground" aria-hidden="true" />;
}

/** The two ends of the connection being made: the requesting app and this server. */
function Handoff({ client, host }: { client: ValidatedAppClient; host: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2" aria-hidden="true">
      <div className="flex min-w-0 flex-col items-center gap-2 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border bg-canvas">
          <DeviceIcon clientId={client.id} />
        </span>
        <span className="text-xs leading-4 text-muted-foreground">{client.name}</span>
      </div>
      <div className="flex h-11 w-14 items-center sm:w-20">
        <span className="size-1.5 rounded-full bg-primary/70" />
        <span className="h-0 flex-1 border-t-2 border-dotted border-primary/40" />
        <span className="size-1.5 rounded-full bg-primary/70" />
      </div>
      <div className="flex min-w-0 flex-col items-center gap-2 text-center">
        <LogoMark className="size-11 rounded-xl" />
        <span className="flex max-w-full items-center gap-1 text-xs leading-4 font-medium text-foreground">
          <Lock className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{host}</span>
        </span>
      </div>
    </div>
  );
}

/** Invalid or unusable request: explain, never redirect. */
function AppLoginProblem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <AuthLayout title={t('appLogin.problemTitle')}>
      <div className="flex flex-col gap-5" role="alert">
        <p className="text-base text-muted-foreground">{t(message)}</p>
        {onRetry && (
          <Button variant="outline" className="self-start" onClick={onRetry}>
            <RotateCw />
            {t('common.retry')}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
