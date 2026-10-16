import '@fontsource-variable/inter';
import './styles.css';
import { MAC_DMG_URL, TESTFLIGHT_URL } from './config';

// Download links come from config.ts so the HTML never has to change for a new link.
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-link="mac-dmg"]')) a.href = MAC_DMG_URL;

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
