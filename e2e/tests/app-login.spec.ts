import { expect, request, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BASE_URL, retryRateLimited, USER_PASSWORD, waitOutRateLimits } from './helpers';

test.use({ locale: 'en-US' });

const b64url = (b: Buffer) => b.toString('base64url');

/** The native app's loopback redirect target (RFC 8252): resolves with the first /callback query. */
async function loopbackServer() {
  let resolve!: (q: URLSearchParams) => void;
  const received = new Promise<URLSearchParams>((r) => { resolve = r; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Signed in. You can close this window.</p>');
    resolve(url.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}/callback`, received, close: () => new Promise((r) => server.close(r)) };
}

test('a desktop app signs in through the browser (code + PKCE), exchanges the code and registers a device', async ({ page, context }) => {
  test.setTimeout(150_000); // may wait out the shared per-IP sign-in limit
  await waitOutRateLimits(context);
  const loopback = await loopbackServer();
  try {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const q = new URLSearchParams({
      client_id: 'linux', redirect_uri: loopback.redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state,
    });

    // Not signed in in this browser: the page shows the app and asks for the password.
    await page.goto(`/app-login?${q}`);
    await expect(page.getByRole('heading', { name: 'Sign in to Synclet for Synclet for Linux' })).toBeVisible();
    await page.getByLabel('Username or email').fill('e2e-applogin');
    await page.getByLabel('Password', { exact: true }).fill(USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The browser is sent to the app's loopback address with a one-time code and the app's state.
    const callback = await loopback.received;
    await expect(page).toHaveURL(new RegExp(`^${loopback.redirectUri.replace(/[.?]/g, '\\$&')}\\?`));
    expect(callback.get('state')).toBe(state);
    const code = callback.get('code');
    expect(code).toBeTruthy();

    // The app exchanges the code with its verifier (no browser involved).
    const app = await request.newContext({ baseURL: BASE_URL });
    const tokenReq = { code, codeVerifier: verifier, clientId: 'linux', redirectUri: loopback.redirectUri };
    // A wrong verifier is refused (and does not burn the code).
    const token = (data: object) => retryRateLimited(() => app.post('/api/auth/app/token', { data }));
    const wrong = await token({ ...tokenReq, codeVerifier: b64url(randomBytes(48)) });
    expect(wrong.status()).toBe(400);
    const res = await token(tokenReq);
    expect(res.status(), await res.text()).toBe(200);
    const tokens = await res.json();
    expect(tokens.user.username).toBe('e2e-applogin');
    expect(tokens.refreshToken).toBeTruthy();
    // Single use.
    expect((await token(tokenReq)).status()).toBe(400);

    // With the access token the app registers itself as a sync device and gets its device token.
    const authed = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${tokens.accessToken}` } });
    const reg = await authed.post('/api/sync/v1/devices', { data: { name: 'Laptop (e2e)', platform: 'linux', appVersion: '0.0.0-e2e' } });
    expect(reg.status(), await reg.text()).toBe(201);
    const device = await reg.json();
    expect(device.account.displayName).toBeTruthy();
    const asDevice = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { authorization: `Bearer ${device.token}` } });
    const list = await asDevice.get('/api/sync/v1/devices');
    expect(list.status()).toBe(200);
    expect(((await list.json()) as { name: string }[]).map((d) => d.name)).toContain('Laptop (e2e)');
    await Promise.all([app.dispose(), authed.dispose(), asDevice.dispose()]);
  } finally {
    await loopback.close();
  }
});
