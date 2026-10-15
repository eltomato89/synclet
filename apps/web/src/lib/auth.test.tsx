import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let authMod: typeof import('./auth');

beforeEach(async () => {
  vi.resetModules();
  authMod = await import('./auth');
});
afterEach(() => { vi.restoreAllMocks(); });

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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { needsSetup: false }))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('reports anonymous when refresh returns 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { needsSetup: false }))
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }));
    render(<authMod.AuthProvider><Status /></authMod.AuthProvider>);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
  });
});

describe('LoginPage', () => {
  it('redirects to /setup while setup is pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { needsSetup: true }));
    const { LoginPage } = await import('@/pages/LoginPage');
    const router = createMemoryRouter(
      [{ path: '/login', element: <LoginPage /> }, { path: '/setup', element: <p>setup-route</p> }],
      { initialEntries: ['/login'] },
    );
    render(<authMod.AuthProvider><RouterProvider router={router} /></authMod.AuthProvider>);
    expect(await screen.findByText('setup-route')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/setup');
  });
});
