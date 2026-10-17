# Synclet for Android

## Overview

A native Kotlin/Jetpack Compose app for phones and tablets (Android 10+, `minSdk 29`). It browses, previews, searches and shares your Synclet files, and plugs into the system: **Synclet** appears in the system file dialog and in the Files app (a `DocumentsProvider`), and **Share → Synclet** saves files, images and links from any app. Uploads are resumable (tus) and continue in the background. The app uses no Google Play Services.

| Item | Value |
|---|---|
| applicationId | `tech.jensk.synclet` |
| DocumentsProvider authority | `tech.jensk.synclet.documents` |
| OAuth `client_id` | `android` |
| OAuth redirect | `synclet://oauth` |

Sign-in happens in the browser (Custom Tab) on your own server, so SSO works; the app keeps only a revocable device token ([App login](../../README.md#app-login)).

## Project layout

Two Gradle modules:

- `:core` (Android library, no UI): `core/account` (accounts, token vault), `core/api` (sync API client, tus), `core/auth` (browser login), `core/cache` (listing and file cache), `core/events` (live event stream), `core/layout` (spaces and document IDs), `core/upload` (upload queue and worker logic).
- `:app` (application): `ui/*` (Compose screens: accounts, browser, preview, recent, search, trash, uploads, settings, share links, more), `login` (browser sign-in), `provider` (DocumentsProvider), `share` (share target), `sync` (background work), plus `AppGraph`, the hand-wired dependency container that `SyncletApp` creates once.

## Build

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd apps/android
./gradlew :app:assembleDebug
./gradlew :app:installDebug      # to a connected device or emulator
```

Gradle finds the SDK through `ANDROID_HOME` or a `local.properties` with `sdk.dir=/path/to/sdk` in `apps/android` (git-ignored, never commit it).

## Tests

```bash
cd apps/android
./gradlew :core:testDebugUnitTest :app:testDebugUnitTest
```

`scripts/android-live-tests.sh [--core|--app|--serve]` runs the live tests against a throwaway Synclet stack in Docker (server, worker, PostgreSQL) and, for `--app`, an emulator (AVD `SyncletPixel`) that reaches the stack at `10.0.2.2`. `--core` runs the JVM live tests of `:core`, `--app` the instrumented tests, `--serve` leaves the stack running and prints the sign-in command. The script removes the containers, volumes and temporary data it created when it finishes; with `--serve` the stack and the emulator keep running until you stop them (the script prints how). See the header of the script for the exact options.

## Debug sign-in

Debug builds contain `DebugLoginActivity`, which signs in with an existing device token without the browser. It does not exist in release builds.

```bash
adb shell am start -n tech.jensk.synclet/.login.DebugLoginActivity \
  --es server http://10.0.2.2:<port> --es token syd_<device-token>
```

`--serve` prints this command with the right values.

## Device checklist (manual)

Run on a phone and a tablet before a release. Each step lists the expected result.

1. **Install:** the APK from the GitHub release, or `./gradlew :app:installDebug`. Expected: the app starts and shows the welcome screen.
2. **Sign in through the browser:** enter the server address, sign in with password and, if configured, SSO. Repeat once with "Don't keep activities" (developer options) enabled so the system kills the app during sign-in. Expected: sign-in completes either way and the file list opens.
3. **Second account:** add another account and switch between them. Expected: each account shows its own files.
4. **Files app:** open the Files app. Expected: "Synclet" appears per account with "My Files" ("Meine Dateien" in German) and the spaces; opening a folder shows a short loading state, then the content.
5. **Edit in another app:** open a file from a third-party app through the file dialog (word processor or office app), edit and save it, twice. Expected: the change appears on the web and no conflict copy is created.
6. **Conflict:** change the same file on the web and then save it on the device. Expected: a conflict copy "... (Conflict <device> <date>).ext" ("Konflikt" in German) and a notification.
7. **Share to Synclet:** share 3 photos from the gallery and a link as text from the browser, choosing "Save to Synclet" in the share sheet. Expected: a target folder picker (last used folder preselected); the files arrive.
8. **Large upload:** upload a video of 200 MB or more and lock the device. Expected: the upload continues with a progress notification. Enable airplane mode during an upload. Expected: it resumes afterwards without a duplicate.
9. **Storage full:** upload into a space without room (quota or full disk). Expected: "Storage full" with "Try Again".
10. **Revoked device:** revoke the device in the web admin area. Expected: the app and the Files app show "Sign In Again"; signing in again restores everything and waiting uploads continue.
11. **Sign out:** sign out. Expected: the root disappears from the Files app and the account's uploads and caches are deleted.
12. **Live updates:** change a file on the web with the app in the foreground. Expected: the view updates within seconds. With the app in the background, the Files app shows the change when opened.
13. **Tablet (600 dp or wider):** Expected: navigation rail, list on the left, preview on the right.
14. **Themes and languages:** switch light/dark and German/English. Expected: all screens follow.
15. **Preview:** photo (zoom, swipe), video, PDF, text, "Open With…", "Save to Downloads", "Share Link". Expected: each works and the shared link is an absolute URL.

## Release

1. Create the upload keystore once with `keytool` (see `keystore.properties.example` for the alias and file name), copy the example to `keystore.properties` and fill it in. Never commit `keystore.properties` or the keystore.
2. Build: `./build_release.sh <version> [--github <tag>] [--play]`.
   - Writes a signed `Synclet.apk` and `Synclet.aab`; `--github <tag>` attaches the APK to that existing GitHub release (the download links on the website and in the README point at `releases/latest/download/Synclet.apk`); `--play` uploads the AAB to the internal test track.
   - **Every GitHub release must carry `Synclet.apk`**: `releases/latest` always points at the newest release, so a release without the APK makes the README and website download links return 404. The workflow `.github/workflows/android.yml` does this automatically: when a release is published it builds the signed APK from the release tag and attaches `Synclet.apk`. Manually: `./build_release.sh <version> --github <tag>`, or run the workflow with a tag (Actions → Android → Run workflow).
   - The workflow signs with three repository secrets: `SYNCLET_ANDROID_KEYSTORE_B64` (`base64 -i synclet-release.jks`), `SYNCLET_KEYSTORE_PASSWORD` and `SYNCLET_KEY_PASSWORD` (alias `synclet`). Set them once with `gh secret set`.
   - `versionCode` is the UTC time as `yyDDDHHmm` (year, day of year, hour, minute), for example `262891230`. It grows monotonically and stays below Play's limit of 2,100,000,000.
3. Play App Signing: Google manages the app signing key; we sign with the upload key. The same APK goes to GitHub.
4. The **first AAB must be uploaded by hand** in the Play Console (create the app there first). Later releases can use `--play`.
5. For `--play`, create a service account with the permission "Release to testing tracks", keep its JSON outside the repository and point `SYNCLET_PLAY_CREDENTIALS` (or `playCredentials` in `keystore.properties`) at it.

## Google Play data safety (copy into the Play Console)

Description:

> Synclet does not collect or share any data with the developer or third parties. The app has no analytics, no advertising and no crash reporting. It talks only to the Synclet server the user enters. Files, file names and account details are transferred to that server over HTTPS (encrypted in transit) and stored only there and in the app's private storage on the device. Signing in happens in the browser on the user's own server; the app stores a device token in the Android Keystore-protected storage. Users can delete all app data by signing out or uninstalling; data on the server is managed by the server's administrator.

Form answers:

- Data collected: none
- Data shared: none
- Encryption in transit: yes
- Deletion request: users delete their data on their own server

Permission justifications:

- `FOREGROUND_SERVICE_DATA_SYNC`: uploads the user started continue while the screen is off.
- `POST_NOTIFICATIONS`: upload progress and conflict copies.

## Known limitations

- No offline browsing or pinning of folders.
- No camera auto-upload.
- No push notifications: the Files app views are current when you open them.
- Third-party apps decide when they save: an edit is uploaded when the other app closes the file.
- Android 15 limits `dataSync` foreground services in time; the upload resumes (tus) when the system stops it.
- Self-signed certificates are not supported in release builds (system CAs only).
