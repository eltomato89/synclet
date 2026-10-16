import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contract } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

// Note: every route here is rate-limited per client IP (10 requests, then one per 6 s); the
// client waits for Retry-After, so a quick re-run is slower but still passes.
const { ctx, api } = contract();
const REDIRECT = 'synclet://oauth';

function pkce() {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars of [A-Za-z0-9_-]
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('app login (OAuth 2.0 authorization code + PKCE S256)', () => {
  it('validates client ids and exact redirect URIs', async () => {
    const ok = await api.get(`/auth/app/client?clientId=macos&redirectUri=${encodeURIComponent(REDIRECT)}`, { token: null });
    expect(ok.status).toBe(200);
    expect(schemaErrors('AppClient', ok.json())).toBe('');
    expect(ok.json().id).toBe('macos');
    const loopback = await api.get(`/auth/app/client?clientId=windows&redirectUri=${encodeURIComponent('http://127.0.0.1:53123/callback')}`, { token: null });
    expect(loopback.json().id).toBe('windows');
    const bad = await api.get(`/auth/app/client?clientId=ios&redirectUri=${encodeURIComponent('synclet://evil')}`, { token: null });
    expect(bad.status).toBe(400);
    expect(bad.json().code).toBe('invalid_request');
  });

  it('password authorize → code → token (wrong verifier refused, code single-use) → access works → refresh rotates', async (t) => {
    if (!ctx.login) t.skip('needs SYNCLET_USER/SYNCLET_PASSWORD (or SYNCLET_SETUP=1)');
    const { verifier, challenge } = pkce();
    const params = { clientId: 'ios', redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256' };
    const auth = await api.post('/auth/app/authorize', { ...ctx.login, ...params }, { token: null });
    expect(auth.status).toBe(200);
    expect(schemaErrors('AppCode', auth.json())).toBe('');
    const { code } = auth.json();

    const exchange = { code, clientId: 'ios', redirectUri: REDIRECT };
    const wrong = await api.post('/auth/app/token', { ...exchange, codeVerifier: pkce().verifier }, { token: null });
    expect(wrong.status).toBe(400);
    expect(wrong.json().code).toBe('invalid_request');

    const tokens = await api.post('/auth/app/token', { ...exchange, codeVerifier: verifier }, { token: null });
    expect(tokens.status).toBe(200);
    const body = tokens.json();
    expect(schemaErrors('AppTokenResponse', body)).toBe('');
    const replay = await api.post('/auth/app/token', { ...exchange, codeVerifier: verifier }, { token: null });
    expect(replay.status).toBe(400);

    const account = await api.get('/sync/v1/account', { token: body.accessToken });
    expect(account.status).toBe(200);
    expect(account.json().userId).toBe(body.user.id);

    const refreshed = await api.post('/auth/app/refresh', { refreshToken: body.refreshToken }, { token: null });
    expect(refreshed.status).toBe(200);
    expect(schemaErrors('AppTokenResponse', refreshed.json())).toBe('');
    expect(refreshed.json().refreshToken).not.toBe(body.refreshToken);
    // End the session again (POST /auth/logout takes the refresh token as cookie).
    const logout = await api.request('POST', '/auth/logout', { token: null, headers: { cookie: `synclet_refresh=${refreshed.json().refreshToken}` } });
    expect(logout.status).toBe(204);
    // Not exercised on purpose: re-using a spent (rotated or logged-out) refresh token revokes ALL
    // sessions of the user.
  });

  it('session authorize: works with a web access token, refused (403) with a device token', async (t) => {
    const { challenge } = pkce();
    const params = { clientId: 'linux', redirectUri: 'http://127.0.0.1:8123/callback', codeChallenge: challenge, codeChallengeMethod: 'S256' };
    const device = await api.post('/auth/app/authorize/session', params);
    expect(device.status).toBe(403);
    expect(device.json().code).toBe('forbidden');
    if (!ctx.webToken) t.skip('no web access token available');
    const web = await api.post('/auth/app/authorize/session', params, { token: ctx.webToken });
    expect(web.status).toBe(200);
    expect(web.json().code).toEqual(expect.any(String));
  });

  it('rejects malformed requests with 400 invalid_request', async () => {
    const res = await api.post('/auth/app/token', { code: 'x', codeVerifier: 'short', clientId: 'ios', redirectUri: REDIRECT }, { token: null });
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });
});
