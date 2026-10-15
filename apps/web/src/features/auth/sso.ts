import type { LoginMethods } from '@synclet/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';

// ---------------------------------------------------------------------------------------------
// Login methods and OIDC
// ---------------------------------------------------------------------------------------------

/** Login methods of this server (`GET /auth/methods`); public, read on every login page load. */
export function useLoginMethods() {
  return useQuery({
    queryKey: ['auth', 'methods'],
    queryFn: () => api<LoginMethods>('/auth/methods'),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Whether the password form is offered. Hidden only when single sign-on replaces it; `?local=1`
 * brings it back for administrators (the server allows admins a password login in any case). When
 * the methods cannot be loaded, or no other interactive method exists, the form stays, so nobody is
 * locked out by the UI.
 */
export function showPasswordForm(methods: LoginMethods | undefined, local: boolean): boolean {
  if (!methods || local) return true;
  return methods.password || !methods.oidc.enabled;
}

/** Starts the OIDC login; after it the server redirects to `returnPath` (validated again there). */
export function oidcStartUrl(returnPath: string): string {
  return `/api/auth/oidc/start?return=${encodeURIComponent(returnPath)}`;
}

/** Codes of the server's `/login?sso_error=<code>` redirects (see `apps/server/src/sso/oidc.service.ts`). */
export const SSO_ERROR_CODES = [
  'oidc_disabled', 'idp_unavailable', 'invalid_state', 'idp_error', 'oidc_failed',
  'sso_not_allowed', 'unauthorized', 'rate_limited', 'server_error',
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

/** i18n key of the message for an `sso_error` query value; unknown codes get a generic message. */
export function ssoErrorKey(code: string | null): string | null {
  if (!code) return null;
  return (SSO_ERROR_CODES as readonly string[]).includes(code) ? `sso.error.${code}` : 'sso.error.server_error';
}

/** i18n key for a failed password login (web login and app login share the error codes). */
export function passwordErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'password_login_disabled') return 'sso.passwordDisabled';
    if (err.code === 'rate_limited') return 'sso.error.rate_limited';
    if (err.status === 401 || err.status === 400) return 'auth.invalid';
  }
  return 'common.genericError';
}

// ---------------------------------------------------------------------------------------------
// App login (OAuth 2.0 Authorization Code + PKCE for the native apps)
// ---------------------------------------------------------------------------------------------

export interface AppLoginParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
  loginHint: string;
}

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE = 1024;

/**
 * Reads `/app-login` query parameters. Only shape checks: the client and redirect URI pair is
 * confirmed by the server (`/auth/app/client`) before anything is sent to the redirect URI.
 */
export function parseAppLoginParams(q: URLSearchParams): AppLoginParams | null {
  const clientId = q.get('client_id') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const codeChallenge = q.get('code_challenge') ?? '';
  const method = q.get('code_challenge_method');
  const state = q.get('state') ?? '';
  if (!clientId || clientId.length > 40) return null;
  if (!redirectUri || redirectUri.length > 200) return null;
  if (!CODE_CHALLENGE.test(codeChallenge) || method !== 'S256') return null;
  if (!state || state.length > MAX_STATE) return null;
  return { clientId, redirectUri, codeChallenge, codeChallengeMethod: 'S256', state, loginHint: (q.get('login_hint') ?? '').slice(0, 320) };
}

/** `/app-login?…` with the given parameters, e.g. as the return path after an OIDC login. */
export function appLoginPath(p: AppLoginParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod, state: p.state,
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `/app-login?${q}`;
}

/** A client the server confirmed for exactly this redirect URI (`GET /auth/app/client`). */
export interface ValidatedAppClient { id: string; name: string; redirectUri: string }

/**
 * The URL that hands the authorization code back to the app: the validated redirect URI with
 * `code` and `state` added as (encoded) query parameters.
 */
export function appRedirectUrl(client: ValidatedAppClient, code: string, state: string): string {
  const url = new URL(client.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function fetchAppClient(p: AppLoginParams, signal?: AbortSignal): Promise<ValidatedAppClient> {
  const q = new URLSearchParams({ clientId: p.clientId, redirectUri: p.redirectUri });
  const c = await api<{ id: string; name: string }>(`/auth/app/client?${q}`, { signal });
  return { id: c.id, name: c.name, redirectUri: p.redirectUri };
}

// An SSO round trip started from /app-login. Remembered per tab (sessionStorage survives the trip
// to the identity provider) so that, on return, the page continues automatically only for the
// sign-in this tab started, and the login page can offer the way back after an SSO error. A link
// that merely claims to come back from SSO still needs an explicit "continue" click.
const PENDING_KEY = 'synclet-app-login-sso';
const PENDING_TTL_MS = 15 * 60_000;

export function rememberAppLoginSso(p: AppLoginParams) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ path: appLoginPath(p), at: Date.now() }));
  } catch { /* storage unavailable: the user continues with one more click */ }
}

/** The pending app-login path of this tab, if recent; `consume` removes it. */
export function pendingAppLoginSso(consume = false): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    if (consume) sessionStorage.removeItem(PENDING_KEY);
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof v.path !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > PENDING_TTL_MS) return null;
    if (!v.path.startsWith('/app-login?')) return null;
    return v.path;
  } catch {
    return null;
  }
}

/** Leaves the page for the app (indirection for tests; jsdom cannot navigate to custom schemes). */
export const appHandoff = {
  go(url: string) { window.location.replace(url); },
};
