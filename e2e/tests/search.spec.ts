import { expect, test } from '@playwright/test';
import { mkdir, signIn, textPdf, upload } from './helpers';

test.use({ locale: 'en-US' });

test('⌘K finds a file by its content; Enter opens its folder with QuickLook', async ({ page }) => {
  const user = await signIn(page, 'search');
  const folderId = await mkdir(user.api, 'root', 'Finance');
  await mkdir(user.api, 'root', 'Other');
  const pdfId = await upload(user.api, folderId, 'q3-report.pdf', textPdf('Quarterly brimstone figures'));
  // The worker extracts the text asynchronously: wait until the content is indexed.
  await expect.poll(async () => {
    const res = await user.api.get('/api/sync/v1/search?q=brimstone');
    return (await res.json()).hits.map((h: { item: { id: string }; matched: string }) => `${h.item.id}:${h.matched}`);
  }, { timeout: 90_000, intervals: [500, 1000] }).toEqual([`${pdfId}:content`]);
  await page.reload();
  await expect(page.getByRole('grid')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search' });
  await expect(input).toBeFocused();
  await input.fill('brimstone');
  const results = page.getByRole('listbox', { name: 'Search results' });
  const hit = results.getByRole('option').filter({ hasText: 'q3-report.pdf' });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('brimstone'); // content snippet
  await expect(results.getByRole('option')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/files/${folderId}(\\?|$)`));
  const quickLook = page.getByRole('dialog', { name: 'q3-report.pdf' });
  await expect(quickLook).toBeVisible();
  await expect(quickLook.locator('iframe[title="q3-report.pdf"]')).toBeAttached();
});
