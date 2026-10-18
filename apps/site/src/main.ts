import '@fontsource-variable/inter';
import './styles.css';
import { ANDROID_APK_URL, MAC_DMG_URL, PLAY_URL, TESTFLIGHT_URL } from './config';
import phoneDarkMp4 from './assets/hero/phone-dark.mp4';
import phoneDarkWebm from './assets/hero/phone-dark.webm';
import phoneDarkPoster from './assets/hero/phone-dark.webp';
import phoneLightMp4 from './assets/hero/phone-light.mp4';
import phoneLightWebm from './assets/hero/phone-light.webm';
import phoneLightPoster from './assets/hero/phone-light.webp';
import webDarkMp4 from './assets/hero/web-dark.mp4';
import webDarkWebm from './assets/hero/web-dark.webm';
import webDarkPoster from './assets/hero/web-dark.webp';
import webLightMp4 from './assets/hero/web-light.mp4';
import webLightWebm from './assets/hero/web-light.webm';
import webLightPoster from './assets/hero/web-light.webp';

// Download links come from config.ts so the HTML never has to change for a new link.
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-link="mac-dmg"]')) a.href = MAC_DMG_URL;
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-link="android-apk"]')) a.href = ANDROID_APK_URL;

const play = document.querySelector<HTMLElement>('[data-play]');
if (play && PLAY_URL) {
  const link = document.createElement('a');
  link.href = PLAY_URL;
  link.className = 'btn btn-secondary w-full';
  link.textContent = 'Get it on Google Play';
  play.replaceChildren(link);
}
// Otherwise the static "Google Play testing coming soon" badge stays.

const ios = document.querySelector<HTMLElement>('[data-ios-download]');
if (ios) {
  if (TESTFLIGHT_URL) {
    const link = document.createElement('a');
    link.href = TESTFLIGHT_URL;
    link.className = 'btn btn-primary';
    link.textContent = 'Join the TestFlight beta';
    ios.replaceChildren(link);
  }
  // Otherwise the static "TestFlight beta coming soon" badge stays.
}

// Hero: the web app and the iPhone app as short muted loops (scripts/hero-motion.ts), in the
// visitor's color scheme; with reduced motion only the still frame (poster) shows.
const HERO = {
  web: { light: { mp4: webLightMp4, webm: webLightWebm, poster: webLightPoster }, dark: { mp4: webDarkMp4, webm: webDarkWebm, poster: webDarkPoster } },
  phone: { light: { mp4: phoneLightMp4, webm: phoneLightWebm, poster: phoneLightPoster }, dark: { mp4: phoneDarkMp4, webm: phoneDarkWebm, poster: phoneDarkPoster } },
} as const;
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function heroVideos() {
  for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-hero]')) {
    const src = HERO[video.dataset.hero as keyof typeof HERO][darkScheme.matches ? 'dark' : 'light'];
    video.poster = src.poster;
    if (reducedMotion.matches) {
      video.pause();
      video.replaceChildren();
      video.load();
      continue;
    }
    video.replaceChildren(...([[src.webm, 'video/webm'], [src.mp4, 'video/mp4']] as const).map(([url, type]) => {
      const source = document.createElement('source');
      source.src = url;
      source.type = type;
      return source;
    }));
    video.load();
    void video.play().catch(() => { /* autoplay refused: the poster stays */ });
  }
}
heroVideos();
darkScheme.addEventListener('change', heroVideos);
reducedMotion.addEventListener('change', heroVideos);

const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

// Copy buttons on the install snippets.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.hidden = !navigator.clipboard;
  button.addEventListener('click', async () => {
    const code = button.closest('figure')?.querySelector('code')?.textContent ?? '';
    const text = code.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
}
