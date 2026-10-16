import { type APIRequestContext, type Browser, expect, type Page, request, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { ADMIN, apiAs, BASE_URL, login, row, USER_PASSWORD } from './helpers';

// Phase 4 spaces in the web UI. The administrator sets up a group "Familie" (kim) and a team folder
// "Familie" the group can write to; lu gets read access directly, a third user none. The spec
// creates its own accounts (suffixed, so it never collides with other specs' users).
test.use({ locale: 'de-DE' });

const suffix = randomBytes(3).toString('hex');
const KIM = `e2e-kim-${suffix}`;
const LU = `e2e-lu-${suffix}`;
const NOBODY = `e2e-nobody-${suffix}`;

let admin: APIRequestContext;
let spaceId = '';
const rootId = () => `r_${spaceId}`;

async function createUser(username: string): Promise<string> {
  const res = await admin.post('/api/admin/users', { data: { username, displayName: username, password: USER_PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

/** A browser page signed in as `username` (own context, so sessions never mix). */
async function pageAs(browser: Browser, username: string): Promise<{ page: Page; token: string }> {
  const context = await browser.newContext({ baseURL: BASE_URL, locale: 'de-DE' });
  const page = await context.newPage();
  const token = await login(page.request, username, USER_PASSWORD);
  await page.goto('/files');
  await expect(page.locator('#main')).toBeVisible();
  return { page, token };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const anon = await request.newContext({ baseURL: BASE_URL });
  admin = await apiAs(await login(anon, ADMIN.login, ADMIN.password));
  await anon.dispose();

  const kimId = await createUser(KIM);
  const luId = await createUser(LU);
  await createUser(NOBODY);

  const group = await admin.post('/api/admin/groups', { data: { name: 'Familie' } });
  expect(group.status(), await group.text()).toBe(201);
  const groupId = (await group.json()).id as string;
  const members = await admin.patch(`/api/admin/groups/${groupId}`, { data: { memberIds: [kimId] } });
  expect(members.ok(), await members.text()).toBeTruthy();

  const space = await admin.post('/api/admin/spaces', { data: { name: 'Familie' } });
  expect(space.status(), await space.text()).toBe(201);
  spaceId = (await space.json()).id as string;
  const access = await admin.patch(`/api/admin/spaces/${spaceId}`, {
    data: { members: [{ kind: 'group', id: groupId, role: 'write' }, { kind: 'user', id: luId, role: 'read' }] },
  });
  expect(access.ok(), await access.text()).toBeTruthy();
});

test.afterAll(async () => { await admin?.dispose(); });

test('kim sees "Familie" in the sidebar and uploads a file', async ({ browser }) => {
  const { page } = await pageAs(browser, KIM);
  const spaces = page.getByRole('navigation', { name: 'Bereiche' });
  await spaces.getByRole('link', { name: 'Familie' }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${rootId()}$`));
  // The breadcrumb starts with the space name; kim can write, so there is no read-only banner.
  await expect(page.getByRole('navigation', { name: 'Ordnerpfad' })).toContainText('Familie');
  await expect(page.getByRole('status', { name: 'Nur lesen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hochladen', exact: true })).toBeEnabled();

  await page.locator('input[data-upload=files]').setInputFiles({ name: 'Einkaufsliste.txt', mimeType: 'text/plain', buffer: Buffer.from('Milch, Brot') });
  await expect(row(page, 'Einkaufsliste.txt')).toBeVisible();
  await page.context().close();
});

test('lu reads the space: sees the file, but no upload', async ({ browser }) => {
  const { page } = await pageAs(browser, LU);
  const link = page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: /Familie/ });
  await expect(link.getByLabel('Nur lesen')).toBeVisible();
  await link.click();
  await expect(row(page, 'Einkaufsliste.txt')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Nur lesen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hochladen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Neu' })).toHaveCount(0);
  await page.context().close();
});

test('a user without access gets "not found" for the space URL', async ({ browser }) => {
  const { page, token } = await pageAs(browser, NOBODY);
  await expect(page.getByRole('navigation', { name: 'Bereiche' })).toHaveCount(0);
  const api = await apiAs(token);
  expect((await api.get(`/api/sync/v1/items/${rootId()}`)).status()).toBe(404);
  await api.dispose();
  await page.goto(`/files/${rootId()}`);
  // 404 not_found: the same message as for a folder that does not exist.
  await expect(page.getByRole('heading', { name: 'Diesen Ordner gibt es nicht' })).toBeVisible();
  await page.context().close();
});
