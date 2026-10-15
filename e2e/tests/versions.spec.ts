import { type APIRequestContext, expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { E2E, mkdir, row, signIn, upload } from './helpers';

test.use({ locale: 'en-US' });

/**
 * Replaces the content like a sync client does (`PUT …/content`, `If-Match: *`). Docker Desktop on
 * macOS may report a new inode for the file shortly after the server's own write (synthetic per-path
 * inodes of the VM file sharing); the server then answers 412 once and re-indexes the file. Only
 * there one retry is allowed; on Linux a 412 fails the test.
 */
async function replace(api: APIRequestContext, id: string, data: string) {
  const put = () => api.put(`/api/sync/v1/items/${id}/content`, {
    headers: { 'if-match': '*', 'content-type': 'application/octet-stream' }, data: Buffer.from(data),
  });
  let res = await put();
  if (res.status() === 412 && process.platform === 'darwin') {
    console.warn(`412 on replace (Docker Desktop inode drift), retrying once: ${await res.text()}`);
    res = await put();
  }
  expect(res.status(), await res.text()).toBe(200);
}

test('replacing a text file keeps versions; an older one is restored from the versions panel', async ({ page }) => {
  const user = await signIn(page, 'versions');
  const folderId = await mkdir(user.api, 'root', 'Notizen');
  const id = await upload(user.api, folderId, 'plan.txt', 'erste Fassung');
  await replace(user.api, id, 'zweite Fassung');
  await replace(user.api, id, 'dritte Fassung');

  const versions = (await (await user.api.get(`/api/sync/v1/items/${id}/versions`)).json()) as { id: string; version: number; size: number }[];
  expect(versions).toHaveLength(2);
  const oldest = versions.reduce((a, b) => (a.version < b.version ? a : b));

  await page.goto(`/files/${folderId}`);
  await row(page, 'plan.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Versions …' }).click();
  const panel = page.getByRole('dialog', { name: 'Versions' });
  await expect(panel.getByText('Earlier versions of “plan.txt”')).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveCount(2);

  // Download the oldest version from the panel: the old bytes, named "<base> (v<n>).<ext>".
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: `Download version ${oldest.version}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`plan (v${oldest.version}).txt`);
  expect(await readFile(await download.path(), 'utf8')).toBe('erste Fassung');

  await panel.getByRole('button', { name: `Restore version ${oldest.version}` }).click();
  const confirm = page.getByRole('alertdialog', { name: `Restore version ${oldest.version}?` });
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText(`Version ${oldest.version} restored`)).toBeVisible();
  await expect(confirm).toBeHidden();
  // The replaced current content became a version itself: nothing is lost.
  await expect(panel.getByRole('listitem')).toHaveCount(3);

  // The file keeps its id and has the old content again – on the server and in the user's folder.
  const content = await user.api.get(`/api/sync/v1/items/${id}/content`);
  expect(await content.text()).toBe('erste Fassung');
  if (E2E.dataDir) {
    expect(await readFile(path.join(E2E.dataDir, user.username, 'Notizen', 'plan.txt'), 'utf8')).toBe('erste Fassung');
  }
});
