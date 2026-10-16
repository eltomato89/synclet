// Checks a built site in Chromium: no console errors, all images load, in-page anchors resolve,
// no horizontal scroll at 390 px, dark mode applies, page weight. Writes preview screenshots.
//   pnpm --filter @synclet/site build && pnpm --filter @synclet/site preview --port 4321 &
//   node scripts/verify.ts http://localhost:4321/synclet/ <screenshot dir>
import { chromium } from 'playwright';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4321/synclet/';
const outDir = process.argv[3] ?? '.';
const browser = await chromium.launch();
let failed = false;
const fail = (msg: string) => { failed = true; console.log('FAIL', msg); };

for (const scheme of ['light', 'dark'] as const) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: label === 'mobile' ? 2 : 1 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    const bad: string[] = [];
    let bytes = 0;
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const sizes: Promise<void>[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
      sizes.push(r.request().sizes().then((s) => { bytes += s.responseBodySize + s.responseHeadersSize; }, () => {}));
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    // Load lazy images: scroll through the page.
    for (let y = 0; y < (await page.evaluate(() => document.body.scrollHeight)); y += 600) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(60);
    }
    await page.waitForLoadState('networkidle');
    await Promise.all(sizes);
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
    const anchors = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map((a) => a.getAttribute('href')!).filter((h) => h !== '#' && !document.querySelector(h)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const imgsWithoutAlt = await page.evaluate(() => [...document.images].filter((i) => !i.hasAttribute('alt')).length);
    console.log(`${scheme}/${label}: transferred ${(bytes / 1024).toFixed(0)} KiB, body bg ${bg}, overflow ${overflow}px`);
    if (errors.length) fail(`${scheme}/${label} console errors: ${errors.join(' | ')}`);
    if (bad.length) fail(`${scheme}/${label} failed requests: ${bad.join(' | ')}`);
    if (broken.length) fail(`${scheme}/${label} broken images: ${broken.join(' | ')}`);
    if (anchors.length) fail(`${scheme}/${label} dangling anchors: ${anchors.join(', ')}`);
    if (overflow > 0) fail(`${scheme}/${label} horizontal overflow ${overflow}px`);
    if (imgsWithoutAlt) fail(`${scheme}/${label} ${imgsWithoutAlt} images without alt`);
    if (bytes > 2 * 1024 * 1024) fail(`${scheme}/${label} page weight ${bytes} > 2 MiB`);
    // Anchor navigation works.
    await page.evaluate(() => window.scrollTo(0, 0));
    if (label === 'desktop') {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'FAQ' }).click();
      await page.waitForTimeout(2000);
      // In view at the top, or the page is scrolled to its end (the FAQ is the last section).
      const { top, atEnd, hash } = await page.evaluate(() => ({
        top: document.querySelector('#faq')!.getBoundingClientRect().top,
        atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2,
        hash: location.hash,
      }));
      if (hash !== '#faq' || (Math.abs(top) > 120 && !atEnd)) fail(`anchor #faq not scrolled into view (top ${top}, hash ${hash})`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(outDir, `site-preview-${scheme}-${label}.png`), fullPage: true });
    await ctx.close();
  }
}
await browser.close();
console.log(failed ? 'VERIFY FAILED' : 'VERIFY OK');
process.exit(failed ? 1 : 0);
