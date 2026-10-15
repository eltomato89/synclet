# Synclet for macOS

A menu bar app plus a File Provider extension (`NSFileProviderReplicatedExtension`). Each signed-in account appears in Finder under **Locations** as "Synclet – `<user>@<host>`". Inside it, "Meine Dateien" (the personal space) holds your files, which download on demand. The shared core (Sync API client, transfers, live events, pinning, the extension base class) is the Swift package [`apps/apple/SyncletKit`](../apple/SyncletKit), which the later iOS app reuses.

- **Requirements:** macOS 26 or later; Xcode 26 or later; [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- **Identifiers:**
  - team `JC32M95WLZ`
  - app `tech.jensk.synclet.mac`
  - extension `tech.jensk.synclet.mac.fileprovider`
  - app group `JC32M95WLZ.group.tech.jensk.synclet`
  - keychain group `JC32M95WLZ.tech.jensk.synclet.shared`
  - URL scheme `synclet://oauth`
  - logger subsystem `tech.jensk.synclet`
  - version 0.1.0

## Layout

| Path | What |
| --- | --- |
| `project.yml` | XcodeGen spec. The generated `Synclet.xcodeproj` is committed; regenerate it whenever `project.yml` or the file list changes. |
| `Synclet/` | Menu bar app: login (`ASWebAuthenticationSession`), accounts, settings (accounts, offline pinning), status menu, change monitor (SSE). |
| `SyncletFileProvider/` | The extension: a thin subclass of SyncletKit's `SyncletReplicatedExtension`. |
| `Shared/` | Code compiled into both targets (auth-failure signal, enumerator wrapper). |
| `SyncletTests/` | App unit tests (hosted by `Synclet.app`). |
| `build_and_notarize.sh`, `ExportOptions.plist`, `dmg/` | Release build: Developer ID export, notarization, DMG. |
| `dmg/render-artwork.swift` | Draws the app icon set, the DMG background and the volume icon (`swift dmg/render-artwork.swift`). |

`build/` and `DerivedData/` are git-ignored.

## Build and run (development)

```bash
cd apps/macos
xcodegen generate
xcodebuild -scheme Synclet -configuration Debug -derivedDataPath DerivedData -allowProvisioningUpdates build
open DerivedData/Build/Products/Debug/Synclet.app
```

Debug builds are signed with your Apple Development certificate (automatic signing, team `JC32M95WLZ`). The extension is registered by launching the app. `pluginkit -m -i tech.jensk.synclet.mac.fileprovider` should list it.

Launch arguments, for testing:

| Argument | Effect |
| --- | --- |
| `-SyncletShowLogin` / `-SyncletShowSettings` / `-SyncletShowOffline` | Opens that window at launch. |
| `-SyncletAutoSignIn <server>` | Opens the login window and starts the browser login for `<server>`. |
| `-SyncletSignOutAll` | Logs the pending-change count per account, signs every account out (domain removed, device revoked) and quits. Use it to clean up after tests. |

To watch the logs:

```bash
log stream --level info --predicate 'subsystem == "tech.jensk.synclet"'
```

The categories are `fileprovider`, `transfer`, `pinning`, `account`, `events` and `changes`. File names are logged as private.

Where things live:
- **Account state:** `~/Library/Group Containers/JC32M95WLZ.group.tech.jensk.synclet/accounts/<key16>/`. It holds the cursor and pins per space, upload state, the problem log and the auth-failure marker.
- **Device token:** the keychain (service `tech.jensk.synclet.sync`).
- **The Finder folder:** `~/Library/CloudStorage/`.

## Tests

```bash
# SyncletKit (unit tests; live tests are skipped without env)
cd apps/apple/SyncletKit && swift test

# App
cd apps/macos && xcodegen generate && xcodebuild test -scheme Synclet -destination 'platform=macOS'

# Live tests against a throwaway server stack (Docker): builds the server image, starts
# postgres + server + worker + caddy under a unique compose project and ports, creates the
# user via the setup API, runs `swift test --filter Live`, removes only its own stack.
scripts/macos-live-tests.sh
```

The live tests are opt-in through env: `SYNCLET_LIVE_URL`, `SYNCLET_LIVE_USER`, `SYNCLET_LIVE_PASSWORD`, and `SYNCLET_LIVE_TOKEN` for the SSE reconnect test. The script sets all of them.

| Class | Covers |
| --- | --- |
| `LiveAPITests` | Sign-in via `/api/auth/app/authorize` with PKCE plus code exchange and device registration. `/account` has the personal space. Small upload, and a 40 MiB tus upload with sha256 and re-download check. Stale-etag replace → 412, then the extension's conflict path uploads "… (Konflikt <device> <date>).ext". SSE `hello` and `changes` within 3 s. A PNG thumbnail. Sign-out revokes the device (next call 401). |
| `LiveTransferTests` | Interrupted tus upload and tus replace. `SYNCLET_LIVE_INTERRUPT='docker kill …; sleep 8; docker start …'` resumes at the server offset. The size comes from `SYNCLET_LIVE_SIZE_MB` (the script uses 48). |
| `LiveThumbnailTests` | The extension's `fetchThumbnails` for PNG and PDF, cache, 304 revalidation, size buckets. With `SYNCLET_LIVE_MAX_UPLOAD_BYTES` matching a small server limit, it also tests the 413 problem entry. |
| `EventStreamLiveTests` | `hello`, then `changes` ≤ 3 s. With `SYNCLET_LIVE_RESTART_WAIT=<s>`, it also tests reconnect after a server restart that you trigger yourself. |

Only the test code signs in with a password. The app always uses the browser login.

## Signing and notarization

`./build_and_notarize.sh` does the following:
1. `xcodegen generate`, then `xcodebuild archive` (Release).
2. Exports with Developer ID (`ExportOptions.plist`: method `developer-id`, team `JC32M95WLZ`) and verifies the signature.
3. Notarizes and staples the app (`notarytool submit --keychain-profile synclet-notary --wait`, `stapler staple`).
4. Builds the DMG with `hdiutil`. The DMG has the background picture, an Applications link and the volume icon.
5. Signs, notarizes and staples the DMG.

**Output:** `build/Synclet-<version>.dmg`.

### One-time setup on the build Mac

1. **Developer ID Application certificate** of team `JC32M95WLZ` in the login keychain. Either:
   - Xcode → Settings → Accounts → (team) → Manage Certificates → "+" → Developer ID Application (needs the Account Holder or Admin role), or
   - create it at developer.apple.com and import the `.cer`.

   Check with `security find-identity -v -p codesigning | grep "Developer ID Application"`.
2. **An Xcode account signed in** (Xcode → Settings → Accounts). With `-allowProvisioningUpdates`, Xcode then creates the **Developer ID provisioning profiles** for both bundle IDs, which the app group and keychain group need.

   Alternatively, create both profiles (Distribution → Developer ID, with the App Groups capability `group.tech.jensk.synclet`) at developer.apple.com and install them.
3. **Notary credentials** in the keychain under the profile name the script uses. Use an app-specific password from appleid.apple.com:

   ```bash
   xcrun notarytool store-credentials synclet-notary --apple-id <your Apple ID> --team-id JC32M95WLZ
   # check:
   xcrun notarytool history --keychain-profile synclet-notary
   ```

The script stops with a clear message, and exit code 3, at the notarization step when the profile is missing. `SYNCLET_SKIP_NOTARIZE=1` builds `build/Synclet-<version>-unnotarized.dmg` for local tests only, because Gatekeeper rejects it on other Macs.

The DMG window layout is set through Finder (AppleScript). That needs an unlocked GUI session and the Automation permission for your terminal. Without them the script warns, and the DMG still works but has no background or icon positions.

**State on 2026-10-16 (Task 9 run):** the archive builds. The export fails because this Mac has:
- no Xcode account ("No Accounts")
- no Developer ID Application certificate (only Apple Development identities)
- no Developer ID profiles for `tech.jensk.synclet.mac` and `tech.jensk.synclet.mac.fileprovider`
- no `synclet-notary` profile

Complete the setup above, then run the script again.

## Manual end-to-end checklist (Finder)

The automated tests cover SyncletKit against a real server, but not what Finder and macOS do with the extension. None of the following was observed during development, because the Mac's screen was locked. Run these steps at an unlocked Mac.

How to use this list:
- Each step gives the **expected** result and **what to report if it differs**.
- Note the step number and what you saw, and add a screenshot and the log lines from `log stream --level info --predicate 'subsystem == "tech.jensk.synclet"'` where useful.

Some steps decide rulings that are still open. They are marked **(ruling)**.

### Preparation

1. **Start a throwaway server.** Run `scripts/macos-live-tests.sh --serve`.
   - **Expected:** after the image build, it prints "Throwaway server ready: http://localhost:18181", user `maclive`, the password and the compose project name. Keep this terminal open; Ctrl-C removes the stack.
   - **Report if different:** the last 30 lines of the output.
2. **Build and start the app** as in "Build and run". In a second terminal, start the `log stream` command from above.
   - **Expected:** a menu bar icon (two circling arrows). The window "Konto hinzufügen" opens because there is no account.
   - **Report if different:** whether the icon is missing, and any crash report from Console.app.

### Sign-in and the extension

3. **Sign in.** In "Konto hinzufügen", enter `http://localhost:18181` and click "Anmelden". The default browser opens `/app-login`; sign in as `maclive`.
   - **Expected:**
     - The browser hands back to the app.
     - The window closes, and the menu shows the section "maclive@localhost:18181".
     - In Finder's sidebar under **Orte/Locations**, "Synclet – maclive@localhost:18181" appears, and it contains exactly one folder, "Meine Dateien".
   - **Report if different:** the error text in the login window or the browser, and whether the redirect asked for permission to open "Synclet".
4. **Does the extension need enabling in System Settings? (ruling)** Look at the sidebar entry and at System Settings → General → Login Items & Extensions → File Providers (macOS 26: "Extensions" → "File Providers").
   - **Expected:** one of two outcomes.
     - (a) The domain works right away, and Synclet is listed and enabled.
     - (b) macOS asks you to allow it. In that case the app shows "Bitte erlaube Synclet in den Systemeinstellungen unter „Allgemein > Anmeldeobjekte & Erweiterungen“", and after you enable it, the domain appears.
   - **Report:** which of (a) or (b) happened. For (b), also report whether the app's hint appeared and whether the domain appeared without restarting the app.

### Finder basics

5. **Browsing.** Upload two files and a folder with a file inside through the web UI (same server and user). Open "Meine Dateien" in Finder.
   - **Expected:** all items are listed with a cloud icon (not downloaded). Opening a file downloads it, then the cloud icon disappears and the content is correct.
   - **Report if different:** missing items, wrong names (umlauts), the error dialog text.
6. **Create, rename, move, delete inside "Meine Dateien".** Do each of these in Finder:
   - Create a folder.
   - Copy a file into it.
   - Rename the file.
   - Move it to another folder of "Meine Dateien".
   - Delete it (Finder asks to delete immediately).
   - **Expected:** after each step, the web UI shows the same state within a few seconds. A deleted item is in the web trash. Nothing ends up with a "(2)" name.
   - **Report if different:** which step, what the web UI shows, and any Finder badge (exclamation mark, "waiting to sync").
7. **Writes into the virtual top level (root drop) (ruling: `.cannotSynchronize` vs `.fileWriteNoPermission`).** Try each of these on the account root "Synclet – maclive@…", next to "Meine Dateien":
   - (a) Drag a file from the Desktop onto the root (copy).
   - (b) Drag with ⌘ (move) onto the root.
   - (c) Create a new folder at the root.
   - (d) Rename "Meine Dateien".
   - (e) Move "Meine Dateien" to the Trash.
   - **Expected:**
     - All five fail cleanly: Finder refuses or shows an error. No item is created on the server (web UI unchanged).
     - For (b), the file stays on the Desktop, so nothing is lost.
     - The menu shows "Letzte Probleme" → "… Hier nicht erlaubt …".
     - After 1 minute, no item at the root shows a "waiting to sync" / cloud-with-clock badge or a spinner.
   - **Report:**
     - the exact Finder message for each of (a)–(e)
     - whether any item remained at the root with "waiting to sync" or a retrying spinner (a stuck item means the code must switch to `.fileWriteNoPermission`)
     - whether the Desktop file of (b) is still there
8. **Moving between two folders of the same space** (drag a file from folder A to folder B inside "Meine Dateien").
   - **Expected:** this works; the web UI shows the file in B with the same item (its version history is kept).
   - **Report if different:** the error text.

### Live changes (SSE)

9. **Web change appears within 3 seconds.** Keep a Finder window on "Meine Dateien" open, then create a folder in the web UI and count seconds.
   - **Expected:** it appears in Finder in ≤ 3 s. The log shows `changes` and a working-set signal.
   - **Report:** the measured time. If it is more than 3 s, also report whether it came after about 60 s (fallback polling).
10. **Server down and up.** In a terminal, run `docker compose -p <project from step 1> stop server` and watch the menu for 30 s. Then run `… start server`, and once it is up, create a folder in the web UI.
   - **Expected:**
     - While the server is down, the menu line reads "Offline" or "Verbinde…", and cached files in Finder still open.
     - After the start, it is "Verbunden · Synchronisiert vor …" again within about 60 s, and a web change appears without any action.
   - **Report:** the menu texts you saw and the reconnect time.
11. **Network change or sleep.** Put the Mac to sleep for 1 minute and wake it, or toggle Wi-Fi off and on.
   - **Expected:** the log shows "network or wake: reconnecting", and a web change made right after wake appears at once.
   - **Report if different:** the log lines from the `events` category.

### Conflicts and deleted files

12. **Conflict copy.**
   1. Open a downloaded `.txt` in TextEdit and change it, but don't save yet.
   2. Upload a different version of the same file in the web UI and wait until Finder shows it.
   3. Save in TextEdit.
   - **Expected:**
     - The original keeps the web version.
     - Next to it appears "`<name> (Konflikt <Mac name> <yyyy-MM-dd HH-mm>).txt`" with your text, on the server too.
     - The menu shows the info entry "Anderswo geändert – deine Fassung wurde als „… (Konflikt …)“ gespeichert." with no "Fehler" and no badge. Clicking the entry selects the copy in Finder.
   - **Report:** the names of both files, and their content.
13. **Local edit + server delete.**
   1. Download a file.
   2. Quit Synclet from the menu ("Beenden"), so no live events arrive.
   3. Delete the file in the web UI.
   4. Edit and save it locally in TextEdit.
   5. Start Synclet again.
   - **Expected:** your local version is uploaded again as a new file with the same name in the same folder, so the web UI shows it again with your content. Finder shows one file with your content and no error.
   - **Report:**
     - whether the local file vanished
     - whether the content was lost
     - whether there are two files, or none
     - any Finder error

### Large files (tus)

14. **Large upload with an interruption.**
   1. Create a 500 MB file with `mkfile -n 500m ~/Desktop/big.bin`, or better with real content: `head -c 500000000 /dev/urandom > ~/Desktop/big.bin`.
   2. Copy it into "Meine Dateien".
   3. When Finder's progress is at about 40 %, run `docker compose -p <project> restart server`.
   - **Expected:**
     - The upload continues after the restart.
     - The log (`transfer`) shows "resuming upload at N/500000000" with N > 0.
     - In the end there is exactly one `big.bin` on the server (no "(2)"), of the right size.
     - `shasum -a 256 ~/Desktop/big.bin` matches the sha256 in `curl -s -H "Authorization: Bearer <token>" http://localhost:18181/api/sync/v1/items/<id>`, or simply compare a re-download.
   - **Report:** the "resuming upload" line, or "starting over" / "discarding the stored upload" lines. Also report the final file count and size.
15. **tus resume key across `createItem` retries.**
   1. Start another 500 MB copy into "Meine Dateien".
   2. At about 40 %, kill only the extension process: `kill -9 $(pgrep -x SyncletFileProvider)`. This targets this exact process name only.
   - **Expected:** macOS relaunches the extension and retries `createItem`. The log shows "resuming upload at N/…" with N > 0. This means the system kept the same template identifier and content version, so the stored upload was found. One file ends up on the server.
   - **Report:** whether the retry resumed (N > 0) or started at 0. If it started at 0, report the "local file or target changed" or "starting over" lines. A restart is correct but costly, and it means the resume key (item identifier + content version) is not stable across retries.
16. **Large replace.**
   1. In Terminal, overwrite the downloaded `big.bin` in the CloudStorage folder with other content of the same size: `head -c 500000000 /dev/urandom > <path>/big.bin`.
   2. Interrupt as in step 14.
   - **Expected:** it resumes, and the server keeps the same item at version + 1 (the web version history shows the previous content).
   - **Report:** the log lines, and the version count in the web UI.

### Thumbnails

17. **Server thumbnails for files that are not downloaded.**
   1. Upload a JPEG/PNG, a PDF and a short video in the web UI.
   2. In Finder (icon view, large icons), look at them without opening them.
   - **Expected:**
     - Thumbnails appear while the cloud icon is still shown.
     - A `.txt` shows the generic icon. Folders and "Meine Dateien" show folder icons.
     - A freshly uploaded image may show the generic icon first and its thumbnail shortly after (scroll, or reopen the window).
   - **Report:** which types show no thumbnail after about 1 minute.
18. **Thumbnail cache.**
   1. Check that `~/Library/Containers/tech.jensk.synclet.mac.fileprovider/Data/Library/Caches/thumbnails/` fills with `<id>-<256|1024>.webp`.
   2. Replace the image in the web UI.
   - **Expected:** Finder shows the new thumbnail after it re-asks.
   - **Report if different:** the cache folder listing.

### Offline pinning

Open Settings → Offline, or start the app with `-SyncletShowOffline`.

19. **Pinning probe: a folder 3 levels deep, then a new remote file (records whether macOS inherits the content policy).**
   1. In the web UI, create `Probe/L1/L2/L3` with one file at each level.
   2. Pin `Probe`.
   3. Wait until the files are downloaded.
   4. Add a **new** file in the web UI inside `Probe/L1/L2/L3`.
   - **Expected:**
     - All files under `Probe` lose their cloud icon (downloaded), including the deep ones.
     - The new file is downloaded within a few seconds, without being opened. `fileproviderctl evaluate <path>` shows it materialized.
   - **Report:**
     - the time until the new file was local
     - whether the log shows "requested N pinned downloads" (the app's fallback had to act) or not (macOS acted on the policy itself)
20. **Pin a normal folder.** Pin "Fotos" (with some images).
   - **Expected:** every file inside is downloaded. Settings shows "Offline-Inhalte ≈ …", and the menu's account section shows "Offline-Inhalte ≈ …".
   - **Report if different:** what the footer and the menu show.
21. **Rename a pinned folder in the web UI.**
   - **Expected:** the toggle stays on, and new files in it still download.
   - **Report if different:** the toggle state.
22. **Unpin.** Mark one file in "Fotos" with Finder's "Keep Downloaded" first, then unpin "Fotos". Add a new file in the web UI.
   - **Expected:**
     - Nothing already downloaded is evicted.
     - The new file is **not** downloaded (cloud icon).
     - The "Keep Downloaded" file stays local.
   - **Report if different:** which files changed state.
23. **Delete a pinned folder in the web UI.**
   - **Expected:** its toggle disappears, and the pin is gone from `accounts/<key16>/spaces/personal/pins.json`.
   - **Report if different:** the file content.
24. **Whole space.** Turn on "Ganzer Bereich offline".
   - **Expected:** everything is downloaded, and the folder toggles show on and disabled. Moving a folder into a pinned folder in the web UI downloads its files.
   - **Report if different:** what stays in the cloud.

### Menu states and problems

25. **Menu states.** While doing the steps above and below, note which status lines appeared for the account:
   - "Verbunden · Synchronisiert vor …"
   - "Verbinde…"
   - "Offline"
   - "Anmeldung erforderlich", plus the "Erneut anmelden…" item
   - "Fehler" (with a problem from the last hour)
   - "Status unbekannt"

   Also note whether the menu bar icon gets the exclamation badge.
   - **Expected:** each state appears in its situation (steps 10, 26 and 28). The badge shows only for "Anmeldung erforderlich" or for a problem from the last hour, not for conflict info entries. "Im Finder öffnen" and "Web öffnen" work.
   - **Report:** any state text that was wrong for the situation, or a badge that did not go away within 1 hour.
26. **Upload too large (413) and the problem list.**
   1. Start a second server with a small limit: `SYNCLET_MACLIVE_PORT=18182 SYNCLET_MACLIVE_TLS_PORT=18545 SYNCLET_MACLIVE_MAX_UPLOAD_BYTES=1000000 scripts/macos-live-tests.sh --serve`.
   2. Sign in to it ("Konto hinzufügen…", `http://localhost:18182`, user `maclive`). This is also the **two-accounts** check of step 27.
   3. Copy a 5 MB file into its "Meine Dateien".
   - **Expected:**
     - "Letzte Probleme" shows "<file> – Zu groß für den Server – nicht hochgeladen."
     - The account line reads "Fehler", and the badge is shown. Clicking the entry selects the file.
     - Copying again gives no second entry.
     - "Liste leeren" empties the section.
   - **Report if different:** the entries shown.
27. **Two accounts.** The accounts from steps 3 and 26 have the same user name on two servers.
   - **Expected:**
     - Two sidebar entries ("Synclet – maclive@localhost:18181" and "…:18182") and two menu sections.
     - Changes in one never appear in the other.
     - Pinning a folder named like one in the other account (create "Fotos" on both) leaves the other account's toggle off.
     - Signing in again to an existing account (same server and user) replaces it, and no third domain appears.
   - **Report if different:** the sidebar entries, and `fileproviderctl dump | grep -i synclet`.

### Device revoke, re-login, sign-out

28. **Re-login after a device revoke.**
   1. Pin a folder and wait until it is downloaded.
   2. In the web UI (Admin → Benutzer → maclive → "Sitzungen und Geräte"), revoke the Mac's device.
   3. Edit a file in Finder.
   - **Expected:**
     - The menu shows "Anmeldung erforderlich" with "Erneut anmelden…" and the badge.
     - The `events` log shows `bye unauthorized` and then no reconnect loop.
     - The edit stays pending, with no data loss.
   4. Then click "Erneut anmelden…" and sign in.
   - **Expected:**
     - The same domain is reused (no second sidebar entry).
     - The pending edit uploads without restarting anything.
     - The pinned files stay downloaded and are not re-downloaded (no download traffic in the `transfer` log).
     - The badge goes away.
     - The web device list shows one active device for this Mac (the old one revoked).
   - **Report:**
     - whether a second domain appeared
     - whether the edit arrived
     - whether pinned content was downloaded again
     - the menu texts
29. **Sign out with pending changes.**
   1. Stop the server of step 1 (`docker compose -p <project> stop server`).
   2. Create a file in its "Meine Dateien".
   3. Choose Settings → Konten → "Abmelden…".
   - **Expected:**
     - The confirmation warns: "1 lokale Änderungen … gehen verloren", or the generic "Nicht hochgeladene Änderungen gehen verloren."
     - After you confirm:
       - The domain disappears from the sidebar, and the menu section and its problem entries are gone.
       - `~/Library/Group Containers/JC32M95WLZ.group.tech.jensk.synclet/accounts/` no longer has the account's folder, and the keychain item is gone.
       - After you start the server again, the web device list no longer shows the device (revoke is best effort while the server is down: then it stays listed; report which).
   - **Report:** the confirmation text, and anything left in the sidebar, in `~/Library/CloudStorage` or in the app group.
30. **Clean up.**
   1. Run `DerivedData/Build/Products/Debug/Synclet.app/Contents/MacOS/Synclet -SyncletSignOutAll`.
   2. Press Ctrl-C in both server terminals.
   - **Expected:** `fileproviderctl dump | grep -i "synclet –"` shows no domain, and `docker ps` shows no `synclet-maclive-*` containers.
   - **Report if different:** what is left over.

## Known limitations

- **Only the personal space.** The server's account response lists spaces, but Phase 2 servers return only `personal` ("Meine Dateien"). Shared spaces are a later phase.
- **No push.** When the menu bar app is not running, server changes reach Finder only when macOS asks the extension again, for example on the next Finder access. While the app runs, changes arrive through `GET /api/sync/v1/events` (SSE). It falls back to polling every 60 s when the stream is down.
- **Proxies.** SSE needs a reverse proxy without buffering and with an idle timeout above 25 s. Shorter timeouts break the stream, and polling then takes over. See SYNC_API.md §5a.
- **The virtual top level is read-only.** Files go into "Meine Dateien". Nothing can be created, renamed or deleted at the account root or on the space folder.
- **Files above 32 MiB** go through tus, which is resumable. Replacing a large file needs a server with tus replace (Synclet ≥ Phase 2).
- **Conflicts** are not merged. The local version becomes a "(Konflikt …)" copy next to the server version.
- **Pinning** downloads only into macOS's File Provider storage. Free space is managed by macOS, and unpinned files can be evicted.
- **Distribution.** Only a notarized Developer ID DMG, with no App Store and no auto-update. macOS 26 or later.
- **Not yet observed in Finder** (see the checklist):
  - root-drop behaviour
  - extension enabling
  - resume across `createItem` retries
  - whether macOS inherits pin policies

  The follow-ups document lists them: [docs/superpowers/followups/2026-10-15-phase-2-followups.md](../../docs/superpowers/followups/2026-10-15-phase-2-followups.md).
