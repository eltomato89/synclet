// App Store images of the iOS app: the screenshots of scripts/ios-store-screenshots.sh in a device
// frame on a large folder (Synclet's promise: it stays a plain folder), with one headline and one
// sentence per image, in English and German. The first image is the hook: `ls` of the Photos
// folder next to the same folder in the app.
//
//   node scripts/store-images.ts
//
// Reads apps/ios/build/store-screenshots/{iphone,ipad}-{en,de}/0N-*.png and writes
// apps/ios/build/app-store/images/{iphone,ipad}-{en,de}/0N-*.png at the exact App Store sizes
// (iPhone 6.9" 1320 × 2868, iPad 13" 2752 × 2064), opaque RGB. Needs Playwright's Chromium.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { ROOT, SITE } from './sample-stack.ts';

const SHOTS = path.join(ROOT, 'apps/ios/build/store-screenshots');
const OUT = path.join(ROOT, 'apps/ios/build/app-store/images');
const FONT = readFileSync(path.join(SITE, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')).toString('base64');
const FONT_EXT = readFileSync(path.join(SITE, 'node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2')).toString('base64');

type Lang = 'en' | 'de';
// `term`: a terminal next to the device (command, then its output); `hero`: the dark first image.
type Scene = { out: string; shot: string; hero?: boolean; term?: { command: string; output: string[] }; copy: Record<Lang, { title: string; text: string }> };
/** What `ls -1 Photos` prints for the sample folder (GNU ls quotes names with spaces). */
const LS = ['Canyon.jpg', 'Cliffs.jpg', 'Coast.jpg', "'Desert road.jpg'", 'Dunes.jpg', "'Fjord morning.jpg'",
  "'Forest trail.jpg'", "'Glacier hike.jpg'", 'Harbour.jpg', "'Island ferry.jpg'", 'Lighthouse.jpg', "'Lisbon sunset.jpg'"];
/** `docker compose up -d` of deploy/compose.yml. */
const DOCKER = ['✔ Container synclet-postgres-1  Healthy', '✔ Container synclet-server-1    Started',
  '✔ Container synclet-worker-1    Started', '✔ Container synclet-caddy-1     Started'];

// The first image is the hook: a bare `ls` of the Photos folder next to the same folder in the app.
const SCENES: Scene[] = [
  { out: '01-folder', shot: '02-photos', hero: true, term: { command: 'ls -1 Photos', output: LS }, copy: {
    en: { title: 'It’s just a folder.', text: 'Synclet makes it a cloud drive for your iPhone, iPad, Mac and browser.' },
    de: { title: 'Es ist nur ein Ordner.', text: 'Synclet macht daraus einen Cloud-Speicher für iPhone, iPad, Mac und Browser.' },
  } },
  { out: '02-server', shot: '07-server', term: { command: 'docker compose up -d', output: DOCKER }, copy: {
    en: { title: 'Runs on your own server', text: 'The app connects to your Synclet server. You install it with Docker on a Linux machine or NAS.' },
    de: { title: 'Läuft auf deinem eigenen Server', text: 'Die App verbindet sich mit deinem Synclet-Server. Den installierst du per Docker auf einem Linux-Rechner oder NAS.' },
  } },
  { out: '03-files', shot: '01-files', copy: {
    en: { title: 'Your files stay files', text: 'No database blobs, no metadata in your folders. Stop using Synclet and nothing moves.' },
    de: { title: 'Deine Dateien bleiben Dateien', text: 'Keine Datenbank, keine Metadaten in deinen Ordnern. Hörst du auf, bleibt alles, wo es ist.' },
  } },
  { out: '04-preview', shot: '03-preview', copy: {
    en: { title: 'Tap to open', text: 'Photos, videos, PDFs and text files open right in the app.' },
    de: { title: 'Antippen und ansehen', text: 'Fotos, Videos, PDFs und Texte öffnen direkt in der App.' },
  } },
  { out: '05-spaces', shot: '04-spaces', copy: {
    en: { title: 'Shared with your family', text: 'Shared folders and your NAS shares, with read or write access per person.' },
    de: { title: 'Gemeinsam mit der Familie', text: 'Geteilte Ordner und deine NAS-Freigaben, mit Lese- oder Schreibrechten.' },
  } },
  { out: '06-search', shot: '05-search', copy: {
    en: { title: 'Finds what’s inside', text: 'Search looks at file names and the text in your documents.' },
    de: { title: 'Findet auch, was drinsteht', text: 'Die Suche kennt Dateinamen und den Text in deinen Dokumenten.' },
  } },
  { out: '07-share', shot: '06-share', copy: {
    en: { title: 'Share with a link', text: 'Add a password and an expiry date if you like.' },
    de: { title: 'Teilen per Link', text: 'Auf Wunsch mit Passwort und Ablaufdatum.' },
  } },
];

// Site tokens (apps/site/src/styles.css): Fog, Paper, Ink, Slate, Fjord.
const FOG = '#f2f6f6';
const INK = '#162325';
const SLATE = '#5d6b6d';
const FJORD = '#08808b';
const FJORD_LIGHT = '#cfe7e9';

type Device = { width: number; height: number; screenW: number; screenH: number; radius: number; bezel: number };
const DEVICES: Record<'iphone' | 'ipad', Device> = {
  iphone: { width: 1320, height: 2868, screenW: 1320, screenH: 2868, radius: 186, bezel: 34 },
  ipad: { width: 2752, height: 2064, screenW: 2752, screenH: 2064, radius: 60, bezel: 46 },
};

/** A folder: rounded body plus the tab on the top left (w × h, tab th high). */
function folder(w: number, h: number, th: number, r: number, fill: string) {
  const tw = w * 0.36;
  const d = `M0 ${th + r} Q0 ${th} ${r} ${th} L${r} ${th} L${r} ${r} Q${r} 0 ${2 * r} 0 L${tw - r} 0 Q${tw} 0 ${tw + r * 0.6} ${th * 0.55}
    L${tw + r * 1.4} ${th} L${w - r} ${th} Q${w} ${th} ${w} ${th + r} L${w} ${h} L0 ${h} Z`;
  return `<svg class="folder" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="${fill}"/></svg>`;
}

function page(kind: 'iphone' | 'ipad', scene: Scene, lang: Lang, shot: string) {
  const dev = DEVICES[kind];
  const hero = !!scene.hero;
  const bg = hero ? INK : FOG;
  const fg = hero ? '#f4f8f8' : INK;
  const muted = hero ? '#a9b8ba' : SLATE;
  const folderFill = hero ? FJORD : FJORD_LIGHT;
  const { title, text } = scene.copy[lang];
  const img = `data:image/png;base64,${shot}`;

  // Layout per device: device size and position, folder behind it, text block.
  let frame: { x: number; y: number; w: number };
  let fold: { x: number; y: number; w: number; h: number; th: number };
  let textCss: string;
  let term: { x: number; y: number; w: number; h: number; size: number } | null = null;
  if (kind === 'iphone') {
    frame = { x: 180, y: 860, w: 960 };
    fold = { x: 70, y: 700, w: 1180, h: 2400, th: 120 };
    textCss = 'left:110px; top:190px; width:1100px; --title:118px; --text:52px;';
    if (hero) {
      frame = { x: 590, y: 1060, w: 650 };
      term = { x: 80, y: 760, w: 640, h: 1080, size: 34 };
    } else if (scene.term) {
      // A short output: the terminal across the top, the device below it.
      frame = { x: 230, y: 1290, w: 860 };
      term = { x: 110, y: 830, w: 1100, h: 0, size: 33 };
    }
  } else {
    frame = { x: 1060, y: 330, w: 1740 };
    fold = { x: 940, y: 170, w: 1900, h: 2000, th: 130 };
    textCss = 'left:150px; top:560px; width:760px; --title:112px; --text:50px;';
    if (scene.term) {
      textCss = 'left:150px; top:200px; width:800px; --title:112px; --text:50px;';
      term = { x: 150, y: 900, w: 780, h: 1000, size: hero ? 38 : 30 };
    }
  }
  const s = frame.w / dev.screenW;
  const screenH = dev.screenH * s;
  const radius = dev.radius * s;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${FONT}) format('woff2'); font-weight: 100 900; unicode-range: U+0000-00FF, U+2010-2027; }
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${FONT_EXT}) format('woff2'); font-weight: 100 900; unicode-range: U+0100-024F, U+1E00-1EFF; }
html, body { margin: 0; width: ${dev.width}px; height: ${dev.height}px; overflow: hidden; background: ${bg}; }
body { position: relative; font-family: Inter, sans-serif; color: ${fg}; font-feature-settings: 'ss01', 'cv11'; }
.text { position: absolute; ${textCss} }
h1 { margin: 0; font-size: var(--title); line-height: 1.04; font-weight: 760; letter-spacing: -0.035em; text-wrap: balance; }
p { margin: 0.9em 0 0; font-size: var(--text); line-height: 1.35; font-weight: 450; color: ${muted}; max-width: 22em; text-wrap: pretty; }
.folder { position: absolute; left: ${fold.x}px; top: ${fold.y}px; }
.device { position: absolute; left: ${frame.x - dev.bezel}px; top: ${frame.y - dev.bezel}px; padding: ${dev.bezel}px;
  background: #0d1314; border-radius: ${radius + dev.bezel}px;
  box-shadow: 0 0 0 3px #3b4547 inset, 0 40px 90px -30px rgba(10, 30, 32, 0.55); }
.term { position: absolute; background: #0a1112; border-radius: 28px; box-shadow: 0 0 0 2px #2b3739 inset;
  font: 400 var(--mono)/1.5 'SF Mono', Menlo, ui-monospace, monospace; color: #c8d6d8; padding: 1.6em 1.4em; box-sizing: border-box; overflow: hidden; }
.term .prompt { color: #7fd1d8; }
.term div { white-space: pre; }
.term .bar { display: flex; gap: 14px; margin: -0.4em 0 1.1em; }
.term .bar i { width: 22px; height: 22px; border-radius: 50%; background: #2f3b3d; }
.device img { display: block; width: ${frame.w}px; height: ${screenH}px; border-radius: ${radius}px; }
</style></head><body>
${scene.term ? '' : folder(fold.w, fold.h, fold.th, 44, folderFill)}
${term ? `<div class="term" style="left:${term.x}px; top:${term.y}px; width:${term.w}px; ${hero ? `height:${term.h}px;` : ''} --mono:${term.size}px">
<div class="bar"><i></i><i></i><i></i></div><div><span class="prompt">~ $</span> ${scene.term!.command}</div>${scene.term!.output.map((n) => `<div>${n}</div>`).join('')}</div>` : ''}
<div class="device"><img src="${img}" alt=""></div>
<div class="text"><h1>${title}</h1><p>${text}</p></div>
</body></html>`;
}

const browser = await chromium.launch();
try {
  for (const set of readdirSync(SHOTS).filter((d) => /^(iphone|ipad)-(en|de)$/.test(d)).sort()) {
    const [kind, lang] = set.split('-') as ['iphone' | 'ipad', Lang];
    const dev = DEVICES[kind];
    const ctx = await browser.newContext({ viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: 1 });
    const pageHandle = await ctx.newPage();
    mkdirSync(path.join(OUT, set), { recursive: true });
    for (const scene of SCENES) {
      const file = path.join(SHOTS, set, `${scene.shot}.png`);
      if (!existsSync(file)) { console.warn(`missing ${path.relative(ROOT, file)}`); continue; }
      await pageHandle.setContent(page(kind, scene, lang, readFileSync(file).toString('base64')));
      await pageHandle.evaluate(() => document.fonts.ready);
      const out = path.join(OUT, set, `${scene.out}.png`);
      await sharp(await pageHandle.screenshot()).removeAlpha().png().toFile(out);
      console.log('wrote', path.relative(ROOT, out));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
