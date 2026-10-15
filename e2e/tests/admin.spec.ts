import { expect, request, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { apiAs, BASE_URL, E2E, login, mkdir, retryRateLimited, signInAdmin, upload, USER_PASSWORD } from './helpers';

test.use({ locale: 'en-US' });

// One administrator session for the whole walk through the admin area (logins are rate-limited).
test('admin area: users, adopted folder, disable, last admin, sessions, status, share links', async ({ page }) => {
  test.setTimeout(240_000);
  const adminApi = await signInAdmin(page);
  const usersTable = page.getByRole('table', { name: 'Users' });
  const userRow = (username: string) => usersTable.getByRole('row').filter({ hasText: username });

  await test.step('create a user', async () => {
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog', { name: 'New user' });
    await dialog.getByLabel('Display name').fill('Erika Neu');
    await dialog.getByLabel('Username').fill('e2e-erika');
    await dialog.getByLabel('Email (optional)').fill('erika@example.test');
    await dialog.getByLabel('Password', { exact: true }).fill(USER_PASSWORD);
    await dialog.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByText('Erika Neu can sign in now')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(userRow('e2e-erika')).toBeVisible();
    // The account works: sign in with the email address, the folder exists.
    const anon = await request.newContext({ baseURL: BASE_URL });
    await login(anon, 'erika@example.test', USER_PASSWORD);
    await anon.dispose();
    if (E2E.dataDir) await expect.poll(() => existsSync(path.join(E2E.dataDir, 'e2e-erika'))).toBe(true);
  });

  await test.step('create a user for an existing folder (adopt)', async () => {
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog', { name: 'New user' });
    await dialog.getByRole('switch', { name: 'Use an existing folder' }).click();
    await dialog.getByRole('radiogroup', { name: 'Folder' }).getByText('altbestand', { exact: true }).click();
    await dialog.getByLabel('Display name').fill('Alter Bestand');
    await dialog.getByLabel('Password', { exact: true }).fill(USER_PASSWORD);
    await dialog.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByText('Alter Bestand can sign in now')).toBeVisible();
    await expect(userRow('altbestand')).toBeVisible();
    // The new user sees the files that were already in the folder.
    const anon = await request.newContext({ baseURL: BASE_URL });
    const api = await apiAs(await login(anon, 'altbestand', USER_PASSWORD));
    await expect.poll(async () => {
      const root = await (await api.get('/api/sync/v1/items/root/children')).json();
      return (root.items as { name: string }[]).map((i) => i.name);
    }, { timeout: 30_000 }).toContain('Projekte');
    await Promise.all([anon.dispose(), api.dispose()]);
  });

  await test.step('disable a user', async () => {
    await userRow('e2e-erika').getByRole('button', { name: 'Actions for Erika Neu' }).click();
    await page.getByRole('menuitem', { name: 'Disable' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Disable Erika Neu?' });
    await confirm.getByRole('button', { name: 'Disable account' }).click();
    await expect(page.getByText('Erika Neu is disabled')).toBeVisible();
    await expect(userRow('e2e-erika').getByText('Disabled')).toBeVisible();
    const anon = await request.newContext({ baseURL: BASE_URL });
    expect((await retryRateLimited(() => anon.post('/api/auth/login', { data: { login: 'e2e-erika', password: USER_PASSWORD } }))).status()).toBe(401);
    await anon.dispose();
  });

  await test.step('the last administrator with a password cannot be demoted', async () => {
    // The UI offers no way to demote oneself (see sso.spec.ts for the case through the UI: an
    // SSO-only administrator tries to demote the only password administrator). The API refuses it.
    const me = await (await adminApi.get('/api/auth/me')).json();
    const res = await adminApi.patch(`/api/admin/users/${me.id}`, { data: { role: 'user' } });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toBe('last admin');
    await usersTable.getByRole('button', { name: 'Actions for E2E', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit E2E' });
    await expect(dialog.getByRole('radio', { name: 'User' })).toBeDisabled();
    await expect(dialog.getByText("You can't remove your own administrator role.")).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  // A user with a browser session and a share link, for the next steps.
  const owner = await request.newContext({ baseURL: BASE_URL });
  const ownerApi = await apiAs(await login(owner, 'e2e-owner', USER_PASSWORD));
  const ownerMe = await (await ownerApi.get('/api/auth/me')).json();

  await test.step("revoke another user's session", async () => {
    await page.goto(`/admin/users/${ownerMe.id}`);
    const sessions = page.getByRole('table', { name: 'Browser sessions' });
    await expect(sessions.getByRole('row')).toHaveCount(2); // header + the session from the login above
    await sessions.getByRole('button', { name: /^Revoke session / }).click();
    await page.getByRole('alertdialog', { name: 'Revoke this session?' }).getByRole('button', { name: 'Revoke session' }).click();
    await expect(page.getByText('Session revoked')).toBeVisible();
    await expect(page.getByText('No active sessions.')).toBeVisible();
    // The browser of that session cannot refresh its access token anymore.
    expect((await owner.post('/api/auth/refresh')).status()).toBe(401);
  });

  await test.step('status page shows the numbers', async () => {
    await page.goto('/admin/status');
    const reading = (label: string) => page.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd').first();
    const users = (await (await adminApi.get('/api/admin/users')).json()) as { disabled: boolean }[];
    await expect(reading('Active users')).toHaveText(String(users.filter((u) => !u.disabled).length));
    await expect(reading('File versions')).toHaveText('On');
    await expect(reading('File watcher')).toHaveText(/Watching|Scans only/);
    const meter = page.getByRole('meter', { name: 'Disk usage of /data' });
    await expect(meter).toBeVisible();
    expect(Number(await meter.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(page.getByRole('table', { name: 'Background jobs' })).toBeVisible();
  });

  await test.step("revoke another user's share link", async () => {
    // The owner signs in again (the session was revoked) and shares a file.
    const again = await apiAs(await login(owner, 'e2e-owner', USER_PASSWORD));
    const folder = await mkdir(again, 'root', 'Freigabe');
    const file = await upload(again, folder, 'angebot.txt', 'vertraulich');
    const share = await (await again.post('/api/shares', { data: { itemId: file } })).json();
    const token = String(share.url).split('/s/')[1];
    const anon = await request.newContext({ baseURL: BASE_URL });
    expect((await anon.get(`/api/public/shares/${token}`)).status()).toBe(200);

    await page.goto('/admin/shares');
    const table = page.getByRole('table', { name: 'All share links' });
    await table.getByRole('button', { name: 'Revoke link to angebot.txt by e2e-owner' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke link' }).click();
    await expect(page.getByText('Link revoked')).toBeVisible();
    expect((await anon.get(`/api/public/shares/${token}`)).status()).toBeGreaterThanOrEqual(400);
    await Promise.all([again.dispose(), anon.dispose()]);
  });
  await Promise.all([owner.dispose(), ownerApi.dispose(), adminApi.dispose()]);
});
