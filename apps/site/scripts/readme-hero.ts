// Composes the README hero image from the sample-data screenshots in src/assets/screenshots/.
//
//   pnpm --filter @synclet/site readme-hero
//
// Writes docs/assets/readme-hero-{light,dark}.webp (web app in a browser frame, phone layout in
// a phone frame, QuickLook preview and spaces as overlapping cards on a soft Synclet-colored
// background). Pure sharp composition; no browser or Docker needed.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../src/assets/screenshots');
const OUT = path.resolve(here, '../../../docs/assets');
const W = 1900;
const H = 1060;

type Mode = 'light' | 'dark';
const THEME = {
  light: { from: '#f4f8f8', to: '#dcecee', glow: '#7cc3c9', glowOpacity: 0.45, chrome: '#eef2f3', dots: ['#ff5f57', '#febc2e', '#28c840'], bezel: '#14191a', shadow: 0.28 },
  dark: { from: '#101516', to: '#17282b', glow: '#2a8f98', glowOpacity: 0.3, chrome: '#232b2d', dots: ['#ff5f57', '#febc2e', '#28c840'], bezel: '#050707', shadow: 0.6 },
} as const;

const svg = (body: string, w = W, h = H) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);

async function shot(name: string, mode: Mode, width: number) {
  return sharp(path.join(SHOTS, `${name}-${mode}.webp`)).resize({ width }).png().toBuffer();
}

async function rounded(img: Buffer, radius: number) {
  const { width, height } = await sharp(img).metadata();
  const mask = svg(`<rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/>`, width, height);
  return sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function shadow(x: number, y: number, w: number, h: number, radius: number, opacity: number) {
  const pad = 120;
  const body = svg(`<rect x="${pad}" y="${pad + 28}" width="${w}" height="${h}" rx="${radius}" fill="#0b1e22" fill-opacity="${opacity}"/>`, w + pad * 2, h + pad * 2);
  const input = await sharp(body).blur(36).png().toBuffer();
  return { input, left: x - pad, top: y - pad };
}

async function card(name: string, mode: Mode, x: number, y: number, w: number, radius: number) {
  const t = THEME[mode];
  const img = await rounded(await shot(name, mode, w), radius);
  const h = (await sharp(img).metadata()).height!;
  return [await shadow(x, y, w, h, radius, t.shadow), { input: img, left: x, top: y }];
}

async function compose(mode: Mode) {
  const t = THEME[mode];
  const bg = svg(`<defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient>
    <radialGradient id="r" cx="0.72" cy="0.3" r="0.55"><stop offset="0" stop-color="${t.glow}" stop-opacity="${t.glowOpacity}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
  </defs><rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/>`);

  const layers: sharp.OverlayOptions[] = [];

  // Browser window with the web app.
  const bx = 70, by = 70, bw = 1180, bar = 46, r = 18;
  const content = await shot('files', mode, bw);
  const ch = (await sharp(content).metadata()).height!;
  const winH = ch + bar;
  const frame = svg(
    `<rect width="${bw}" height="${winH}" rx="${r}" fill="${t.chrome}"/>` +
      t.dots.map((c, i) => `<circle cx="${28 + i * 24}" cy="${bar / 2}" r="7" fill="${c}"/>`).join('') +
      `<rect x="${bw / 2 - 210}" y="11" width="420" height="24" rx="12" fill="${mode === 'light' ? '#fff' : '#101516'}" fill-opacity="0.8"/>` +
      `<text x="${bw / 2}" y="28" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="${mode === 'light' ? '#5b6b6e' : '#9fb0b3'}">synclet.example.com</text>`,
    bw, winH,
  );
  const win = await rounded(
    await sharp(frame).composite([{ input: content, left: 0, top: bar }]).png().toBuffer(),
    r,
  );
  layers.push(await shadow(bx, by, bw, winH, r, t.shadow), { input: win, left: bx, top: by });

  // QuickLook preview card in front of the window's right edge, behind the phone.
  layers.push(...(await card('preview', mode, 880, 330, 660, 16)) as sharp.OverlayOptions[]);

  // Spaces card overlapping the window's lower left.
  layers.push(...(await card('spaces', mode, 330, 700, 780, 14)) as sharp.OverlayOptions[]);

  // Phone.
  const px = 1490, py = 120, pw = 370, bez = 12;
  const screen = await rounded(await shot('mobile', mode, pw - bez * 2), 40);
  const sh = (await sharp(screen).metadata()).height!;
  const ph = sh + bez * 2;
  const body = svg(`<rect width="${pw}" height="${ph}" rx="${52}" fill="${t.bezel}"/>`, pw, ph);
  const phone = await sharp(body).composite([{ input: screen, left: bez, top: bez }]).png().toBuffer();
  layers.push(await shadow(px, py, pw, ph, 52, t.shadow + 0.1), { input: phone, left: px, top: py });

  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `readme-hero-${mode}.webp`);
  const info = await sharp(bg).composite(layers).webp({ quality: 82, effort: 6 }).toFile(file);
  console.log(`${file} ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

await compose('light');
await compose('dark');
