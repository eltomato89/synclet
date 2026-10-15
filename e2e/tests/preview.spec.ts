import { expect, type Page, test } from '@playwright/test';
import { fixture, mkdir, newUser, row, signIn, textPdf, upload, waitForThumbnail } from './helpers';

test.use({ locale: 'en-US' });

const HOSTILE_MD = [
  '# Release notes',
  '',
  'Some **bold** text and a [safe link](https://example.org).',
  '',
  '<img src="x" onerror="window.__xss = 1">',
  '<script>window.__xss = 2</script>',
  '[bad link](javascript:window.__xss=3)',
  '',
  '- [x] done',
].join('\n');

async function openPreview(page: Page, name: string) {
  await row(page, name).click();
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('QuickLook shows images, PDFs, sanitized markdown and video; thumbnails appear in the list', async ({ page }) => {
  const user = await newUser('preview');
  const folder = await mkdir(user.api, 'root', 'Media');
  const jpg = await upload(user.api, folder, 'photo.jpg', fixture('rotated.jpg'));
  await upload(user.api, folder, 'invoice.pdf', textPdf('Invoice 42'));
  await upload(user.api, folder, 'notes.md', HOSTILE_MD);
  await upload(user.api, folder, 'clip.mp4', fixture('sample.mp4'));
  await waitForThumbnail(user.api, jpg);
  await signIn(page, user);
  await row(page, 'Media').dblclick();

  // Thumbnail from the worker replaces the file icon.
  await expect(row(page, 'photo.jpg').locator('[data-thumb="loaded"] img')).toBeVisible();

  let dialog = await openPreview(page, 'photo.jpg');
  const img = dialog.locator('img').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  dialog = await openPreview(page, 'invoice.pdf');
  const frame = dialog.locator('iframe[title="invoice.pdf"]');
  await expect(frame).toBeAttached();
  expect(await frame.getAttribute('src')).toMatch(/\/api\/sync\/v1\/items\/[^/]+\/content\?/);
  // The framed URL really is the PDF, served as such.
  const pdf = await page.request.get((await frame.getAttribute('src'))!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  dialog = await openPreview(page, 'notes.md');
  const article = dialog.locator('article');
  await expect(article.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(article.locator('strong')).toHaveText('bold');
  await expect(article.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.org');
  await expect(article.locator('img, script, [onerror]')).toHaveCount(0);
  expect(await article.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))).not.toContainEqual(expect.stringMatching(/^javascript:/i));
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  dialog = await openPreview(page, 'clip.mp4');
  const video = dialog.locator('video');
  await expect(video).toBeAttached();
  expect(await video.getAttribute('src')).toMatch(/\/content\?/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
