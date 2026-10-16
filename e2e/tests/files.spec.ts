import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Runs against a fresh stack (empty DB). Locale forced to German to assert the default UI language.
test.use({ locale: 'de-DE' });

test('setup, upload, rename, move, delete, download', async ({ page }) => {
  // One row of the file list (role=grid) per item; exact name match on the name cell.
  const row = (name: string) => page.getByRole('grid').getByRole('row').filter({ has: page.getByTitle(name, { exact: true }) });

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel('Benutzername').fill('e2e');
  await page.getByLabel('Anzeigename').fill('E2E');
  await page.getByLabel('Passwort', { exact: true }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page).toHaveURL(/\/files/);

  await page.getByRole('button', { name: 'Neu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ordner', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Projekte');
  await page.keyboard.press('Enter');
  await expect(row('Projekte')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles({ name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('hallo') });
  await expect(row('notiz.txt')).toBeVisible();

  await row('notiz.txt').click();
  await page.keyboard.press('F2');
  await page.getByRole('dialog').getByRole('textbox').fill('notiz-neu.txt');
  await page.keyboard.press('Enter');
  await expect(row('notiz-neu.txt')).toBeVisible();
  await expect(row('notiz.txt')).toBeHidden();

  // Double-click on a previewable file opens QuickLook (Phase 1b); downloads go through the menu.
  await row('notiz-neu.txt').dblclick();
  const quickLook = page.getByRole('dialog', { name: 'notiz-neu.txt' });
  await expect(quickLook.getByText('hallo')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(quickLook).toBeHidden();

  const downloadPromise = page.waitForEvent('download');
  await row('notiz-neu.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Herunterladen' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('notiz-neu.txt');
  expect(await readFile(await download.path(), 'utf8')).toBe('hallo');

  await row('notiz-neu.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Verschieben' }).click();
  await page.getByRole('dialog').getByRole('treeitem', { name: 'Projekte' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Nach „Projekte“ verschieben' }).click();
  await expect(row('notiz-neu.txt')).toBeHidden();

  await row('Projekte').dblclick();
  await expect(page).toHaveURL(/\/files\/.+/);
  await expect(row('notiz-neu.txt')).toBeVisible();
  await row('notiz-neu.txt').click();
  await page.keyboard.press('Delete');
  await page.getByRole('alertdialog').getByRole('button', { name: 'In den Papierkorb' }).click();
  await expect(row('notiz-neu.txt')).toBeHidden();
});
