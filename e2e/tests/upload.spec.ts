import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { mkdir, row, signIn } from './helpers';

test.use({ locale: 'en-US' });

const MiB = 1024 * 1024;
const CHUNK = 16 * MiB; // TUS_CHUNK_SIZE of the web client

test('an interrupted upload resumes from the server offset after a reload', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'upload throttling uses the Chrome DevTools protocol');
  test.setTimeout(180_000);
  const user = await signIn(page, 'upload');
  const folderId = await mkdir(user.api, 'root', `Uploads ${randomBytes(4).toString('hex')}`);
  await page.goto(`/files/${folderId}`);
  // The folder view has loaded (the file input is the one that stays).
  await expect(page.getByText('This folder is empty')).toBeVisible();
  const data = randomBytes(40 * MiB);
  // A file on disk keeps its lastModified across selections, so the tus fingerprint matches.
  const file = testInfo.outputPath('big.bin');
  await writeFile(file, data);

  // Slow uploads down so the transfer is still running when the network goes away.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 8 * MiB });

  const firstChunk = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/sync/v1/uploads/') && r.status() === 204);
  await page.locator('input[type=file]').setInputFiles(file);
  const uploadUrl = (await firstChunk).url();
  await context.setOffline(true);
  // The tab goes away mid-transfer. The app asks before leaving with a running upload; confirm.
  const leaveWarnings: string[] = [];
  page.on('dialog', (d) => { leaveWarnings.push(d.type()); void d.accept(); });
  await page.goto('about:blank');
  expect(leaveWarnings).toEqual(['beforeunload']);
  await context.setOffline(false);

  // The server kept the received part; nothing is in the folder yet.
  const head = await user.api.head(uploadUrl, { headers: { 'Tus-Resumable': '1.0.0' } });
  expect(head.status()).toBe(200);
  const offset = Number(head.headers()['upload-offset']);
  expect(offset).toBeGreaterThanOrEqual(CHUNK);
  expect(offset).toBeLessThan(data.length);
  const listing = await (await user.api.get(`/api/sync/v1/items/${folderId}/children`)).json();
  expect(listing.items).toEqual([]);

  // Reload and pick the same file again: the client resumes the stored upload (no new POST).
  await page.goto(`/files/${folderId}`);
  // The folder view has loaded (the file input is the one that stays).
  await expect(page.getByText('This folder is empty')).toBeVisible();
  const posts: string[] = [];
  const patchOffsets: number[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/sync/v1/uploads')) return;
    if (r.method() === 'POST') posts.push(r.url());
    if (r.method() === 'PATCH') patchOffsets.push(Number(r.headers()['upload-offset']));
  });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(row(page, 'big.bin')).toBeVisible({ timeout: 60_000 });
  expect(posts).toEqual([]);
  expect(patchOffsets[0]).toBe(offset);

  // The finished file is complete and byte-identical; the staged upload is gone.
  const items = (await (await user.api.get(`/api/sync/v1/items/${folderId}/children`)).json()).items as { id: string; name: string; size: number }[];
  expect(items.map((i) => [i.name, i.size])).toEqual([['big.bin', data.length]]);
  const content = await user.api.get(`/api/sync/v1/items/${items[0].id}/content`);
  expect(Buffer.compare(await content.body(), data)).toBe(0);
  expect((await user.api.head(uploadUrl, { headers: { 'Tus-Resumable': '1.0.0' } })).status()).toBe(404);
});
