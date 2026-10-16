import { type Browser, expect, type Page, request, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { apiAs, BASE_URL, E2E, retryRateLimited, signInAdmin, waitOutRateLimits } from './helpers';

test.use({ locale: 'en-US' });
// Sign-in settings are server-wide; the steps build on each other.
test.describe.configure({ mode: 'serial' });

const BUTTON = 'Mock-Login';
const ADMIN_GROUP = 'synclet-admins';

/** Signs in through the mock provider's form (any subject; extra claims as JSON). */
async function ssoLogin(page: Page, subject: string, claims: Record<string, unknown>) {
  await page.getByRole('link', { name: BUTTON }).click();
  await expect(page.getByRole('heading', { name: 'Mock OAuth2 Server Sign-in' })).toBeVisible();
  await page.locator('input[name="username"]').fill(subject);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify(claims));
  await page.locator('input[type="submit"]').click();
  await expect(page).toHaveURL(/\/files/);
  await expect(page.locator('#main')).toBeVisible();
}

/** The signed-in user of a browser context (refreshes its session once). */
async function me(page: Page, base = BASE_URL) {
  const refresh = await page.request.post(`${base}/api/auth/refresh`);
  expect(refresh.status(), await refresh.text()).toBe(200);
  const api = await apiAs((await refresh.json()).accessToken);
  const user = await (await api.get(`${base}/api/auth/me`)).json();
  await api.dispose();
  return user as { username: string; displayName: string; role: 'admin' | 'user'; email: string | null };
}

const folderExists = (name: string) => expect.poll(() => existsSync(path.join(E2E.dataDir, name)), { timeout: 15_000 }).toBe(true);

async function freshPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ locale: 'en-US', baseURL: BASE_URL, ...options });
  await waitOutRateLimits(context); // the forward-auth bootstrap shares the per-IP budget
  return { context, page: await context.newPage() };
}

test.beforeAll(() => {
  if (!E2E.oidcIssuer || !E2E.forwardUrl || !E2E.networkCidr || !E2E.dataDir) {
    throw new Error('sso.spec.ts needs the stack of scripts/e2e-fresh.sh (E2E_OIDC_ISSUER, E2E_FORWARD_URL, E2E_NETWORK_CIDR, E2E_DATA_DIR)');
  }
});

test('the administrator configures OIDC and forward-auth in the admin UI, signs out and an SSO user is provisioned', async ({ page }) => {
  const adminApi = await signInAdmin(page);
  await page.goto('/admin/sso');

  const oidc = page.getByRole('region', { name: 'OpenID Connect' });
  await expect(oidc.getByRole('textbox', { name: 'Redirect URI' })).toHaveValue(`${BASE_URL}/api/auth/oidc/callback`);
  await oidc.getByLabel('Issuer URL').fill(E2E.oidcIssuer);
  await oidc.getByRole('button', { name: 'Test connection' }).click();
  await expect(oidc.getByText(`Connected. Found provider ${E2E.oidcIssuer}`)).toBeVisible();
  await oidc.getByLabel('Client ID').fill('synclet');
  await oidc.getByLabel('Client secret').fill('mock-secret');
  await oidc.getByLabel('Button label').fill(BUTTON);
  await oidc.getByLabel('Administrator groups').fill(ADMIN_GROUP);
  await oidc.getByLabel('Administrator groups').press('Enter');
  await oidc.getByRole('switch', { name: 'Sign in with OpenID Connect' }).click();

  const forward = page.getByRole('region', { name: 'Auth proxy (forward-auth)' });
  await forward.getByLabel('Trusted proxy addresses').fill(E2E.networkCidr);
  await forward.getByLabel('Trusted proxy addresses').press('Enter');
  await forward.getByRole('switch', { name: 'Sign in through the auth proxy' }).click();

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Sign-in settings saved')).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();

  // Stored as entered; the client secret is write-only (encrypted at rest, never returned).
  const saved = await adminApi.get('/api/admin/sso');
  const text = await saved.text();
  expect(text).not.toContain('mock-secret');
  const wire = JSON.parse(text);
  expect(wire.oidc).toMatchObject({ enabled: true, issuer: E2E.oidcIssuer, clientId: 'synclet', hasClientSecret: true, adminGroups: [ADMIN_GROUP] });
  expect(wire.forwardAuth).toMatchObject({ enabled: true, trustedProxies: [E2E.networkCidr] });
  await adminApi.dispose();

  // Sign out; the login page now offers single sign-on next to the password form.
  await page.goto('/files');
  await page.getByRole('button', { name: /E2E/ }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Username or email')).toBeVisible();

  await ssoLogin(page, 'anna-sub-1', { preferred_username: 'sso-anna', name: 'Anna SSO', email: 'anna@example.test', email_verified: true });
  const anna = await me(page);
  expect(anna).toMatchObject({ username: 'sso-anna', displayName: 'Anna SSO', role: 'user', email: 'anna@example.test' });
  await folderExists('sso-anna');
});

test('a member of the administrator group becomes an administrator, but cannot demote the last password admin', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  await page.goto('/login');
  await ssoLogin(page, 'boss-sub-1', { preferred_username: 'sso-boss', name: 'Boss SSO', groups: [ADMIN_GROUP, 'staff'] });
  expect(await me(page)).toMatchObject({ username: 'sso-boss', role: 'admin' });
  await folderExists('sso-boss');

  await page.goto('/admin/users');
  const table = page.getByRole('table', { name: 'Users' });
  await expect(table.getByRole('row').filter({ hasText: 'sso-anna' })).toBeVisible();
  // sso-boss has no password: demoting e2e (the only admin with a password) would lock password login out.
  await table.getByRole('button', { name: 'Actions for E2E', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit E2E' });
  await dialog.getByRole('radio', { name: 'User' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('This is the last administrator who can sign in with a password.', { exact: false })).toBeVisible();
  await context.close();
});

test('forward-auth: the trusted proxy path signs in by header', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  // The auth proxy (e2e/stack/authproxy.caddy) sets Remote-User: fa-user on every request.
  await page.goto(`${E2E.forwardUrl}/files`);
  await expect(page).toHaveURL(/\/files/);
  await expect(page.locator('#main')).toBeVisible();
  expect(await me(page, E2E.forwardUrl)).toMatchObject({ username: 'fa-user', displayName: 'Forward User', role: 'user' });
  await folderExists('fa-user');
  await context.close();
});

test('forward-auth: identity headers sent by the browser itself are ignored', async ({ browser }) => {
  const spoof = { 'Remote-User': 'e2e', 'Remote-Email': 'e2e@example.test', 'Remote-Groups': ADMIN_GROUP };
  const { context, page } = await freshPage(browser, { extraHTTPHeaders: spoof });
  await page.goto('/files');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await context.close();

  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: spoof });
  const res = await retryRateLimited(() => api.post('/api/auth/forward'));
  expect(res.status()).toBe(401);
  expect((await api.post('/api/auth/refresh')).status()).toBe(401);
  await api.dispose();
});
