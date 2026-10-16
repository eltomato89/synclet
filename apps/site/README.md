# Synclet website

The public single-page site, published with GitHub Pages at <https://eltomato89.github.io/synclet/>.
Plain HTML (`index.html`) + Tailwind CSS 4 + a few lines of TypeScript (`src/main.ts`), built with Vite.
Colors and font follow the web app (`apps/web/src/styles/globals.css`); light/dark follows the system.

```sh
pnpm site:dev        # or: pnpm --filter @synclet/site dev   → http://localhost:5173/synclet/
pnpm site:build      # → apps/site/dist (base path /synclet/)
SITE_BASE=/ pnpm site:build   # other base path (custom domain, preview at the root)
```

## Configuration

`src/config.ts`:

- `TESTFLIGHT_URL`: public TestFlight link of the iPhone/iPad beta. Empty shows a
  "TestFlight beta coming soon" badge instead of a button.
- `MAC_DMG_URL`: `https://github.com/eltomato89/synclet/releases/latest/download/Synclet.dmg`
  (needs a release asset named exactly `Synclet.dmg`, see below).

## Deployment

`.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `apps/site/**`
(or the workflow), and on manual dispatch. One-time setup in the repository: Settings → Pages →
Source: **GitHub Actions**.

## Publishing a Mac release (stable download link)

The download button points at the release asset `Synclet.dmg` of the latest release.
`apps/macos/build_and_notarize.sh` writes `build/Synclet-<version>.dmg`, and `gh release create`
uploads files under their own name (a `#label` only sets the display label, not the file name),
so copy it first:

```sh
cd apps/macos
./build_and_notarize.sh
cp build/Synclet-<version>.dmg build/Synclet.dmg
gh release create v<version> build/Synclet.dmg --title "Synclet <version>" --notes "…"
```

Until the first release exists, the link answers 404.

## Screenshots

The images in `src/assets/screenshots/` are real screenshots of the web app with generated sample
data (procedural landscape images, small PDFs and text files; never real data). Regenerate them with:

```sh
pnpm exec playwright install chromium   # once
pnpm --filter @synclet/site screenshots
```

`scripts/screenshots.ts` builds and starts its own throwaway stack (compose project
`synclet-site-shots-<pid>`, image tags `synclet-site/*:site-<pid>`, temp folders, port 18181 or
`SITE_SHOTS_PORT`), creates the administrator `alex` through the setup API, uploads the sample files,
creates the team folder "Family" and the external storage "Archive", captures files grid, QuickLook
and admin spaces (1440×900) plus the phone layout (390×844) in light and dark, writes WebP, and
removes only its own stack, images and folders. `SITE_SHOTS_KEEP=1` keeps the stack running.

Icons (`src/assets/icon-*.webp`, `public/favicon-32.png`, `public/apple-touch-icon.png`) come from the
macOS app icon: `pnpm --filter @synclet/site assets`.

## Checks

```sh
pnpm --filter @synclet/site build
pnpm --filter @synclet/site preview --port 4321 &
node apps/site/scripts/verify.ts http://localhost:4321/synclet/ /tmp
```

`scripts/verify.ts` loads the page in Chromium (light/dark, 1440 px and 390 px) and fails on console
errors, failed requests, broken images, dangling `#anchors`, horizontal scrolling, images without
`alt` or more than 2 MiB transferred; it writes full-page screenshots to the given folder.
