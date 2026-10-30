# Synclet for iOS and iPadOS

Universal SwiftUI app (iOS/iPadOS 26+) with a File Provider extension (Files app) and a
share extension. The logic shared with the macOS client lives in
[`../apple/SyncletKit`](../apple/SyncletKit).

| Target | Bundle ID |
|---|---|
| `Synclet` (app) | `tech.jensk.synclet.ios` |
| `SyncletFileProvider` | `tech.jensk.synclet.ios.FileProvider` |
| `SyncletShare` | `tech.jensk.synclet.ios.Share` |
| `SyncletTests` / `SyncletUITests` | `tech.jensk.synclet.ios.tests` / `.uitests` |

App group `group.tech.jensk.synclet` (no team prefix on iOS), keychain group
`$(AppIdentifierPrefix)tech.jensk.synclet.shared`, OAuth `client_id=ios`, redirect `synclet://oauth`.

## Project

`Synclet.xcodeproj` is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
and committed. After every change to `project.yml` (or a merge touching it):

```sh
cd apps/ios && xcodegen generate
```

Never edit the `.pbxproj` by hand.

## Build

```sh
cd apps/ios
xcodebuild build -scheme Synclet -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

## Tests

Unit tests (scheme `Synclet`) on a private simulator that is deleted afterwards:

```sh
bash scripts/ios-test.sh                                        # iPhone 18 Pro
IOS_DEVICE="iPad Pro 13-inch (M5)" bash scripts/ios-test.sh     # iPad
```

SyncletKit on the iOS simulator: `bash scripts/swiftkit-test-ios.sh`.

The UI tests have their own scheme (`SyncletUITests`). They run against a throwaway server,
together with the SyncletKit live tests:

```sh
bash scripts/ios-live-tests.sh           # Kit live tests (swift test --filter Live) + UI tests
bash scripts/ios-live-tests.sh --ui      # only the UI tests (--kit: only the Kit live tests)
bash scripts/ios-live-tests.sh --serve   # keep the stack up, print URL + a device token
```

The script starts its own compose project (`synclet-ios-live-<pid>`, free ports), creates the
administrator through the setup API, registers device tokens and removes the stack and its private
simulator on exit. `BrowserFlowUITests` (iPhone layout, German) creates a folder, checks the inline
"Name already taken", uploads a file (DEBUG hook `-SyncletTestUpload <path>` behind "Files"),
opens it in QuickLook, renames, deletes, restores it from "Trash", finds it in "Search" and
creates a share link.

## App Store screenshots

```sh
bash scripts/ios-store-screenshots.sh   # → apps/ios/build/store-screenshots/{iphone,ipad}-{en,de}/
pnpm --filter @synclet/site store-images  # → apps/ios/build/app-store/images/ (framed, with captions)
```

Six scenes (`StoreScreenshotsUITests`) with the website's sample data on a throwaway stack, on an
iPhone 17 Pro Max (6.9", 1320 × 2868) and an iPad Pro 13-inch (2752 × 2064, landscape).

## Debug sign-in without the browser

Debug builds accept a device token registered beforehand (UI tests, scripted checks):

```
-SyncletTestServer http://localhost:18140 -SyncletTestToken syd_…
```

Both arguments are required. Release builds do not contain this code path. `-SyncletTestDisplayHost files.example.com`
shows that host in account titles instead of the real one (App Store screenshots).

## App icon

`Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png` (single size, opaque) is
rendered from the macOS icon: `cd apps/ios && swift render-app-icon.swift`.

## Archive (App Store Connect / TestFlight)

```sh
cd apps/ios && ./build_archive.sh            # export to build/export
cd apps/ios && ./build_archive.sh --upload   # upload to App Store Connect (TestFlight)
```

`xcodegen generate`, `xcodebuild archive` (Release, `generic/platform=iOS`,
`-allowProvisioningUpdates`) and the export with `ExportOptions.plist` (method `app-store-connect`,
team `JC32M95WLZ`), either into `build/export` or, with `--upload`, straight to App Store Connect.
Signing uses Xcode's cloud-managed distribution certificate, so no local "Apple Distribution"
certificate is needed, only an Xcode account of the team (Xcode → Settings → Accounts). The build
number is a UTC timestamp (`YYYYMMDDHHMM`), so every run can be uploaded; the version shown to users is
`MARKETING_VERSION` in `project.yml`.

## Device checklist (manual)

The Files app, share extension, background uploads and multiple accounts can't be tested
automatically in this environment. Prerequisites: an iPhone or iPad with iOS/iPadOS 26, a server
reachable from the device (your own server, or `bash scripts/ios-live-tests.sh --serve` behind a
LAN address) with two user accounts, and the web app open in a browser on a computer.

1. **Install:** Connect the device and run the `Synclet` scheme in Xcode with the device as the
   destination (team JC32M95WLZ, automatic signing).
   → The app starts and shows "Add Account".
2. **Sign in, two accounts:** Enter the server address and sign in as account A in the browser window;
   then add account B via the account menu → "Manage Accounts…" → "Add Account".
   → Both accounts are listed under "Accounts"; "My Files" shows the files of the selected account,
   and the account switcher at the top left changes the content.
3. **Files app:** Open the Files app → "Browse" → "Locations".
   → Two Synclet locations (one per account, with the account names); each contains "My Files" with the
   content from the web.
4. **Open a file in Files:** Tap a PDF or an image in a Synclet location.
   → The file downloads (progress) and opens in the preview.
5. **Edit in another app:** Draw on an image in Files with "Markup" and save it (or open a
   Pages/Numbers document, change it, close it).
   → After a few seconds the web shows the new version (modification date, version + 1).
6. **Conflict copy:** Put the device in airplane mode, change the same file on the device (Files app);
   change the same file in the web; turn airplane mode off.
   → Both versions are kept: one is named "<name> (Conflict <device> <date>)", visible in the web and in
   the app.
7. **Foreground refresh:** With the app in the foreground on a folder, create, rename and delete a
   file there in the web.
   → The list in the app follows within a few seconds without pulling to refresh.
8. **Background:** Send the app to the background; change a file in the web; then open the Files app
   and view the folder.
   → The Files app shows the change when opened (at the latest after pulling to refresh).
9. **Share extension from Photos:** In Photos, select 3 photos → Share → "Synclet" → choose account and
   folder → "Upload".
   → The three photos arrive in the chosen folder (web and app); "Uploads" shows them as
   "Uploaded".
10. **Share extension from Safari:** Open a PDF in Safari → Share → "Synclet" → choose a folder.
    → The PDF is in the chosen folder.
11. **Upload with the device locked:** In the app, "+" → "Photos" → choose a video of about 200 MB, lock
    the device immediately, wait a few minutes.
    → After unlocking, the upload shows "Uploaded" in "Uploads" (or is still running and
    finishes); the file is complete in the web (same size, playable), with no duplicate.
12. **Storage full (507):** Fill the account's quota or the server's disk (e.g.
    `SYNCLET_MACLIVE_DATA_DIR` on a small disk image, as for the Mac), then upload a larger file.
    → "Uploads" shows "Storage Full" with "Try Again"; after freeing space and tapping
    "Try Again" the upload continues and finishes.
13. **Revoke a device:** In the web device list, revoke account A's device.
    → The app shows "Sign In Again" for account A; the Files app reports for account A's location that
    a sign-in is required. "Sign In Again" leads to the browser login, after which everything works again.
14. **Sign out:** Under "Manage Accounts…", sign out account B.
    → Account B's Synclet location disappears from the Files app; its uploads disappear from
    "Uploads". Previously opened files and thumbnails are deleted from the device (Settings →
    cache size 0, or thumbnails reload the next time they are opened).
15. **iPad:** Steps 2–7 on an iPad; additionally Split View with a second app, and rotation.
    → Sidebar with accounts and "My Files"/"Recent"/"Search"/"Trash"/"Uploads", content
    on the right; the layout stays usable in Split View and when rotating (narrow width: tab bar as
    on the iPhone). Drag and drop from the Files app into the app is out of scope (don't test it).
16. **Share extension offline, app much later:** Airplane mode on; in Photos, 3 photos → Share → "Synclet" →
    "Upload". Wait more than 10 minutes, then open the app (airplane mode still on), then turn
    airplane mode off and wait until "Uploads" shows all three as "Uploaded".
    → Each photo is in the target folder exactly once (no "IMG_… (2).heic").
17. **Cancel a share upload from the app:** Airplane mode on; in Photos, one photo → Share → "Synclet" →
    "Upload". Open the app → "Uploads" → tap "Cancel" on the photo. Airplane mode off, wait a minute.
    → The entry is gone, and the file does not appear in the target folder (web and app).
18. **Spaces:** Prerequisite: account A is a member of a team folder "Familie" (write access) and of a
    read-only space; account A also has "My Files".
    - Team folder: In the Files app and in the app, "Familie" appears next to "My Files"; a
      file from the web is visible.
    - Read-only space: Uploading ("+"), renaming, deleting and dropping from the Files app
      are rejected; "+" is hidden or disabled.
    - Moving between spaces: Move a file from "My Files" to "Familie" → afterwards it is only
      there (also in the web).
    - Removing access: In the web, remove the user from "Familie" → "Familie" disappears within
      seconds from the app and the Files app.
    - Missing mount: Unmount the external storage on the server → the space shows "Not
      available", nothing is deleted; after remounting it is usable again.
