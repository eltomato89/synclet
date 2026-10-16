import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { AUTH, json, methods, routeFetch, unauthorized } from '@/test/fetch';

let authMod: typeof import('./auth');

beforeEach(async () => {
  vi.resetModules();
  authMod = await import('./auth');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Status() {
  const { status, retry } = authMod.useAuth();
  return <button onClick={retry}>{status}</button>;
}

describe('initial session probe', () => {
  it('shows a retry state (not anonymous) when the server is unreachable, and recovers on retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('error')).toBeInTheDocument();

    fetchMock
      .mockResolvedValueOnce(json(200, { needsSetup: false }))
      .mockResolvedValueOnce(json(200, { accessToken: 't', user: { id: 'u1', username: 'jens', displayName: 'Jens', email: null, role: 'admin' } }));
    await act(async () => { screen.getByText('error').click(); });
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
  });

  it('treats 5xx from /auth/refresh as error, not as logged out', async () => {
    routeFetch({ 'GET /api/setup/status': json(200, { needsSetup: false }), 'POST /api/auth/refresh': new Response('', { status: 502 }) });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('reports anonymous when refresh returns 401', async () => {
    routeFetch({ 'GET /api/setup/status': json(200, { needsSetup: false }), 'POST /api/auth/refresh': unauthorized(), 'GET /api/auth/methods': methods() });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
  });
});

describe('forward-auth bootstrap', () => {
  const base = { 'GET /api/setup/status': json(200, { needsSetup: false }) };

  it('signs in through the proxy when the refresh probe found no session', async () => {
    const f = routeFetch({
      ...base, 'POST /api/auth/refresh': unauthorized(), 'GET /api/auth/methods': methods({ forwardAuth: true }),
      'POST /api/auth/forward': json(200, AUTH),
    });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/setup/status', 'POST /api/auth/refresh', 'GET /api/auth/methods', 'POST /api/auth/forward',
    ]);
  });

  it('does not create a new session when the refresh cookie still works', async () => {
    const f = routeFetch({ ...base, 'POST /api/auth/refresh': json(200, AUTH), 'POST /api/auth/forward': json(200, AUTH) });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(f.count('POST /api/auth/forward')).toBe(0);
    expect(f.count('GET /api/auth/methods')).toBe(0);
  });

  it('stays anonymous without calling the proxy endpoint when forward-auth is off', async () => {
    const f = routeFetch({ ...base, 'POST /api/auth/refresh': unauthorized(), 'GET /api/auth/methods': methods(), 'POST /api/auth/forward': json(200, AUTH) });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(f.count('POST /api/auth/forward')).toBe(0);
  });

  it('falls back to anonymous when the proxy headers are rejected, and tries only once per page load', async () => {
    const f = routeFetch({
      ...base, 'POST /api/auth/refresh': unauthorized(), 'GET /api/auth/methods': methods({ forwardAuth: true }),
      'POST /api/auth/forward': unauthorized(),
    });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    await act(async () => { screen.getByText('anonymous').click(); }); // retry re-runs the probe
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(f.count('POST /api/auth/refresh')).toBe(2);
    expect(f.count('POST /api/auth/forward')).toBe(1);
  });

  it('adopts the session another tab just obtained instead of creating another one', async () => {
    const otherTab = new BroadcastChannel('synclet-auth');
    const f = routeFetch({
      ...base,
      'POST /api/auth/refresh': async () => {
        // Another tab finishes its forward-auth login while ours is still in its refresh.
        otherTab.postMessage({ type: 'session', at: Date.now(), auth: AUTH });
        await new Promise((r) => setTimeout(r, 30));
        return unauthorized();
      },
      'GET /api/auth/methods': methods({ forwardAuth: true }),
      'POST /api/auth/forward': json(200, AUTH),
    });
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(f.count('POST /api/auth/forward')).toBe(0);
    otherTab.close();
  });
});

describe('LoginPage', () => {
  it('redirects to /setup while setup is pending', async () => {
    routeFetch({ 'GET /api/setup/status': json(200, { needsSetup: true }), 'GET /api/auth/methods': methods() });
    const { LoginPage } = await import('@/pages/LoginPage');
    const router = createMemoryRouter(
      [{ path: '/login', element: <LoginPage /> }, { path: '/setup', element: <p>setup-route</p> }],
      { initialEntries: ['/login'] },
    );
    const { wrapper: Wrapper } = testQueryClient();
    render(<Wrapper><authMod.AuthProvider><RouterProvider router={router} /></authMod.AuthProvider></Wrapper>);
    expect(await screen.findByText('setup-route')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/setup');
  });
});
