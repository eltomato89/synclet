import type { AuthResponse } from '@synclet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ApiModule = typeof import('./api');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const auth = (token: string): AuthResponse => ({ accessToken: token, user: { id: 'u1', username: 'jens', displayName: 'Jens', email: null, role: 'admin' } });

let mod: ApiModule;
let peer: BroadcastChannel; // plays "another tab"

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./api'); // fresh module state (token, shared session) per test
  peer = new BroadcastChannel('synclet-auth');
});

afterEach(() => {
  vi.restoreAllMocks();
  peer.close();
  delete (navigator as { locks?: unknown }).locks;
});

describe('refresh failures', () => {
  it('keeps the session on 5xx from /auth/refresh and throws server_error', async () => {
    mod.setAccessToken('old');
    const listener = vi.fn();
    mod.onAuthChange(listener);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }));
    await expect(mod.api('/thing')).rejects.toMatchObject({ status: 503, code: 'server_error' });
    expect(mod.getAccessToken()).toBe('old');
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the session on a network error during refresh and throws network', async () => {
    mod.setAccessToken('old');
    const listener = vi.fn();
    mod.onAuthChange(listener);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await mod.api('/thing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
    expect(mod.isTransientError(err)).toBe(true);
    expect(mod.getAccessToken()).toBe('old');
    expect(listener).not.toHaveBeenCalled();
  });

  it('ends the session only on 401/403 from /auth/refresh', async () => {
    mod.setAccessToken('old');
    const listener = vi.fn();
    mod.onAuthChange(listener);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'revoked' }));
    await expect(mod.api('/thing')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(mod.getAccessToken()).toBeNull();
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('wraps network errors of normal requests in ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(mod.api('/thing')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});

describe('cross-tab coordination', () => {
  it('refreshes inside the synclet-refresh Web Lock and shares the new session', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    const received: unknown[] = [];
    peer.onmessage = (e) => received.push(e.data);
    mod.setAccessToken('old');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(json(200, auth('new')))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    expect(await mod.api('/thing')).toEqual({ ok: 1 });
    expect(request).toHaveBeenCalledWith('synclet-refresh', expect.any(Function));
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: 'session', auth: auth('new') })));
  });

  it('adopts a token another tab obtained while waiting for the lock instead of reusing the cookie', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const request = vi.fn(async (_name: string, cb: () => Promise<unknown>) => { await gate; return cb(); });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    mod.setAccessToken('old');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));

    const pending = mod.api('/thing');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    peer.postMessage({ type: 'session', at: Date.now(), auth: auth('from-other-tab') });
    await vi.waitFor(() => expect(mod.getAccessToken()).toBe('from-other-tab'));
    release();

    expect(await pending).toEqual({ ok: 2 });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/thing', '/api/thing']); // no /auth/refresh
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer from-other-tab' }) });
  });

  it('applies a logout from another tab', async () => {
    mod.setAccessToken('tok');
    const listener = vi.fn();
    mod.onAuthChange(listener);
    peer.postMessage({ type: 'logout' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));
    expect(mod.getAccessToken()).toBeNull();
  });

  it('broadcasts its own logout', async () => {
    const received: unknown[] = [];
    peer.onmessage = (e) => received.push(e.data);
    mod.broadcastLogout();
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'logout' }));
  });
});
