// Derives the site's icons from the macOS app icon (run: pnpm --filter @synclet/site assets).
// Output: src/assets/icon-{128,256}.webp for the page, public/favicon-32.png and
// public/apple-touch-icon.png for the browser.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const source = path.resolve(site, '../macos/Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png');

// The macOS icon has a transparent margin of ~10 % around the squircle; trim it for small sizes.
const trimmed = await sharp(source).extract({ left: 100, top: 100, width: 824, height: 824 }).png().toBuffer();

for (const size of [128, 256]) {
  await sharp(source).resize(size, size).webp({ quality: 90 }).toFile(path.join(site, `src/assets/icon-${size}.webp`));
}
await sharp(trimmed).resize(32, 32).png({ compressionLevel: 9 }).toFile(path.join(site, 'public/favicon-32.png'));
await sharp(trimmed).resize(180, 180).flatten({ background: '#1a9aa5' }).png({ compressionLevel: 9 }).toFile(path.join(site, 'public/apple-touch-icon.png'));
console.log('icons written');
