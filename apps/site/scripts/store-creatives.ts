// App Store creative assets ("Header and Search Results", iOS 27): the hook of the store images
// (your own cloud: `ls` of the Photos folder at home next to the same folder in the app) as wide
// artwork, in English and German.
//
//   node scripts/store-creatives.ts
//
// Reads the screenshots of scripts/ios-store-screenshots.sh (02-photos of iPad and iPhone) and writes
// apps/ios/build/app-store/creatives/<lang>/{header-21x9,search-3x2,universal-16x9}.png at Apple's
// sizes (3840 × 1646, 3840 × 2560, 5244 × 2950), opaque RGB. Apple's exact safe areas are only in
// its design templates, so the key art stays in the middle and the edges carry only background.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ROOT, SITE } from './sample-stack.ts';

const SHOTS = path.join(ROOT, 'apps/ios/build/store-screenshots');
const OUT = path.join(ROOT, 'apps/ios/build/app-store/creatives');
const font = (f: string) => readFileSync(path.join(SITE, 'node_modules/@fontsource-variable/inter/files', f)).toString('base64');
const FONT = font('inter-latin-wght-normal.woff2');
const FONT_EXT = font('inter-latin-ext-wght-normal.woff2');

type Lang = 'en' | 'de';
const COPY: Record<Lang, { title: string; text: string; short: string }> = {
  en: { title: 'Your own cloud.', text: 'Your photos and files on your own server, not on someone else’s.', short: 'Your photos and files, on your own server.' },
  de: { title: 'Deine eigene Cloud.', text: 'Fotos und Dateien auf deinem eigenen Server statt bei einem Konzern.', short: 'Deine Fotos und Dateien, auf deinem eigenen Server.' },
};
const LS = ['Canyon.jpg', 'Cliffs.jpg', 'Coast.jpg', "'Desert road.jpg'", 'Dunes.jpg', "'Fjord morning.jpg'",
  "'Forest trail.jpg'", "'Glacier hike.jpg'", 'Harbour.jpg', "'Island ferry.jpg'", 'Lighthouse.jpg'];

// Site tokens (apps/site/src/styles.css).
const INK = '#162325';
const FJORD = '#08808b';

type Box = { x: number; y: number; w: number };
type Layout = {
  name: string; width: number; height: number;
  text: { x: number; y: number; w: number; title: number; size: number; align: 'left' | 'center'; short?: boolean };
  term?: Box & { size: number };
  ipad?: Box;
  iphone?: Box;
  folder: { x: number; y: number; w: number; h: number };
};
const LAYOUTS: Layout[] = [
  {
    name: 'header-21x9', width: 3840, height: 1646,
    text: { x: 380, y: 620, w: 1000, title: 120, size: 52, align: 'left' },
    term: { x: 1460, y: 420, w: 600, size: 34 },
    ipad: { x: 2160, y: 330, w: 1280 },
    folder: { x: 1980, y: 170, w: 1620, h: 1700 },
  },
  {
    name: 'search-3x2', width: 3840, height: 2560,
    text: { x: 520, y: 230, w: 2800, title: 150, size: 64, align: 'center', short: true },
    ipad: { x: 760, y: 760, w: 2080 },
    iphone: { x: 2620, y: 1020, w: 560 },
    folder: { x: 560, y: 600, w: 2720, h: 2200 },
  },
  {
    name: 'universal-16x9', width: 5244, height: 2950,
    text: { x: 1022, y: 260, w: 3200, title: 170, size: 70, align: 'center' },
    term: { x: 760, y: 980, w: 1060, size: 56 },
    ipad: { x: 1900, y: 860, w: 2240 },
    iphone: { x: 3860, y: 1160, w: 600 },
    folder: { x: 1700, y: 720, w: 2900, h: 2500 },
  },
];

/** A folder: rounded body plus the tab on the top left. */
function folder(w: number, h: number, th: number, r: number, fill: string) {
  const tw = w * 0.36;
  const d = `M0 ${th + r} Q0 ${th} ${r} ${th} L${r} ${th} L${r} ${r} Q${r} 0 ${2 * r} 0 L${tw - r} 0 Q${tw} 0 ${tw + r * 0.6} ${th * 0.55}
    L${tw + r * 1.4} ${th} L${w - r} ${th} Q${w} ${th} ${w} ${th + r} L${w} ${h} L0 ${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="${fill}"/></svg>`;
}

/** A device frame around a screenshot (w = screen width; screen size and corner from the shot). */
function device(box: Box, shot: { data: string; w: number; h: number }, radius: number, bezel: number) {
  const h = (shot.h * box.w) / shot.w;
  const r = radius * (box.w / shot.w);
  return `<div class="device" style="left:${box.x - bezel}px; top:${box.y - bezel}px; padding:${bezel}px; border-radius:${r + bezel}px">
<img src="data:image/png;base64,${shot.data}" style="width:${box.w}px; height:${h}px; border-radius:${r}px" alt=""></div>`;
}

function page(l: Layout, lang: Lang, ipad: { data: string; w: number; h: number }, iphone: { data: string; w: number; h: number }) {
  const c = COPY[lang];
  const t = l.text;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${FONT}) format('woff2'); font-weight: 100 900; unicode-range: U+0000-00FF, U+2010-2027; }
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${FONT_EXT}) format('woff2'); font-weight: 100 900; unicode-range: U+0100-024F, U+1E00-1EFF; }
html, body { margin: 0; width: ${l.width}px; height: ${l.height}px; overflow: hidden; background: ${INK}; }
body { position: relative; font-family: Inter, sans-serif; color: #f4f8f8; }
.abs, .device, .term, svg { position: absolute; }
.text { left: ${t.x}px; top: ${t.y}px; width: ${t.w}px; text-align: ${t.align}; }
h1 { margin: 0; font-size: ${t.title}px; line-height: 1.04; font-weight: 760; letter-spacing: -0.035em; text-wrap: balance; }
p { margin: 0.8em 0 0; font-size: ${t.size}px; line-height: 1.35; font-weight: 450; color: #a9b8ba; text-wrap: balance; }
.device { background: #0d1314; box-shadow: 0 0 0 3px #3b4547 inset, 0 60px 120px -40px rgba(0, 0, 0, 0.6); }
.device img { display: block; }
.term { background: #0a1112; border-radius: 30px; box-shadow: 0 0 0 2px #2b3739 inset, 0 40px 90px -30px rgba(0, 0, 0, 0.6);
  font: 400 var(--mono)/1.5 'SF Mono', Menlo, ui-monospace, monospace; color: #c8d6d8; padding: 1.4em 1.3em 1.6em; box-sizing: border-box; }
.term div { white-space: pre; }
.term .prompt { color: #7fd1d8; }
.term .bar { display: flex; gap: 0.5em; margin: -0.3em 0 1em; }
.term .bar i { width: 0.6em; height: 0.6em; border-radius: 50%; background: #2f3b3d; }
</style></head><body>
<div class="abs" style="left:${l.folder.x}px; top:${l.folder.y}px">${folder(l.folder.w, l.folder.h, l.folder.w * 0.07, l.folder.w * 0.025, FJORD)}</div>
${l.ipad ? device(l.ipad, ipad, 60, Math.round(l.ipad.w * 0.026)) : ''}
${l.iphone ? device(l.iphone, iphone, 186, Math.round(l.iphone.w * 0.035)) : ''}
${l.term ? `<div class="term" style="left:${l.term.x}px; top:${l.term.y}px; width:${l.term.w}px; --mono:${l.term.size}px">
<div class="bar"><i></i><i></i><i></i></div><div><span class="prompt">alex@home ~ $</span> ls -1 Photos</div>${LS.map((n) => `<div>${n}</div>`).join('')}</div>` : ''}
<div class="abs text"><h1>${c.title}</h1><p>${t.short ? c.short : c.text}</p></div>
</body></html>`;
}

async function shot(file: string) {
  const meta = await sharp(file).metadata();
  return { data: readFileSync(file).toString('base64'), w: meta.width!, h: meta.height! };
}

const browser = await chromium.launch();
try {
  for (const lang of ['en', 'de'] as const) {
    const ipad = await shot(path.join(SHOTS, `ipad-${lang}`, '02-photos.png'));
    const iphone = await shot(path.join(SHOTS, `iphone-${lang}`, '02-photos.png'));
    mkdirSync(path.join(OUT, lang), { recursive: true });
    for (const l of LAYOUTS) {
      const ctx = await browser.newContext({ viewport: { width: l.width, height: l.height }, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      await p.setContent(page(l, lang, ipad, iphone));
      await p.evaluate(() => document.fonts.ready);
      const out = path.join(OUT, lang, `${l.name}.png`);
      await sharp(await p.screenshot()).removeAlpha().png().toFile(out);
      console.log('wrote', path.relative(ROOT, out));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
