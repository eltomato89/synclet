// The animated hero: the web app and the iPhone app browsing the same sample "Photos" folder.
//
//   pnpm --filter @synclet/site hero-motion
//
// Starts the throwaway sample stack (sample-stack.ts), records the web app with Playwright and the
// iOS app in a private simulator (UI test HeroFlowUITests, `xcrun simctl io recordVideo`), in light
// and dark mode, and writes
//   docs/assets/readme-hero-{light,dark}.gif           browser + phone on the hero background (README)
//   apps/site/src/assets/hero/{web,phone}-{mode}.mp4|webm|webp   the two screens alone (website frames)
// Still stretches (UI-test waits, loading) are cut out, so the motion runs at its natural speed; every
// clip is a seamless loop (its end cross-fades into its start). Only this script's stack,
// simulator and temp folders are removed afterwards.
//
// Needs Docker, Playwright's Chromium, Xcode with an iOS simulator (IOS_DEVICE, default
// "iPhone 18 Pro"), xcodegen and ffmpeg.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request, type Browser } from 'playwright';
import sharp from 'sharp';
import { ADMIN, json, ROOT, seed, SITE, sleep, startSampleStack } from './sample-stack.ts';

type Mode = 'light' | 'dark';
const MODES: Mode[] = ['light', 'dark'];
const PORT = Number(process.env.SITE_SHOTS_PORT ?? 18191);
const SITE_OUT = path.join(SITE, 'src/assets/hero');
const README_OUT = path.join(ROOT, 'docs/assets');
const WORK = mkdtempSync(path.join(os.tmpdir(), 'synclet-hero-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));
/** Raw recordings + scene timings stay here, so `HERO_COMPOSE_ONLY=1` can redo the composition without recording. */
const RAW = path.join(os.tmpdir(), 'synclet-hero-raw');

/** Length of the cross-fade that closes every loop; the loop itself lasts as long as the slower screen's motion plus LEAD and HOLD. */
const FADE = 0.4;
const WEB = { width: 1280, height: 800 };

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts }).toString();
const ffmpeg = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

interface Clip { file: string; start: number; end: number }

// ---------------------------------------------------------------------------------------------
// Web: Playwright's video of one browser context

async function recordWeb(browser: Browser, base: string, photosId: string, mode: Mode): Promise<Clip> {
  const dir = path.join(WORK, `web-${mode}`);
  const context = await browser.newContext({
    baseURL: base, locale: 'en-US', colorScheme: mode, viewport: WEB, deviceScaleFactor: 1,
    recordVideo: { dir, size: WEB },
  });
  await context.addInitScript(() => { try { localStorage.setItem('synclet.files.view', '"grid"'); } catch { /* ignore */ } });
  // Playwright's video has no mouse pointer: draw one that follows the (synthetic) mouse.
  await context.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const pointer = document.createElement('div');
      pointer.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 16 L20 16 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
      Object.assign(pointer.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / .35))' });
      document.body.append(pointer);
      addEventListener('mousemove', (e) => { pointer.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 2}px)`; }, true);
    });
  });
  const t0 = Date.now();
  const page = await context.newPage();
  await json(await page.request.post('/api/auth/login', { data: { login: ADMIN.username, password: ADMIN.password } }), 'login');
  await page.goto(`/files/${photosId}`);
  await page.getByTitle('Glacier hike.jpg', { exact: true }).first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.evaluate(() => document.fonts.ready);
  await sleep(800);
  await page.mouse.move(WEB.width * 0.62, WEB.height * 0.55);
  await sleep(300);

  const start = (Date.now() - t0) / 1000;
  await page.mouse.move(WEB.width * 0.58, WEB.height * 0.62, { steps: 6 });
  // A calm scroll: small wheel steps instead of one jump.
  for (let i = 0; i < 34; i++) { await page.mouse.wheel(0, 10); await sleep(26); }
  await sleep(200);
  // Preview a photo that is now in view (click selects it, Space opens QuickLook).
  const target = page.getByTitle('Rainy pier.jpg', { exact: true }).first();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4, { steps: 18 });
  await sleep(120);
  await target.click();
  await page.keyboard.press('Space');
  await page.getByRole('dialog', { name: 'Rainy pier.jpg' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] img')].some((i) => (i as HTMLImageElement).naturalWidth > 0));
  await sleep(400);
  const end = (Date.now() - t0) / 1000;

  const video = page.video();
  await context.close();
  return { file: await video!.path(), start, end };
}

// ---------------------------------------------------------------------------------------------
// iOS: UI test in a private simulator, recorded with simctl

function iosSimulator(): { udid: string; dd: string; remove(): void } {
  const ios = path.join(ROOT, 'apps/ios');
  run('xcodegen', ['generate', '--quiet'], { cwd: ios });
  const udid = run('xcrun', ['simctl', 'create', `synclet-hero-${process.pid}`, process.env.IOS_DEVICE ?? 'iPhone 18 Pro']).trim();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try { run('xcrun', ['simctl', 'shutdown', udid]); } catch { /* not booted */ }
    try { run('xcrun', ['simctl', 'delete', udid]); return; } catch { /* see below */ }
    // CoreSimulator sometimes cannot move the device's data folder away (iOS 27): remove it, retry.
    try { rmSync(path.join(os.homedir(), 'Library/Developer/CoreSimulator/Devices', udid, 'data'), { recursive: true, force: true }); } catch { /* protected CloudStorage folder: simctl copes */ }
    try { run('xcrun', ['simctl', 'delete', udid]); } catch { console.warn(`WARN: simulator ${udid} not deleted`); }
  };
  process.on('exit', remove);
  run('xcrun', ['simctl', 'boot', udid]);
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  run('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active',
    '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100']);
  const dd = path.join(ios, '.build/hero-dd');
  console.log('== building the iOS app and UI tests');
  run('xcodebuild', ['build-for-testing', '-scheme', 'SyncletUITests', '-destination', `id=${udid}`, '-derivedDataPath', dd, '-quiet'], { cwd: ios });
  return { udid, dd, remove };
}

async function recordIos(sim: { udid: string; dd: string }, base: string, token: string, mode: Mode): Promise<Clip> {
  run('xcrun', ['simctl', 'ui', sim.udid, 'appearance', mode]);
  const file = path.join(WORK, `ios-${mode}.mov`);
  const signals = mkdtempSync(path.join(WORK, `signals-${mode}-`));
  const flag = (name: string) => path.join(signals, name);
  const until = async (what: () => boolean, seconds: number, label: string) => {
    for (let i = 0; i < seconds * 10; i++) { if (what()) return; await sleep(100); }
    throw new Error(`timed out waiting for ${label}`);
  };

  const test = spawn('xcodebuild', ['test-without-building', '-scheme', 'SyncletUITests', '-destination', `id=${sim.udid}`,
    '-derivedDataPath', sim.dd, '-only-testing:SyncletUITests/HeroFlowUITests', '-collect-test-diagnostics', 'never'], {
    cwd: path.join(ROOT, 'apps/ios'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEST_RUNNER_SYNCLET_UITEST_SERVER: base, TEST_RUNNER_SYNCLET_UITEST_TOKEN: token, TEST_RUNNER_SYNCLET_UITEST_HERO_DIR: signals },
  });
  let log = '';
  test.stdout.on('data', (d: Buffer) => { log += d.toString(); });
  test.stderr.on('data', (d: Buffer) => { log += d.toString(); });
  const testDone = new Promise<number>((resolve) => test.on('exit', (code) => resolve(code ?? 1)));
  let exited = false;
  void testDone.then(() => { exited = true; });
  const fail = (why: string) => new Error(`HeroFlowUITests: ${why}\n${log.split('\n').filter((l) => /error|failed|skipped/i.test(l)).slice(-30).join('\n')}`);

  // The test rehearses, then waits for "go"; record exactly the take.
  try { await until(() => existsSync(flag('ready')) || exited, 300, 'the test'); } catch (e) { test.kill(); throw fail(String(e)); }
  if (exited) throw fail('ended before the take');
  const rec = spawn('xcrun', ['simctl', 'io', sim.udid, 'recordVideo', '--codec', 'h264', '--force', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer) => { if (/Recording started/i.test(d.toString())) resolve(); };
    rec.stderr.on('data', onData);
    rec.stdout.on('data', onData);
    setTimeout(resolve, 5000);
  });
  await sleep(300);
  writeFileSync(flag('go'), '');
  try { await until(() => existsSync(flag('end')) || exited, 60, 'the take'); } catch (e) { rec.kill('SIGINT'); test.kill(); throw fail(String(e)); }
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('exit', r));
  if ((await testDone) !== 0) throw fail('failed');
  return { file, start: 0, end: Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim()) };
}

// ---------------------------------------------------------------------------------------------
// Composition

/**
 * Cuts a recording to its scene; with `cutStills` it also removes every still stretch (the iOS UI
 * test's waits for the app to idle), so only motion remains at its natural speed. The web take is
 * timed by the script itself and keeps its pauses. Writes a near-lossless 60 fps intermediate and
 * returns its length in seconds.
 */
function normalize(clip: Clip, out: string, opts: { cutStills: boolean }): Clip {
  const cut = opts.cutStills ? ',mpdecimate=hi=768:lo=320:frac=0.33,setpts=N/60/TB' : '';
  ffmpeg('-i', clip.file, '-vf', `trim=start=${clip.start.toFixed(3)}:end=${clip.end.toFixed(3)},setpts=PTS-STARTPTS,fps=60${cut}`, '-an', '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out);
  const len = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).trim());
  return { file: out, start: 0, end: len };
}

/** Still frames before the motion starts and after it ends (the last frame is held), and the loop length. */
const LEAD = 0.2;
const HOLD = 0.9;
const TOTAL = 4.0;
/** Speed-up (≤ 1 = unchanged) that fits a motion of `len` seconds into the loop. */
const speed = (len: number) => Math.min(1, (TOTAL - LEAD - HOLD) / len);

/**
 * ffmpeg filter that turns the normalized input `idx` into a `total`-second seamless loop labelled
 * `out`: the first frame is held for LEAD, the last one until total + FADE, and the last FADE seconds
 * cross-fade into the start.
 */
function loopFilter(idx: number, clip: Clip, total: number, fps: number, scale: string, out: string): string {
  const f = speed(clip.end);
  const stop = total + FADE - LEAD - clip.end * f;
  return `[${idx}:v]setpts=PTS*${f.toFixed(4)},tpad=start_mode=clone:start_duration=${LEAD}:stop_mode=clone:stop_duration=${stop.toFixed(3)},fps=${fps},${scale},split[${out}a][${out}b];`
    + `[${out}a]trim=start=${FADE},setpts=PTS-STARTPTS[${out}m];[${out}b]trim=end=${FADE},setpts=PTS-STARTPTS[${out}h];`
    + `[${out}m][${out}h]xfade=transition=fade:duration=${FADE}:offset=${(total - FADE).toFixed(3)},format=yuv420p[${out}]`;
}

const THEME = {
  light: { from: '#f4f8f8', to: '#dcecee', glow: '#7cc3c9', glowOpacity: 0.45, chrome: '#eef2f3', bar: '#ffffff', text: '#3b4f53', url: '#5b6b6e', bezel: '#14191a', shadow: 0.28 },
  dark: { from: '#101516', to: '#17282b', glow: '#2a8f98', glowOpacity: 0.3, chrome: '#232b2d', bar: '#121819', text: '#b9c9cc', url: '#93a3a6', bezel: '#050707', shadow: 0.6 },
} as const;

/** Canvas and screen rectangles of the README animation (pixels of the composed frame). */
const CANVAS = { w: 1600, h: 900 };
const BROWSER = { x: 60, y: 56, w: 1120, bar: 46, r: 18 };
const BROWSER_SCREEN = { x: BROWSER.x, y: BROWSER.y + BROWSER.bar, w: BROWSER.w, h: Math.round(BROWSER.w * WEB.height / WEB.width) };
const PHONE = { x: 1236, y: 104, w: 312, bezel: 11, r: 48 };
const PHONE_SCREEN = { x: PHONE.x + PHONE.bezel, y: PHONE.y + PHONE.bezel, w: PHONE.w - 2 * PHONE.bezel, h: 0 };

const svg = (body: string, w = CANVAS.w, h = CANVAS.h) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const FONT = `font-family="Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif"`;

/** The full scene with transparent, rounded holes where the two screens show through. */
async function frameOverlay(mode: Mode, phoneAspect: number): Promise<Buffer> {
  const t = THEME[mode];
  PHONE_SCREEN.h = Math.round(PHONE_SCREEN.w * phoneAspect);
  const phoneH = PHONE_SCREEN.h + 2 * PHONE.bezel;
  const browserH = BROWSER.bar + BROWSER_SCREEN.h;
  const screenR = PHONE.r - PHONE.bezel;
  const holes = `<rect x="${BROWSER_SCREEN.x}" y="${BROWSER_SCREEN.y}" width="${BROWSER_SCREEN.w}" height="${BROWSER_SCREEN.h}" fill="#000"/>
    <rect x="${PHONE_SCREEN.x}" y="${PHONE_SCREEN.y}" width="${PHONE_SCREEN.w}" height="${PHONE_SCREEN.h}" rx="${screenR}" fill="#000"/>`;
  const label = (x: number, y: number, text: string) =>
    `<text x="${x}" y="${y}" text-anchor="middle" ${FONT} font-size="26" font-weight="600" fill="${t.text}">${text}</text>`;
  const scene = svg(`<defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient>
      <radialGradient id="r" cx="0.72" cy="0.3" r="0.55"><stop offset="0" stop-color="${t.glow}" stop-opacity="${t.glowOpacity}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
      <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
      <clipPath id="b"><rect x="${BROWSER.x}" y="${BROWSER.y}" width="${BROWSER.w}" height="${browserH}" rx="${BROWSER.r}"/></clipPath>
      <mask id="m"><rect width="${CANVAS.w}" height="${CANVAS.h}" fill="#fff"/>${holes}</mask>
    </defs>
    <g mask="url(#m)">
      <rect width="${CANVAS.w}" height="${CANVAS.h}" fill="url(#g)"/><rect width="${CANVAS.w}" height="${CANVAS.h}" fill="url(#r)"/>
      <rect x="${BROWSER.x}" y="${BROWSER.y + 22}" width="${BROWSER.w}" height="${browserH}" rx="${BROWSER.r}" fill="#0b1e22" fill-opacity="${t.shadow}" filter="url(#s)"/>
      <rect x="${PHONE.x}" y="${PHONE.y + 22}" width="${PHONE.w}" height="${phoneH}" rx="${PHONE.r}" fill="#0b1e22" fill-opacity="${t.shadow}" filter="url(#s)"/>
      <g clip-path="url(#b)">
        <rect x="${BROWSER.x}" y="${BROWSER.y}" width="${BROWSER.w}" height="${browserH}" fill="${t.bar}"/>
        <rect x="${BROWSER.x}" y="${BROWSER.y}" width="${BROWSER.w}" height="${BROWSER.bar}" fill="${t.chrome}"/>
      </g>
      ${['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${BROWSER.x + 26 + i * 22}" cy="${BROWSER.y + BROWSER.bar / 2}" r="7" fill="${c}"/>`).join('')}
      <rect x="${BROWSER.x + BROWSER.w / 2 - 150}" y="${BROWSER.y + 10}" width="300" height="${BROWSER.bar - 20}" rx="8" fill="${t.bar}"/>
      <text x="${BROWSER.x + BROWSER.w / 2}" y="${BROWSER.y + BROWSER.bar / 2 + 6}" text-anchor="middle" ${FONT} font-size="16" fill="${t.url}">files.example.com</text>
      <rect x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${phoneH}" rx="${PHONE.r}" fill="${t.bezel}"/>
      ${label(BROWSER.x + BROWSER.w / 2, BROWSER.y + browserH + 58, 'Web app')}
      ${label(PHONE.x + PHONE.w / 2, BROWSER.y + browserH + 58, 'iPhone app')}
    </g>`);
  return sharp(scene).png().toBuffer();
}

async function videoSize(file: string): Promise<{ w: number; h: number }> {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

async function composeReadme(mode: Mode, web: Clip, ios: Clip, total: number) {
  const phone = await videoSize(ios.file);
  const overlay = path.join(WORK, `overlay-${mode}.png`);
  writeFileSync(overlay, await frameOverlay(mode, phone.h / phone.w));
  const fps = 30;
  const graph = [
    loopFilter(0, web, total, fps, `scale=${BROWSER_SCREEN.w}:${BROWSER_SCREEN.h}:flags=lanczos`, 'w'),
    loopFilter(1, ios, total, fps, `scale=${PHONE_SCREEN.w}:${PHONE_SCREEN.h}:flags=lanczos`, 'p'),
    `color=c=black:s=${CANVAS.w}x${CANVAS.h}:r=${fps}:d=${total}[bg]`,
    `[bg][w]overlay=${BROWSER_SCREEN.x}:${BROWSER_SCREEN.y}:shortest=1[a]`,
    `[a][p]overlay=${PHONE_SCREEN.x}:${PHONE_SCREEN.y}:shortest=1[b]`,
    `[b][2:v]overlay=0:0:shortest=1[c]`,
    // GIF: 960 px wide, 15 fps, one palette for the whole clip.
    `[c]fps=15,scale=960:-1:flags=lanczos,split[g1][g2];[g1]palettegen=max_colors=192:stats_mode=full[pal];[g2][pal]paletteuse=dither=sierra2_4a[gif]`,
  ].join(';');
  const gif = path.join(README_OUT, `readme-hero-${mode}.gif`);
  ffmpeg('-i', web.file, '-i', ios.file, '-loop', '1', '-t', String(total), '-i', overlay, '-filter_complex', graph, '-map', '[gif]', '-loop', '0', gif);
  console.log('wrote', path.relative(ROOT, gif), `${(readFileSync(gif).length / 1e6).toFixed(1)} MB`);
}

/** One screen alone for the website: MP4 (H.264) and WebM (VP9) loops plus a WebP poster. */
async function encodeScreen(name: string, clip: Clip, total: number, width: number) {
  const base = path.join(SITE_OUT, name);
  const graph = loopFilter(0, clip, total, 30, `scale=${width}:-2:flags=lanczos`, 'v');
  ffmpeg('-i', clip.file, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`);
  ffmpeg('-i', clip.file, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38',
    '-row-mt', '1', `${base}.webm`);
  const poster = path.join(WORK, `${name}.png`);
  ffmpeg('-i', `${base}.mp4`, '-frames:v', '1', poster);
  await sharp(poster).webp({ quality: 80 }).toFile(`${base}.webp`);
  for (const ext of ['mp4', 'webm', 'webp']) {
    console.log('wrote', path.relative(ROOT, `${base}.${ext}`), `${(readFileSync(`${base}.${ext}`).length / 1e6).toFixed(2)} MB`);
  }
}

// ---------------------------------------------------------------------------------------------

mkdirSync(SITE_OUT, { recursive: true });

async function compose(mode: Mode, web: Clip, ios: Clip) {
  const w = normalize(web, path.join(WORK, `web-${mode}.mp4`), { cutStills: false });
  const p = normalize(ios, path.join(WORK, `phone-${mode}.mp4`), { cutStills: true });
  const total = Math.max(w.end * speed(w.end), p.end * speed(p.end)) + LEAD + HOLD;
  console.log(`   ${mode}: motion web ${w.end.toFixed(2)} s (×${(1 / speed(w.end)).toFixed(2)}), iPhone ${p.end.toFixed(2)} s (×${(1 / speed(p.end)).toFixed(2)}) → loop ${total.toFixed(2)} s`);
  await composeReadme(mode, w, p, total);
  await encodeScreen(`web-${mode}`, w, total, 1280);
  await encodeScreen(`phone-${mode}`, p, total, 600);
}

if (process.env.HERO_COMPOSE_ONLY === '1') {
  const clips = JSON.parse(readFileSync(path.join(RAW, 'clips.json'), 'utf8')) as Record<Mode, { web: Clip; ios: Clip }>;
  for (const mode of MODES) await compose(mode, clips[mode].web, clips[mode].ios);
  console.log('done');
  process.exit(0);
}

const base = await startSampleStack('site-hero', PORT);
await seed(base, { extraPhotos: 24 });

const anon = await request.newContext({ baseURL: base });
const { accessToken } = await json<{ accessToken: string }>(await anon.post('/api/auth/login', { data: { login: ADMIN.username, password: ADMIN.password } }), 'login');
const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${accessToken}` } });
const { token } = await json<{ token: string }>(await api.post('/api/sync/v1/devices', { data: { name: 'Hero recording', platform: 'ios', appVersion: '0.1.7' } }), 'device');
const children = await json<{ items: { id: string; name: string }[] }>(await api.get('/api/sync/v1/items/root/children'), 'children');
const photosId = children.items.find((i) => i.name === 'Photos')!.id;
await api.dispose();
await anon.dispose();

rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
const keep = (clip: Clip, name: string): Clip => {
  const file = path.join(RAW, name + path.extname(clip.file));
  copyFileSync(clip.file, file);
  return { ...clip, file };
};
const clips = {} as Record<Mode, { web: Clip; ios: Clip }>;
const sim = iosSimulator();
const browser = await chromium.launch();
try {
  for (const mode of MODES) {
    console.log(`== ${mode}: web`);
    const web = keep(await recordWeb(browser, base, photosId, mode), `web-${mode}`);
    console.log(`== ${mode}: iPhone`);
    const ios = keep(await recordIos(sim, base, token, mode), `ios-${mode}`);
    console.log(`   web ${web.start.toFixed(2)}–${web.end.toFixed(2)} s, iPhone ${ios.start.toFixed(2)}–${ios.end.toFixed(2)} s`);
    clips[mode] = { web, ios };
    writeFileSync(path.join(RAW, 'clips.json'), JSON.stringify(clips, null, 2));
  }
} finally {
  await browser.close();
  sim.remove();
}
for (const mode of MODES) await compose(mode, clips[mode].web, clips[mode].ios);
console.log('done');
