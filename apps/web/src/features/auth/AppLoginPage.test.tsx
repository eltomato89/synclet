import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { AUTH, json, methods, routeFetch, unauthorized } from '@/test/fetch';

let authMod: typeof import('@/lib/auth');
let page: typeof import('./AppLoginPage');
let sso: typeof import('./sso');
let go: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(async () => {
  vi.resetModules();
  authMod = await import('@/lib/auth');
  page = await import('./AppLoginPage');
  sso = await import('./sso');
  go = vi.fn<(url: string) => void>();
  sso.appHandoff.go = go;
  await i18n.changeLanguage('en');
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = 'st/ä &x=1';
const query = (o: Record<string, string> = {}) => new URLSearchParams({
  client_id: 'ios', redirect_uri: 'synclet://oauth', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE, ...o,
}).toString();
const IOS = json(200, { id: 'ios', name: 'Synclet for iPhone and iPad' });
const setup = { 'GET /api/setup/status': json(200, { needsSetup: false }) };
const anonymous = { ...setup, 'POST /api/auth/refresh': unauthorized(), 'GET /api/auth/methods': methods() };
const signedIn = { ...setup, 'POST /api/auth/refresh': json(200, AUTH), 'GET /api/auth/methods': methods() };

function renderAt(search: string) {
  const router = createMemoryRouter([{ path: '/app-login', element: <page.AppLoginPage /> }], { initialEntries: [`/app-login?${search}`] });
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><authMod.AuthProvider><RouterProvider router={router} /></authMod.AuthProvider></Wrapper>);
}

async function submitPassword() {
  fireEvent.change(await screen.findByLabelText('Username or email'), { target: { value: ' anna ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('AppLoginPage parameter validation', () => {
  it.each([
    ['missing state', query({ state: '' })],
    ['plain PKCE', query({ code_challenge_method: 'plain' })],
    ['bad challenge', query({ code_challenge: 'abc' })],
    ['no client', query({ client_id: '' })],
  ])('rejects %s without contacting the server about the client', async (_n, search) => {
    const f = routeFetch({ ...anonymous, 'GET /api/auth/app/client': IOS });
    renderAt(search);
    expect(await screen.findByText(/sign-in link is incomplete/)).toBeInTheDocument();
    expect(f.count('GET /api/auth/app/client')).toBe(0);
    expect(go).not.toHaveBeenCalled();
  });

  it('shows an error and never redirects when the server rejects the client/redirect pair', async () => {
    const f = routeFetch({
      ...anonymous,
      'GET /api/auth/app/client': json(400, { statusCode: 400, code: 'invalid_request', message: 'this app is not allowed to sign in' }),
      'POST /api/auth/app/authorize': json(200, { code: 'c' }),
    });
    renderAt(query({ redirect_uri: 'https://evil.example/cb' }));
    expect(await screen.findByText(/isn't allowed to sign in to this server/)).toBeInTheDocument();
    expect(f.calls.find((c) => c.path.startsWith('/api/auth/app/client'))?.path)
      .toBe('/api/auth/app/client?clientId=ios&redirectUri=https%3A%2F%2Fevil.example%2Fcb');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(f.count('POST /api/auth/app/authorize')).toBe(0);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('AppLoginPage password sign-in', () => {
  it('names the app, authorizes with the PKCE parameters and redirects with code and state', async () => {
    const f = routeFetch({ ...anonymous, 'GET /api/auth/app/client': IOS, 'POST /api/auth/app/authorize': json(200, { code: 'co/de+1' }) });
    renderAt(query({ login_hint: 'anna@example.com' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Synclet for Synclet for iPhone and iPad' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username or email')).toHaveValue('anna@example.com');
    await submitPassword();
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(f.calls.find((c) => c.path === '/api/auth/app/authorize')?.body).toEqual({
      login: 'anna', password: 'secret-secret', clientId: 'ios', redirectUri: 'synclet://oauth',
      codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
    });
    const url = go.mock.calls[0][0] as string;
    expect(url).toBe('synclet://oauth?code=co%2Fde%2B1&state=st%2F%C3%A4+%26x%3D1');
    expect(new URL(url).searchParams.get('state')).toBe(STATE);
    expect(await screen.findByRole('link', { name: 'Open app' })).toHaveAttribute('href', url);
  });

  it('redirects to a confirmed loopback URI', async () => {
    routeFetch({
      ...anonymous, 'GET /api/auth/app/client': json(200, { id: 'linux', name: 'Synclet for Linux' }),
      'POST /api/auth/app/authorize': json(200, { code: 'abc' }),
    });
    renderAt(query({ client_id: 'linux', redirect_uri: 'http://127.0.0.1:53682/callback', state: 's1' }));
    await submitPassword();
    await waitFor(() => expect(go).toHaveBeenCalledWith('http://127.0.0.1:53682/callback?code=abc&state=s1'));
  });

  it('stays on the page with a message for wrong credentials', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/app/client': IOS, 'POST /api/auth/app/authorize': unauthorized() });
    renderAt(query());
    await submitPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password');
    expect(go).not.toHaveBeenCalled();
  });
});

describe('AppLoginPage with a web session or SSO', () => {
  it('continues with the current account', async () => {
    const f = routeFetch({ ...signedIn, 'GET /api/auth/app/client': IOS, 'POST /api/auth/app/authorize/session': json(200, { code: 'k' }) });
    renderAt(query());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as Jens Köhler' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(`synclet://oauth?code=k&state=${new URLSearchParams({ s: STATE }).toString().slice(2)}`));
    const call = f.calls.find((c) => c.path === '/api/auth/app/authorize/session')!;
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.body).toEqual({ clientId: 'ios', redirectUri: 'synclet://oauth', codeChallenge: CHALLENGE, codeChallengeMethod: 'S256' });
  });

  it('does not continue on its own for a link that merely arrives with a session', async () => {
    const f = routeFetch({ ...signedIn, 'GET /api/auth/app/client': IOS, 'POST /api/auth/app/authorize/session': json(200, { code: 'k' }) });
    renderAt(query());
    expect(await screen.findByRole('button', { name: 'Continue as Jens Köhler' })).toBeInTheDocument();
    expect(f.count('POST /api/auth/app/authorize/session')).toBe(0);
    expect(go).not.toHaveBeenCalled();
  });

  it('offers SSO returning to this request, and continues automatically after the round trip', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ password: false, oidc: { enabled: true, label: 'Company login' } }), 'GET /api/auth/app/client': IOS });
    renderAt(query());
    const link = await screen.findByRole('link', { name: 'Company login' });
    const ret = new URL(link.getAttribute('href')!, 'http://x').searchParams.get('return')!;
    expect(ret.startsWith('/app-login?')).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(ret.split('?')[1]))).toEqual({
      client_id: 'ios', redirect_uri: 'synclet://oauth', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE,
    });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    link.addEventListener('click', (e) => e.preventDefault()); // jsdom does not navigate
    fireEvent.click(link);
    expect(sso.pendingAppLoginSso()).toBe(ret);

    // Back from the identity provider with a fresh web session (new page load).
    vi.restoreAllMocks();
    vi.resetModules();
    authMod = await import('@/lib/auth');
    page = await import('./AppLoginPage');
    sso = await import('./sso');
    sso.appHandoff.go = go;
    document.body.innerHTML = '';
    const f = routeFetch({ ...signedIn, 'GET /api/auth/app/client': IOS, 'POST /api/auth/app/authorize/session': json(200, { code: 'sso' }) });
    renderAt(ret.split('?')[1]);
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(go.mock.calls[0][0]).toMatch(/^synclet:\/\/oauth\?code=sso&state=/);
    expect(f.count('POST /api/auth/app/authorize/session')).toBe(1);
    expect(sso.pendingAppLoginSso()).toBeNull(); // consumed
  });

  it('lets a signed-in user pick a different account', async () => {
    routeFetch({ ...signedIn, 'GET /api/auth/app/client': IOS });
    renderAt(query());
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different account' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue as Jens Köhler instead' })).toBeInTheDocument();
  });
});
