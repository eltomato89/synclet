import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { json, methods, routeFetch, unauthorized } from '@/test/fetch';

let authMod: typeof import('@/lib/auth');
let LoginPage: typeof import('@/pages/LoginPage').LoginPage;

beforeEach(async () => {
  vi.resetModules();
  authMod = await import('@/lib/auth');
  ({ LoginPage } = await import('@/pages/LoginPage'));
  await i18n.changeLanguage('en');
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const anonymous = { 'GET /api/setup/status': json(200, { needsSetup: false }), 'POST /api/auth/refresh': unauthorized() };

function renderLogin(entry: string) {
  const router = createMemoryRouter(
    [{ path: '/login', element: <LoginPage /> }, { path: '/app-login', element: <p>app-login-route</p> }, { path: '*', element: <p>target</p> }],
    { initialEntries: [entry] },
  );
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><authMod.AuthProvider><RouterProvider router={router} /></authMod.AuthProvider></Wrapper>);
  return router;
}

describe('LoginPage login methods', () => {
  it('offers SSO (label from the settings, returning to `next`) and the password form', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'Sign in with Authentik' } }) });
    renderLogin('/login?next=%2Ffiles%2Fabc');
    const sso = await screen.findByRole('link', { name: 'Sign in with Authentik' });
    expect(sso).toHaveAttribute('href', '/api/auth/oidc/start?return=%2Ffiles%2Fabc');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('never passes an unsafe `next` on to the OIDC start', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin('/login?next=%2F%2Fevil.example');
    expect(await screen.findByRole('link', { name: 'SSO' })).toHaveAttribute('href', '/api/auth/oidc/start?return=%2Ffiles');
  });

  it('hides the password form when SSO replaces it', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ password: false, oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin('/login');
    expect(await screen.findByRole('link', { name: 'SSO' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('links to the password form (?local=1, keeping next) when SSO replaces it', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ password: false, oidc: { enabled: true, label: 'SSO' } }) });
    const router = renderLogin('/login?next=%2Ffiles%2Fabc');
    const link = await screen.findByRole('link', { name: 'Sign in with password' });
    expect(link).toHaveAttribute('href', '/login?next=%2Ffiles%2Fabc&local=1');
    fireEvent.click(link);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Ffiles%2Fabc&local=1');
    expect(screen.queryByRole('link', { name: 'Sign in with password' })).not.toBeInTheDocument();
  });

  it('shows the password form for ?local=1', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ password: false, oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin('/login?local=1');
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SSO' })).toBeInTheDocument();
  });

  it('shows only the password form without SSO', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods() });
    renderLogin('/login');
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the password form when the methods cannot be loaded', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': json(500, {}) });
    renderLogin('/login');
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('explains a disabled password login', async () => {
    routeFetch({
      ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }),
      'POST /api/auth/login': json(403, { statusCode: 403, code: 'password_login_disabled', message: 'x' }),
    });
    renderLogin('/login');
    fireEvent.change(await screen.findByLabelText('Username or email'), { target: { value: 'anna' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password sign-in is turned off');
  });
});

describe('LoginPage sso_error', () => {
  it.each([
    ['sso_not_allowed', "isn't allowed to use Synclet"],
    ['invalid_state', 'took too long'],
    ['idp_unavailable', "can't be reached"],
    ['bogus', 'server error'],
  ])('shows a friendly message for %s', async (code, text) => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin(`/login?sso_error=${code}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('offers the way back to the app sign-in after a failed SSO started there', async () => {
    sessionStorage.setItem('synclet-app-login-sso', JSON.stringify({ path: '/app-login?client_id=ios', at: Date.now() }));
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin('/login?sso_error=idp_error');
    expect(await screen.findByRole('link', { name: 'Back to the app sign-in' })).toHaveAttribute('href', '/app-login?client_id=ios');
  });

  it('uses the next path from the server when the tab has no marker, and keeps it for SSO', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin(`/login?sso_error=idp_error&next=${encodeURIComponent('/app-login?client_id=ios&state=s')}`);
    expect(await screen.findByRole('link', { name: 'Back to the app sign-in' })).toHaveAttribute('href', '/app-login?client_id=ios&state=s');
    expect(screen.getByRole('link', { name: 'SSO' })).toHaveAttribute('href', `/api/auth/oidc/start?return=${encodeURIComponent('/app-login?client_id=ios&state=s')}`);
  });

  it('offers no way back for a next that is not an app sign-in or not same-origin', async () => {
    routeFetch({ ...anonymous, 'GET /api/auth/methods': methods({ oidc: { enabled: true, label: 'SSO' } }) });
    renderLogin(`/login?sso_error=idp_error&next=${encodeURIComponent('//evil.example/app-login?x')}`);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to the app sign-in' })).not.toBeInTheDocument();
  });
});
