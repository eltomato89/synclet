import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir as mkdirLocal, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdir, signIn, type TestUser, upload } from './helpers';

test.use({ locale: 'en-US' });
test.describe.configure({ mode: 'serial' });

interface Item { id: string; name: string; type: 'file' | 'folder' }
const children = async (api: APIRequestContext, id: string): Promise<Item[]> =>
  (await (await api.get(`/api/sync/v1/items/${id}/children`)).json()).items as Item[];
/** Names in code-unit order (upper case before lower case). */
const names = async (api: APIRequestContext, id: string) => (await children(api, id)).map((i) => i.name).sort();
const child = async (api: APIRequestContext, id: string, name: string) => {
  const found = (await children(api, id)).find((i) => i.name === name);
  expect(found, `${name} in ${id}`).toBeTruthy();
  return found!.id;
};
const text = async (api: APIRequestContext, id: string) => (await api.get(`/api/sync/v1/items/${id}/content`)).text();

/** A real folder on disk: Urlaub/{a.txt, .DS_Store, ._a.txt, Bilder/{b.txt, Tag 1/c.txt}}. */
async function makeFolder(dir: string): Promise<string> {
  const root = path.join(dir, 'Urlaub');
  await mkdirLocal(path.join(root, 'Bilder', 'Tag 1'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'A');
  await writeFile(path.join(root, '.DS_Store'), 'junk');
  await writeFile(path.join(root, '._a.txt'), 'junk');
  await writeFile(path.join(root, 'Bilder', 'b.txt'), 'B neu');
  await writeFile(path.join(root, 'Bilder', 'Tag 1', 'c.txt'), 'C');
  return root;
}

let user: TestUser;
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'en-US' });
  user = await signIn(page, 'folders');
});
test.afterAll(async () => { await page.close(); });

async function openTarget(): Promise<string> {
  const target = await mkdir(user.api, 'root', `Ziel ${randomBytes(4).toString('hex')}`);
  // An existing "Urlaub" with a sub-folder "Bilder" that already holds a b.txt.
  const existing = await mkdir(user.api, target, 'Urlaub');
  const bilder = await mkdir(user.api, existing, 'Bilder');
  await upload(user.api, bilder, 'b.txt', 'B alt');
  await page.goto(`/files/${target}`);
  await expect(page.getByRole('grid').getByTitle('Urlaub', { exact: true })).toBeVisible();
  return target;
}

test('an existing folder name: keep both as "Urlaub (2)"', async ({}, testInfo) => {
  const target = await openTarget();
  await page.locator('input[data-upload=folder]').setInputFiles(await makeFolder(testInfo.outputPath('keep')));

  const dialog = page.getByRole('dialog', { name: '“Urlaub” already exists' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep as “Urlaub (2)”' }).click();
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Folder “Urlaub (2)”: 3 of 3 files')).toBeVisible({ timeout: 30_000 });

  expect(await names(user.api, target)).toEqual(['Urlaub', 'Urlaub (2)']);
  const copy = await child(user.api, target, 'Urlaub (2)');
  expect(await names(user.api, copy)).toEqual(['Bilder', 'a.txt']); // no .DS_Store, no ._a.txt
  const bilder = await child(user.api, copy, 'Bilder');
  expect(await names(user.api, bilder)).toEqual(['Tag 1', 'b.txt']);
  expect(await names(user.api, await child(user.api, bilder, 'Tag 1'))).toEqual(['c.txt']);
  // The existing folder is untouched.
  const old = await child(user.api, target, 'Urlaub');
  expect(await names(user.api, await child(user.api, old, 'Bilder'))).toEqual(['b.txt']);
});

test('an existing folder name: merge into it, same-named files get "(2)"', async ({}, testInfo) => {
  const target = await openTarget();
  await page.locator('input[data-upload=folder]').setInputFiles(await makeFolder(testInfo.outputPath('merge')));

  const dialog = page.getByRole('dialog', { name: '“Urlaub” already exists' });
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Folder “Urlaub”: 3 of 3 files')).toBeVisible({ timeout: 30_000 });

  expect(await names(user.api, target)).toEqual(['Urlaub']);
  const urlaub = await child(user.api, target, 'Urlaub');
  expect(await names(user.api, urlaub)).toEqual(['Bilder', 'a.txt']);
  const bilder = await child(user.api, urlaub, 'Bilder');
  expect(await names(user.api, bilder)).toEqual(['Tag 1', 'b (2).txt', 'b.txt']);
  expect(await text(user.api, await child(user.api, bilder, 'b.txt'))).toBe('B alt');
  expect(await text(user.api, await child(user.api, bilder, 'b (2).txt'))).toBe('B neu');
  expect(await names(user.api, await child(user.api, bilder, 'Tag 1'))).toEqual(['c.txt']);
});
