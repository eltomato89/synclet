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
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request, type APIRequestContext, type Browser, type Page } from 'playwright';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, '..');
const ROOT = path.resolve(SITE, '../..');
const OUT = path.join(SITE, 'src/assets/screenshots');
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 18181);
const BASE = `http://localhost:${PORT}`;
const TAG = `site-${process.pid}`;
const PROJECT = `synclet-site-shots-${process.pid}`;
const ADMIN = { username: 'alex', displayName: 'Alex Morgan', password: 'sample password 2026' };
const PEOPLE = [
  { username: 'sam', displayName: 'Sam Morgan' },
  { username: 'robin', displayName: 'Robin Morgan' },
];

const WORK = mkdtempSync(path.join(os.tmpdir(), 'synclet-site-shots-'));
for (const d of ['files', 'meta', 'teams', 'archive/Scans 2019']) mkdirSync(path.join(WORK, d), { recursive: true });
writeFileSync(path.join(WORK, 'archive/Scans 2019/README.txt'), 'Sample external storage for the Synclet website.\n');

writeFileSync(path.join(WORK, '.env'), [
  `SYNCLET_DATA=${WORK}/files`,
  `SYNCLET_META=${WORK}/meta`,
  `SYNCLET_TEAMS=${WORK}/teams`,
  `PUID=${process.getuid?.() ?? 1000}`,
  `PGID=${process.getgid?.() ?? 1000}`,
  'POSTGRES_PASSWORD=sampleonly',
  `SYNCLET_PORT=${PORT}`,
  `SYNCLET_TLS_PORT=${PORT + 1}`,
  'SYNCLET_SITE_ADDRESS=:80',
  `SYNCLET_PUBLIC_URL=${BASE}`,
  'SYNCLET_VERSIONS=on',
  '',
].join('\n'));

// Own image tags (never touch synclet/*:dev) and an external storage mounted at /storage/Archive.
writeFileSync(path.join(WORK, 'compose.site.yml'), `services:
  server:
    image: synclet-site/server:${TAG}
    volumes:
      - ${WORK}/archive:/storage/Archive
  worker:
    image: synclet-site/server:${TAG}
    pull_policy: never
    volumes:
      - ${WORK}/archive:/storage/Archive:ro
  caddy:
    image: synclet-site/caddy:${TAG}
`);

const DC = ['compose', '-p', PROJECT, '-f', path.join(ROOT, 'deploy/compose.yml'), '-f', path.join(WORK, 'compose.site.yml'), '--env-file', path.join(WORK, '.env')];
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'inherit' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (process.env.SITE_SHOTS_KEEP === '1') { console.log(`kept: ${BASE} (docker ${DC.join(' ')} down -v)`); return; }
  try { execFileSync('docker', [...DC, 'down', '-v'], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { execFileSync('docker', ['image', 'rm', `synclet-site/server:${TAG}`, `synclet-site/caddy:${TAG}`], { stdio: 'ignore' }); } catch { /* not built */ }
  rmSync(WORK, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { cleanup(); process.exit(130); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`${url} did not become ready`);
}

// ---------------------------------------------------------------------------------------------
// Sample content (generated, no real data)

type Palette = { sky: [string, string]; sun: string; far: string; mid: string; near: string; water?: string };
const PALETTES: Record<string, Palette> = {
  'Fjord morning.jpg': { sky: ['#bfe3ea', '#f6e7cf'], sun: '#fff4d6', far: '#8fb7c2', mid: '#4f8796', near: '#23525e', water: '#6fa9b7' },
  'Lisbon sunset.jpg': { sky: ['#f7a26b', '#fbd9a0'], sun: '#fff1c7', far: '#d98a74', mid: '#a45d5d', near: '#5b3446' },
  'Mountain lake.jpg': { sky: ['#9ccbe8', '#e5f2f7'], sun: '#ffffff', far: '#a9c1cf', mid: '#5e8a6e', near: '#2f5a43', water: '#7fb2c7' },
  'Desert road.jpg': { sky: ['#f3c98b', '#fbeed3'], sun: '#fff8e7', far: '#e2a873', mid: '#c27a4d', near: '#7d4a2d' },
  'Northern lights.jpg': { sky: ['#0f2a3a', '#1f6e6a'], sun: '#c9fff1', far: '#1d3c4c', mid: '#14303d', near: '#0a1a22', water: '#1b4a55' },
  'Harbour.jpg': { sky: ['#a7d0db', '#eef6f3'], sun: '#fffbe9', far: '#9bb8c0', mid: '#6d8f99', near: '#38535c', water: '#5d97a8' },
  'Forest trail.jpg': { sky: ['#cfe6c8', '#f4f8e9'], sun: '#fffde8', far: '#9fc39a', mid: '#5d8f5a', near: '#2d5434' },
  'Coast.jpg': { sky: ['#8fc6e0', '#f0f7f8'], sun: '#ffffff', far: '#b5cdd3', mid: '#86a6a0', near: '#4d6e61', water: '#3f8fb0' },
};

function ridge(seed: number, base: number, amp: number, w: number, h: number): string {
  let pts = `0,${h} `;
  for (let x = 0; x <= w; x += w / 24) {
    const y = base + Math.sin(x / w * Math.PI * (2 + seed) + seed) * amp + Math.sin(x / w * Math.PI * 7 + seed * 3) * amp * 0.35;
    pts += `${x.toFixed(0)},${y.toFixed(0)} `;
  }
  return `${pts}${w},${h}`;
}

function landscapeSvg(p: Palette, seed: number, w = 2400, h = 1600): string {
  const aurora = p.sky[0] === '#0f2a3a'
    ? `<path d="M0 ${h * 0.35} C ${w * 0.3} ${h * 0.1}, ${w * 0.6} ${h * 0.5}, ${w} ${h * 0.2}" stroke="#6ff7c6" stroke-opacity=".45" stroke-width="120" fill="none" filter="url(#blur)"/>`
    : '';
  const water = p.water
    ? `<rect y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="${p.water}"/><rect y="${h * 0.74}" width="${w}" height="6" fill="#fff" opacity=".25"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="40"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  ${aurora}
  <circle cx="${w * (0.25 + (seed % 3) * 0.22)}" cy="${h * 0.3}" r="${h * 0.09}" fill="${p.sun}" opacity=".9"/>
  <polygon points="${ridge(seed, h * 0.5, h * 0.08, w, h)}" fill="${p.far}"/>
  <polygon points="${ridge(seed + 1.3, h * 0.6, h * 0.07, w, h)}" fill="${p.mid}"/>
  ${water}
  <polygon points="${ridge(seed + 2.1, h * 0.82, h * 0.05, w, h)}" fill="${p.near}"/>
</svg>`;
}

const photo = (name: string, i: number) => sharp(Buffer.from(landscapeSvg(PALETTES[name], i + 0.4))).jpeg({ quality: 82 }).toBuffer();

/** A simple one-page PDF (A5) with a title and lines of Helvetica text. */
function samplePdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 520;
  let stream = `0.0 0.46 0.54 rg 40 ${y} m 380 ${y} l 380 ${y + 2} l 40 ${y + 2} l f 0.08 0.11 0.12 rg BT /F2 20 Tf 40 ${y + 16} Td (${esc(title)}) Tj ET`;
  y -= 30;
  for (const line of lines) { stream += ` BT /F1 11 Tf 40 ${y} Td (${esc(line)}) Tj ET`; y -= 18; }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const READING_LIST = `# Reading list

- [x] *The Overstory*, Richard Powers
- [ ] *A Psalm for the Wild-Built*, Becky Chambers
- [ ] *Braiding Sweetgrass*, Robin Wall Kimmerer

> Sample file generated for the Synclet website.
`;

// ---------------------------------------------------------------------------------------------
// API helpers

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
async function mkdir(api: APIRequestContext, parentId: string, name: string) {
  return (await json<{ id: string }>(await api.post('/api/sync/v1/items', { data: { parentId, type: 'folder', name } }), `mkdir ${name}`)).id;
}
async function upload(api: APIRequestContext, parentId: string, name: string, data: Buffer | string) {
  const res = await api.post(`/api/sync/v1/items/upload?parentId=${encodeURIComponent(parentId)}&name=${encodeURIComponent(name)}`, {
    headers: { 'content-type': 'application/octet-stream' },
    data: typeof data === 'string' ? Buffer.from(data) : data,
  });
  return (await json<{ id: string }>(res, `upload ${name}`)).id;
}
async function waitForThumbnail(api: APIRequestContext, id: string) {
  for (let i = 0; i < 180; i++) {
    if ((await api.get(`/api/sync/v1/items/${id}/thumbnail`)).status() === 200) return;
    await sleep(500);
  }
  throw new Error(`no thumbnail for ${id}`);
}

async function seed(): Promise<void> {
  const anon = await request.newContext({ baseURL: BASE });
  const setup = await json<{ accessToken: string; user: { id: string } }>(await anon.post('/api/setup', { data: ADMIN }), 'setup');
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${setup.accessToken}` } });

  const people: string[] = [];
  for (const p of PEOPLE) {
    people.push((await json<{ id: string }>(await api.post('/api/admin/users', { data: { ...p, password: ADMIN.password } }), `user ${p.username}`)).id);
  }
  const group = await json<{ id: string }>(await api.post('/api/admin/groups', { data: { name: 'Family' } }), 'group');
  await json(await api.patch(`/api/admin/groups/${group.id}`, { data: { memberIds: [setup.user.id, ...people] } }), 'group members');

  // Personal folder.
  const thumbs: string[] = [];
  const photos = await mkdir(api, 'root', 'Photos');
  await mkdir(api, 'root', 'Projects');
  const docs = await mkdir(api, 'root', 'Documents');
  await mkdir(api, 'root', 'Music');
  const names = Object.keys(PALETTES);
  for (const [i, name] of names.entries()) thumbs.push(await upload(api, 'root', name, await photo(name, i)));
  for (const [i, name] of names.entries()) thumbs.push(await upload(api, photos, name, await photo(name, i)));
  thumbs.push(await upload(api, 'root', 'Itinerary.pdf', samplePdf('Itinerary', [
    'Day 1  Arrive in Bergen, walk the harbour', 'Day 2  Ferry along the fjord', 'Day 3  Hike to the lake, picnic',
    'Day 4  Train back over the mountains', '', 'Sample document for the Synclet website.',
  ])));
  await upload(api, 'root', 'Reading list.md', READING_LIST);
  thumbs.push(await upload(api, 'root', 'Lease agreement.pdf', samplePdf('Lease agreement', [
    'Flat 3, 12 Harbour Street', 'Term: 12 months from 1 November 2026', '', 'Sample document for the Synclet website.',
  ])));
  await upload(api, 'root', 'Packing list.txt', 'Rain jacket\nHiking boots\nCamera\nCharger\n');
  await upload(api, 'root', 'Budget 2026.csv', 'Month,Planned,Spent\nJanuary,1200,1150\nFebruary,1200,1235\n');
  await upload(api, docs, 'Notes.txt', 'Sample notes for the Synclet website.\n');

  // Team folder "Family" (the group writes) and the external storage "Archive" (read only).
  const family = await json<{ id: string }>(await api.post('/api/admin/spaces', { data: { name: 'Family' } }), 'team space');
  await json(await api.patch(`/api/admin/spaces/${family.id}`, { data: { members: [{ kind: 'group', id: group.id, role: 'write' }] } }), 'team members');
  const famRoot = `r_${family.id}`;
  await mkdir(api, famRoot, 'Holidays 2026');
  await mkdir(api, famRoot, 'Recipes');
  thumbs.push(await upload(api, famRoot, 'Summer house.jpg', await photo('Coast.jpg', 9)));
  await upload(api, famRoot, 'Shopping list.md', '# Shopping\n\n- Bread\n- Apples\n- Coffee\n');

  const spaces = await json<Array<{ id: string; name: string; kind: string }>>(await api.get('/api/admin/spaces'), 'spaces');
  const archive = (Array.isArray(spaces) ? spaces : (spaces as unknown as { spaces: typeof spaces }).spaces).find((s) => s.name === 'Archive');
  if (archive) {
    await json(await api.patch(`/api/admin/spaces/${archive.id}`, { data: { members: [{ kind: 'group', id: group.id, role: 'read' }] } }), 'archive members');
  } else {
    console.warn('external storage "Archive" not found; the spaces page shows only the team folder');
  }

  for (const id of thumbs) await waitForThumbnail(api, id);
  await api.dispose();
  await anon.dispose();
}

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

console.log(`== throwaway stack ${PROJECT} on ${BASE} (work dir ${WORK})`);
docker(...DC, 'up', '-d', '--build');
await waitFor(`${BASE}/api/health`, 240);
await seed();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  await capture(browser, 'light');
  await capture(browser, 'dark');
} finally {
  await browser.close();
}
console.log('done');
