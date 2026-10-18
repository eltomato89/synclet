# Apps

## App login

The native Synclet apps (iPhone/iPad, Android, Mac, Windows, Linux) do not ask for your password inside the app. They open the web page `/app-login` of your server in the system browser (OAuth 2.0 authorization code flow with PKCE `S256`, public clients without a secret). There you sign in the way you always do, with your password or, if you are already signed in or use SSO, with the existing session. The server then redirects back to the app with a **one-time code** (valid 60 seconds, stored as a hash only), and the app exchanges it plus its PKCE verifier for an access token and a rotating refresh token. Password login follows the rule from the SSO settings (regular users with password login disabled must use SSO).

Only registered redirect URIs are accepted, matched exactly:

| Client ID | Redirect URI |
| --- | --- |
| `ios`, `android`, `macos` | `synclet://oauth` |
| `windows`, `linux` | `http://127.0.0.1:<any port>/callback` (loopback, per RFC 8252) |

An outer proxy or SSO gate must let `/api/auth/app/*` through (see the forward-auth example). All app-login routes are rate-limited per client IP; this needs a correct client IP, see [Behind another reverse proxy](configuration.md#behind-another-reverse-proxy).

## macOS client

The Mac app (`apps/macos`, macOS 26 or later) is a menu bar app with a File Provider extension:

- **Finder:** each account appears in Finder under **Locations** as "Synclet – `<user>@<host>`". Inside it is "Meine Dateien" with your files. Files download when you open them.
- **Sign-in:** through the browser ([App login](#app-login)), so SSO works. The app keeps only a device token, which you can revoke in the admin area under "Sessions and devices".
- **Live updates:** changes made on the web or by other devices appear in Finder within seconds over a live event stream (`GET /api/sync/v1/events`, server-sent events). A reverse proxy in front of Synclet must not buffer that response, and its idle timeout must be above 25 s. Otherwise the app falls back to polling every 60 s.
- **Large files:** files over 32 MiB upload resumably (tus), new files and replaced ones alike. When the same file changed on the server meanwhile, your version is kept as a "(Konflikt …)" copy.
- **Offline folders:** choose folders, or a whole space, under Settings → Offline. They stay downloaded, including new files.
- **More:** server thumbnails for files that are not downloaded yet; a status menu with recent problems; several accounts at once.

Build, tests, signing and notarization, plus the manual Finder checklist: [apps/macos/README.md](../apps/macos/README.md). Distribution is a notarized DMG (`apps/macos/build_and_notarize.sh`).

## Android client

The Android app (`apps/android`, Android 10 or later, phone and tablet) is a native Kotlin/Compose app without Google services. Besides browsing, previewing, searching and sharing in the app, Synclet appears in the system file dialog and the Files app, and **Share → Synclet** saves files and links from any app. Sign-in goes through the browser ([App login](#app-login)), so SSO works. Uploads are resumable (tus) and continue in the background.

Install the signed APK from the [latest release](https://github.com/eltomato89/synclet/releases/latest/download/Synclet.apk) (`Synclet.apk`); a Google Play testing track is coming soon. Build, tests, the manual device checklist and the release steps: [apps/android/README.md](../apps/android/README.md).
