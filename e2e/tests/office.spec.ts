import { expect, test } from '@playwright/test';
import { E2E, mkdir, row, signIn } from './helpers';

test.use({ locale: 'en-US' });

// Needs the Document Server (E2E_OFFICE=1 scripts/e2e-fresh.sh). Saving goes through the server's
// callback endpoint, which is covered by the server tests (office.*.spec.ts).
test('a new document opens in the Euro-Office editor', async ({ page, context }) => {
  test.skip(!E2E.office, 'E2E_OFFICE=1 not set (no Document Server in the stack)');
  test.setTimeout(180_000);
  const user = await signIn(page, 'office');
  const folderId = await mkdir(user.api, 'root', 'Büro');
  await page.goto(`/files/${folderId}`);
  await expect(page.getByText('This folder is empty')).toBeVisible();

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Document', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByRole('textbox').fill('Bericht');
  const popupPromise = context.waitForEvent('page');
  await dialog.getByRole('button', { name: 'Create and open' }).click();
  await expect(row(page, 'Bericht.docx')).toBeVisible();

  const editor = await popupPromise;
  await expect(editor).toHaveURL(/\/office\/f_/);
  // DocsAPI replaces the placeholder with the editor iframe served by the Document Server
  // (below /documentserver of the Synclet site).
  const frame = editor.locator('iframe[name="frameEditor"]');
  await expect(frame).toBeAttached({ timeout: 90_000 });
  expect(new URL((await frame.getAttribute('src'))!, editor.url()).href.startsWith(`${E2E.officeUrl}/`)).toBe(true);
  // The editor app inside the frame has loaded the document (its canvas area exists).
  await expect(editor.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk')).toBeAttached({ timeout: 120_000 });
});
