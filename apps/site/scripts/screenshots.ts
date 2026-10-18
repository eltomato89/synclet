// Reproducible screenshots of the web app for the website, made with SAMPLE data only.
//
//   pnpm --filter @synclet/site screenshots
//
// Starts a throwaway Synclet stack (own compose project, own image tags, own temp folders), creates
// an administrator through the setup API, uploads generated sample files (procedural landscape
// photos, a PDF, a Markdown note), sets up a team space "Family" plus an external storage
// "Archive", and captures the web app in light and dark mode. The images land in
// src/assets/screenshots/ as WebP. Only this script's own stack, images and temp folders are
// removed afterwards (SITE_SHOTS_KEEP=1 keeps the stack running for inspection).
//
// Needs Docker (with Compose) and Playwright's Chromium (`pnpm exec playwright install chromium`).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { ADMIN, json, seed, SITE, sleep, startSampleStack } from './sample-stack.ts';

const OUT = path.join(SITE, 'src/assets/screenshots');
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 18181);

// ---------------------------------------------------------------------------------------------
// Captures

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.evaluate(() => document.fonts.ready);
  await sleep(600);
}

async function save(buf: Buffer, name: string, width: number) {
  const out = path.join(OUT, `${name}.webp`);
  await sharp(buf).resize({ width, withoutEnlargement: true }).webp({ quality: 80, effort: 6 }).toFile(out);
  console.log('wrote', path.relative(SITE, out));
}

async function capture(browser: Browser, scheme: 'light' | 'dark') {
  const desktop = await browser.newContext({ baseURL: BASE, locale: 'en-US', colorScheme: scheme, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await desktop.addInitScript(() => { try { localStorage.setItem('synclet.files.view', '"grid"'); } catch { /* ignore */ } });
  const page = await desktop.newPage();
  await json(await page.request.post('/api/auth/login', { data: { login: ADMIN.username, password: ADMIN.password } }), 'login');

  await page.goto('/files');
  await page.locator('#main').waitFor();
  await page.getByTitle('Itinerary.pdf', { exact: true }).first().waitFor();
  await settle(page);
  await save(await page.screenshot(), `files-${scheme}`, 2000);

  await page.getByTitle('Fjord morning.jpg', { exact: true }).first().click();
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name: 'Fjord morning.jpg' });
  await dialog.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] img')].some((i) => (i as HTMLImageElement).naturalWidth > 0));
  await settle(page);
  await save(await page.screenshot(), `preview-${scheme}`, 2000);
  await page.keyboard.press('Escape');

  await page.goto('/admin/spaces');
  await page.getByRole('table', { name: 'Spaces' }).waitFor();
  await settle(page);
  // Only the table: the rest of the page is empty with two spaces.
  await save(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 560 } }), `spaces-${scheme}`, 2000);
  await desktop.close();

  const phone = await browser.newContext({ baseURL: BASE, locale: 'en-US', colorScheme: scheme, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addInitScript(() => { try { localStorage.setItem('synclet.files.view', '"grid"'); } catch { /* ignore */ } });
  const mobile = await phone.newPage();
  await json(await mobile.request.post('/api/auth/login', { data: { login: ADMIN.username, password: ADMIN.password } }), 'login');
  await mobile.goto('/files');
  await mobile.getByTitle('Itinerary.pdf', { exact: true }).first().waitFor();
  await settle(mobile);
  await save(await mobile.screenshot(), `mobile-${scheme}`, 600);
  await phone.close();
}

const BASE = await startSampleStack('site-shots', PORT);
await seed(BASE);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  await capture(browser, 'light');
  await capture(browser, 'dark');
} finally {
  await browser.close();
}
console.log('done');
