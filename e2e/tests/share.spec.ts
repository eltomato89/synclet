import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mkdir, readZip, row, signIn, upload } from './helpers';

test.use({ locale: 'en-US' });

test('password-protected folder link: unlock in a fresh browser, download a file and the ZIP', async ({ page, browser }) => {
  const user = await signIn(page, 'share');
  const folderId = await mkdir(user.api, 'root', 'Holiday');
  await upload(user.api, folderId, 'notes.txt', 'sunny');
  const sub = await mkdir(user.api, folderId, 'Day 1');
  await upload(user.api, sub, 'beach.txt', 'sand');
  await page.reload();

  await row(page, 'Holiday').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Share …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share “Holiday”' });
  await dialog.getByRole('switch', { name: 'Password' }).click();
  await dialog.getByLabel('Password for the link').fill('open-sesame');
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const link = await dialog.getByRole('textbox', { name: 'Share link' }).inputValue();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]+$/);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // Anonymous visitor: a separate context without the owner's cookies.
  const visitorContext = await browser.newContext({ locale: 'en-US', acceptDownloads: true });
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto(link);
    await expect(visitor.getByRole('heading', { name: 'This link is password protected' })).toBeVisible();
    await expect(visitor.getByText('notes.txt')).toBeHidden();
    await visitor.getByLabel('Password', { exact: true }).fill('wrong-one');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(visitor.getByText('That password isn\'t right.')).toBeVisible();
    await visitor.getByLabel('Password', { exact: true }).fill('open-sesame');
    await visitor.getByRole('button', { name: 'Open' }).click();

    const contents = visitor.getByRole('list', { name: 'Contents' });
    await expect(contents.getByText('notes.txt')).toBeVisible();
    await expect(contents.getByText('Day 1')).toBeVisible();

    const fileDownload = visitor.waitForEvent('download');
    await visitor.getByRole('link', { name: 'Download notes.txt' }).click();
    const file = await fileDownload;
    expect(file.suggestedFilename()).toBe('notes.txt');
    expect(await readFile(await file.path(), 'utf8')).toBe('sunny');

    const zipDownload = visitor.waitForEvent('download');
    await visitor.getByRole('link', { name: 'Download all as ZIP' }).click();
    const zip = await zipDownload;
    expect(zip.suggestedFilename()).toBe('Holiday.zip');
    const entries = readZip(await readFile(await zip.path()));
    expect([...entries.keys()].map((n) => n.replace(/\/$/, '')).sort()).toEqual(['Day 1', 'Day 1/beach.txt', 'notes.txt']);
    expect(entries.get('Day 1/beach.txt')?.toString()).toBe('sand');
    expect(entries.get('notes.txt')?.toString()).toBe('sunny');
  } finally {
    await visitorContext.close();
  }
});
