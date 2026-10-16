# Synclet Phase 3 – iOS Client (iPhone + iPad)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A universal iOS/iPadOS 26 app that mounts Synclet accounts in the Files app (File Provider) and brings its own browser (list/grid, thumbnails, QuickLook, manage, search, recent, trash, share links) plus photo/file uploads from the app and from a Share extension, running as background uploads.

**Architecture:**
- **Server:** no new endpoints. `/api/shares` becomes part of the Sync API v1 contract; conformance tests prove shares, trash, search and recent work with a device token (`syd_`).
- **SyncletKit** (`apps/apple/SyncletKit`, already builds for iOS):
  - gains `AppAPI` (search, recent, trash, shares)
  - gains a persistent `UploadQueue` in the app group, plus a `BackgroundUploader` that drives it through a background `URLSession` (single POST ≤ 32 MiB, tus in 16 MiB chunk files above)
  - takes over `AuthFailureSignal` and `SignallingEnumerator` from `apps/macos/Shared`, so the macOS and iOS extensions share them
- **`apps/ios`:** an XcodeGen project with three targets:
  - `Synclet` (SwiftUI app)
  - `SyncletFileProvider` (a subclass of `SyncletReplicatedExtension`)
  - `SyncletShare` (Share extension)
- **Browser architecture "A":** the in-app browser talks to the server directly through `SyncAPIClient`/`AppAPI`. After each mutation it calls `signalEnumerator(.workingSet)` so the Files app catches up.

**Tech Stack (additions):**
- SwiftUI on iOS:
  - `NavigationStack`, `NavigationSplitView`
  - `PhotosPicker` (PhotosUI), `fileImporter`
  - `QLPreviewController` (QuickLook)
  - `ASWebAuthenticationSession`
- `BGTaskScheduler` (`BGAppRefreshTask`) and background `URLSession`
- Share extension: `NSExtensionPointIdentifier` `com.apple.share-services`, SwiftUI hosted in a `UIViewController`
- XCTest and XCUITest on the iOS Simulator (Xcode 27.1, runtime iOS 27.0, devices "iPhone 18 Pro" and "iPad Pro 13-inch (M5)")

**Spec:** `docs/superpowers/specs/2026-10-16-phase-3-ios-client-design.md` (binding). Phase 2 spec `docs/superpowers/specs/2026-10-15-phase-2-macos-client-design.md` for everything inherited (spaces, extension, auth marker).

**References (copy, then adapt; never import across apps):**
- `apps/macos/Synclet/Core/{LoginModel,BrowserLogin,AccountsModel,ChangeMonitor}.swift` → the iOS account/login/foreground-monitor models
- `apps/macos/SyncletFileProvider/FileProviderExtension.swift` → the iOS extension
- `apps/macos/project.yml` → `apps/ios/project.yml`
- `scripts/macos-live-tests.sh` → `scripts/ios-live-tests.sh`
- Buro iOS app `/Volumes/Daten/Privat/SaaS/BuroApp/buro/apps/ios-app` (`project.yml`, `BuroFileProvider/`) for iOS target settings
- Contracts: `docs/sync/SYNC_API.md`, `packages/sync-contract/openapi.yaml`

**User decisions (2026-10-16):**
- iOS before Windows.
- App scope: browser, preview and upload, plus manage, search, trash and share links.
- No APNs: SSE in the foreground, background refresh otherwise.
- iPhone and iPad.
- **No pinning on iOS.**
- Uploads via picker and Share extension, as background uploads.
- Architecture A.

## Global Constraints

- **Platform:** minimum iOS/iPadOS **26.0**. Swift 6 language mode (`SWIFT_VERSION: "6.0"`). Universal app (`TARGETED_DEVICE_FAMILY: "1,2"`).
- **Team and bundle IDs:** team `JC32M95WLZ`, automatic signing. Bundle IDs:
  - `tech.jensk.synclet.ios`
  - `tech.jensk.synclet.ios.FileProvider`
  - `tech.jensk.synclet.ios.Share`
  - `tech.jensk.synclet.ios.tests`
  - `tech.jensk.synclet.ios.uitests`
- **Shared identifiers on iOS:**
  - app group `group.tech.jensk.synclet` (iOS app groups have **no** team prefix)
  - keychain access group `$(AppIdentifierPrefix)tech.jensk.synclet.shared`
  - keychain service `tech.jensk.synclet.sync`
  - URL scheme `synclet`, redirect `synclet://oauth`, OAuth `client_id` `ios`
  - `SharedConfiguration` is read from the Info.plist keys `SyncletAppGroup` and `SyncletKeychainAccessGroup`, exactly as on macOS
- **Upload transfer:** threshold **32 MiB** (≤ → single `POST /sync/v1/items/upload?onConflict=rename`; > → tus with `onConflict=rename`). tus chunk **16 MiB**. Network retries: exponential backoff 2 s · 2^n, capped at 5 min, **max 10 attempts**, then `failed`.
- **Upload queue file:** `<appGroup>/uploads/queue.json`, JSON with `"v":1`. Copies live in `<appGroup>/uploads/files/<entryId>`. `done` entries are pruned after **24 h**.
- **Caches:** thumbnails ≤ **200 MB**, opened files ≤ **1 GB**, both LRU, under `Library/Caches`.
- **Refresh:**
  - Foreground SSE per account (`EventStream`). Polling every **60 s** while the stream is down and the app is active.
  - `BGAppRefreshTask` id `tech.jensk.synclet.ios.refresh`, earliest begin **30 min**.
- **Copy:** de + en String Catalogs (`Localizable.xcstrings`). The UI language follows the system. German product terms: „Meine Dateien“, „Zuletzt“, „Suche“, „Papierkorb“, „Uploads“, „Link teilen“, „Neu anmelden“, „Offline“.
- **Machine safety:** never run machine-wide destructive cleanup:
  - no `pkill`/`killall` by pattern; kill only exact PIDs you started
  - no `docker volume/system/image prune`, no `docker rm -f` of containers you didn't create, no `down -v` on compose projects you didn't start
  - no `xcrun simctl erase all` / `delete all`
  - simulators: create your own with `xcrun simctl create synclet-<task> "iPhone 18 Pro"`, and delete only that one by UDID when done
- **Git:** work only in your worktree/branch; never push; never touch `main`.
- **Server:** Phase 1 constraints hold (English code, de+en strings, Sync error format `{error:{code,message,item?}}`).
- **Generated project:** `apps/ios/Synclet.xcodeproj` is generated by `xcodegen generate` and committed. After any `project.yml` change or merge, regenerate. Never hand-edit the `.pbxproj`.

## Review Focus

- **Files that vanish:** a Share-extension source whose security-scoped URL is gone once the extension ends. The file must already be copied into `uploads/files/<id>` when `enqueue` returns, so the upload still succeeds with the source deleted. Pinned in Task 4 (`testEnqueueCopiesSourceSoDeletingSourceIsHarmless`).
- **Concurrent writers:** the app and the Share extension both append to `queue.json`. A second process appending at the same time must never lose an entry. Pinned in Task 4 (`testConcurrentEnqueueFromTwoStoresKeepsAll`, two `UploadQueue` instances on one directory hammered from 2 tasks).
- **App killed mid-tus:** after relaunch the uploader must `HEAD` the stored tus URL and continue at `Upload-Offset` without duplicate content. If the tus URL is expired (404/410), it restarts from 0 with a fresh POST. Pinned in Task 5 (`testResumeUsesHeadOffset`, `testExpiredTusURLRestarts`).
- **Server-side relative share URL:** `url = "/s/<token>"` when `SYNCLET_PUBLIC_URL` is unset. The app must share an absolute URL. Pinned in Task 2 (`testRelativeShareURLResolvesAgainstServer`).
- **A stale listing acted on:** rename, move or delete of an item someone changed meanwhile (`412`) must not be retried blindly. The view reloads and shows „Wurde inzwischen geändert“. Pinned in Task 7 (`testRenameConflictReloadsAndReports`).

---

## Execution waves (controller)

- Wave 1, in parallel:
  - **T1** Kit platform (shared helpers into Kit, iOS test lane)
  - **T2** AppAPI
  - **T3** Server contract
  - **T4** UploadQueue
- Wave 2, in parallel:
  - **T5** BackgroundUploader (needs T4)
  - **T6** iOS project and accounts (needs T1)
- Wave 3, in parallel:
  - **T7** Browser and manage (needs T6)
  - **T8** Search, recent, trash and share links (needs T2, T6)
  - **T9** Uploads UI and Share extension (needs T4, T5, T6)
- Wave 4: **T10** Live/UI tests, README checklist, archive script, icon (needs all)

Merge order inside a wave is ascending task number. T7/T8/T9 all add files under `apps/ios/Synclet/`. XcodeGen picks sources by folder, so their only shared files are `project.yml` (T9 only) and the generated `.pbxproj`. On a `.pbxproj` conflict, take either side, then run `xcodegen generate` and commit.

Worktrees: `/Volumes/Daten/Privat/Synclet-wt/3-tN`, branches `phase3/task-N` off `phase-3`.

---

### Task 1: SyncletKit platform readiness (shared extension helpers, iOS test lane, device name)

**Files:**
- Move: `apps/macos/Shared/AuthFailureSignal.swift` → `apps/apple/SyncletKit/Sources/SyncletKit/FileProvider/AuthFailureSignal.swift` (make `public`)
- Move: `apps/macos/Shared/SignallingEnumerator.swift` → `apps/apple/SyncletKit/Sources/SyncletKit/FileProvider/SignallingEnumerator.swift` (make `public`)
- Modify: `apps/macos/project.yml` (drop `Shared` from both targets' sources; delete the now-empty `apps/macos/Shared`), regenerate `apps/macos/Synclet.xcodeproj`
- Modify: macOS files that used them (they now `import SyncletKit`, which they already do): `apps/macos/SyncletFileProvider/FileProviderExtension.swift`, `apps/macos/Synclet/Core/AccountsModel.swift`, and any other file that `grep -rl "AuthFailureSignal\|SignallingEnumerator" apps/macos` finds
- Move tests: the AuthFailureSignal tests in `apps/macos/SyncletTests/ExtensionSupportTests.swift` go to `apps/apple/SyncletKit/Tests/SyncletKitTests/AuthFailureSignalTests.swift`. Keep any app-specific remainder in place.
- Modify: `apps/apple/SyncletKit/Sources/SyncletKit/Account/AccountManager.swift` (`defaultDeviceName`)
- Create: `scripts/swiftkit-test-ios.sh`

**Interfaces:**
- Produces:
  - `public enum AuthFailureSignal` with `notificationName`, `markerName`, `throttle`, `isAuthenticationFailure(_:)`, `markerURL(container:key16:)`, `report(container:key16:now:startedAt:post:)`, and the existing read/clear helpers. Signatures are unchanged; they only become `public`.
  - `public final class SignallingEnumerator: NSObject, NSFileProviderEnumerator` with `public init(inner:onError:)`
  - `AccountManager.defaultDeviceName()`: on iOS it returns `UIDevice.current.name` when non-empty, else `"iPad"` or `"iPhone"` by `UIDevice.current.userInterfaceIdiom`. It is `@MainActor`-safe: `MainActor.assumeIsolated` is not allowed. It is called from the app on the main actor, so mark the iOS branch `@MainActor` via a separate `public static func iOSDeviceName() -> String` annotated `@MainActor`. The iOS app passes it into `AccountManager.init(deviceName:)`.
  - `scripts/swiftkit-test-ios.sh`:
    - creates simulator `synclet-kit-<pid>` from `"iPhone 18 Pro"`
    - runs `xcodebuild test -scheme SyncletKit -destination "id=<udid>"` in `apps/apple/SyncletKit`
    - deletes that simulator (trap on EXIT)
    - exits with xcodebuild's status

- [ ] **Step 1: Verify the baseline.**
  - Run `cd apps/apple/SyncletKit && swift test 2>&1 | tail -3` → all pass (336, 11 skipped).
  - Run `cd apps/macos && xcodegen generate && xcodebuild test -scheme Synclet -destination 'platform=macOS' 2>&1 | tail -3` → `** TEST SUCCEEDED **`.
- [ ] **Step 2: Write the failing test.** Create `Tests/SyncletKitTests/AuthFailureSignalTests.swift` by moving the existing AuthFailureSignal test cases verbatim and changing only the import to `@testable import SyncletKit`. Run `swift test --filter AuthFailureSignal` → FAIL (type not in SyncletKit).
- [ ] **Step 3: Move both helpers into the Kit.**
  - `git mv` both files.
  - Add `public` to the type and to every member the macOS app or extension uses.
  - Remove `Shared` from `apps/macos/project.yml`, then run `xcodegen generate`.
- [ ] **Step 4: Run the tests.**
  - `swift test` → PASS, including the moved tests.
  - macOS `xcodebuild test` → `** TEST SUCCEEDED **`.
- [ ] **Step 5: Add the iOS device name and write the script.**
  - Add the device-name code:

```swift
#if os(iOS)
import UIKit
extension AccountManager {
    /// The device name shown in the web's device list ("Jens' iPhone").
    @MainActor public static func iOSDeviceName() -> String {
        let name = UIDevice.current.name
        if !name.isEmpty { return name }
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }
}
#endif
```

  - Write `scripts/swiftkit-test-ios.sh`:

```bash
#!/usr/bin/env bash
# Runs the SyncletKit tests on a private iOS simulator and deletes it afterwards.
set -euo pipefail
cd "$(dirname "$0")/../apps/apple/SyncletKit"
NAME="synclet-kit-$$"
UDID=$(xcrun simctl create "$NAME" "iPhone 18 Pro")
trap 'xcrun simctl delete "$UDID" >/dev/null 2>&1 || true' EXIT
xcodebuild test -scheme SyncletKit -destination "id=$UDID" -derivedDataPath "${DERIVED:-.build/ios-dd}" 2>&1 | tail -n 25
exit "${PIPESTATUS[0]}"
```

- [ ] **Step 6: Run the iOS lane.** `bash scripts/swiftkit-test-ios.sh` → `** TEST SUCCEEDED **`.
  - Tests that only make sense on macOS stay. If a test fails on iOS because of a macOS-only API (pinning `keepDownloaded`, `Host`), wrap only that test in `#if os(macOS)`. Record each wrapped test in the report.
  - Live tests skip without env, as today.
- [ ] **Step 7: Commit.** `git commit -m "refactor(apple): move extension auth helpers into SyncletKit; iOS test lane"`

---

### Task 2: AppAPI – search, recent, trash, share links

**Files:**
- Modify: `apps/apple/SyncletKit/Sources/SyncletKit/API/SyncAPIClient.swift`. Change `send`, `sendNoContent` and `sendRaw` from `private` to internal (no `public`), so the extension in a sibling file can use them. Also add an `api(_:)` segment helper next to `sync(_:)`: `func api(_ segments: [String]) -> [String] { segments }`. Paths are relative to `apiBaseURL`. Verify that `makeURL` builds on `apiBaseURL`; `sync(_:)` prefixes `["sync","v1"]`.
- Create: `apps/apple/SyncletKit/Sources/SyncletKit/API/AppAPI.swift`
- Create: `apps/apple/SyncletKit/Sources/SyncletKit/Models/AppModels.swift`
- Test: `apps/apple/SyncletKit/Tests/SyncletKitTests/AppAPITests.swift`

**Interfaces:**
- Produces (all `public`, all `Sendable`/`Codable`/`Hashable`):

```swift
public struct SyncSearchHit: Codable, Sendable, Hashable { public var item: SyncItem; public var path: String; public var snippet: String?; public var matched: String }
public struct SyncSearchResult: Codable, Sendable, Hashable { public var hits: [SyncSearchHit]; public var total: Int }
public struct TrashEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String; public var itemId: String; public var type: SyncItemType; public var name: String
    public var originalPath: String; public var size: Int64; public var deletedAt: String; public var expiresAt: String?; public var itemCount: Int
}
public struct RestoreResult: Codable, Sendable, Hashable { public var item: SyncItem; public var restoredTo: String; public var renamed: Bool }
public struct ShareLink: Codable, Sendable, Hashable, Identifiable {
    public var id: String; public var itemId: String; public var itemName: String; public var itemType: SyncItemType
    public var url: String; public var hasPassword: Bool; public var expiresAt: String?
    public var allowDownload: Bool; public var allowUpload: Bool
    public var createdAt: String; public var revokedAt: String?; public var hits: Int; public var itemTrashed: Bool
    /// `url` resolved against the server origin when the server returned a relative "/s/<token>".
    public func absoluteURL(server: URL) -> URL?
    public var isActive: Bool { revokedAt == nil && !itemTrashed }   // expiry checked by caller with a date
}
public struct ShareLinkOptions: Encodable, Sendable, Hashable {
    /// `nil` = leave unchanged (PATCH) / no password (POST); `.some(nil)` = remove password (PATCH).
    public var password: String??; public var expiresAt: Date??; public var allowDownload: Bool?; public var allowUpload: Bool?
    public init(password: String?? = nil, expiresAt: Date?? = nil, allowDownload: Bool? = nil, allowUpload: Bool? = nil)
}
extension SyncAPIClient {
    public func search(_ query: String, folder: String? = nil, limit: Int = 20, offset: Int = 0) async throws -> SyncSearchResult  // GET /sync/v1/search
    public func recent(limit: Int = 50) async throws -> [SyncItem]                                                                 // GET /sync/v1/recent
    public func trash() async throws -> [TrashEntry]                                                                               // GET /api/trash
    public func restoreFromTrash(id: String) async throws -> RestoreResult                                                         // POST /api/trash/:id/restore
    public func deleteFromTrash(id: String) async throws                                                                           // DELETE /api/trash/:id
    public func emptyTrash() async throws -> Int                                                                                   // DELETE /api/trash → {removed}
    public func shareLinks(itemID: String) async throws -> [ShareLink]                                                             // GET /api/shares?itemId=
    public func createShareLink(itemID: String, options: ShareLinkOptions) async throws -> ShareLink                               // POST /api/shares
    public func updateShareLink(id: String, options: ShareLinkOptions) async throws -> ShareLink                                   // PATCH /api/shares/:id
    public func revokeShareLink(id: String) async throws                                                                           // DELETE /api/shares/:id
}
```

- JSON encoding of `ShareLinkOptions`:
  - Omit keys whose outer optional is `nil`.
  - Encode `.some(nil)` as JSON `null`.
  - Encode `expiresAt` as ISO 8601 with offset (`ISO8601DateFormatter` with `.withInternetDateTime`).
  - Write a custom `encode(to:)` for this.
  - `createShareLink` encodes `itemId` and the options into one body.
- Error mapping: the existing `SyncAPIError.from`, nothing new. A trash `409` arrives as `code: "conflict"` with status 409, so `SyncAPIError.from` yields `.http(status: 409, code: "conflict", …)` or `.conflict`. Read the current `from` table and pin whichever it returns in a test. Do not change the mapping of 412.

- [ ] **Step 1: Write the failing tests** in `AppAPITests.swift`, using `MockURLProtocol` and `Fixtures` from `TestSupport.swift`:

```swift
func testSearchBuildsQueryAndDecodes() async throws {
    MockURLProtocol.reset { _ in .json(200, #"{"hits":[{"item":\#(Fixtures.itemJSON(id: "f_1")),"path":"Docs","snippet":"a «b» c","matched":"content"}],"total":1}"#) }
    let result = try await Fixtures.client().search("b c", folder: "d_1", limit: 10, offset: 20)
    XCTAssertEqual(result.total, 1); XCTAssertEqual(result.hits.first?.path, "Docs")
    let r = try XCTUnwrap(MockURLProtocol.requests.first)
    XCTAssertEqual(r.path, "/api/sync/v1/search")
    XCTAssertEqual(r.query["q"], "b c"); XCTAssertEqual(r.query["folder"], "d_1")
    XCTAssertEqual(r.query["limit"], "10"); XCTAssertEqual(r.query["offset"], "20")
}
func testRecent() async throws { /* GET /api/sync/v1/recent?limit=50 → [item] */ }
func testTrashListRestoreDeleteEmpty() async throws {
    // GET /api/trash → [entry]; POST /api/trash/t1/restore → {item,restoredTo:"Docs",renamed:true};
    // DELETE /api/trash/t1 → 204; DELETE /api/trash → {"removed":3} → 3. Assert methods + paths.
}
func testTrashRestoreConflict409IsReported() async {
    MockURLProtocol.reset { _ in .error(409, "conflict") }
    // assert the thrown SyncAPIError equals what SyncAPIError.from(status:409, code:"conflict") yields today
}
func testCreateShareLinkBody() async throws {
    MockURLProtocol.reset { _ in .json(201, Fixtures.shareJSON(url: "https://x/s/abc")) }
    let exp = ISO8601DateFormatter().date(from: "2030-01-01T00:00:00Z")!
    _ = try await Fixtures.client().createShareLink(itemID: "d_1", options: .init(password: "pw", expiresAt: exp, allowDownload: true, allowUpload: true))
    let body = try XCTUnwrap(MockURLProtocol.requests.first?.jsonBody)
    XCTAssertEqual(body["itemId"] as? String, "d_1"); XCTAssertEqual(body["password"] as? String, "pw")
    XCTAssertEqual(body["expiresAt"] as? String, "2030-01-01T00:00:00Z"); XCTAssertEqual(body["allowUpload"] as? Bool, true)
}
func testPatchShareLinkRemovesPasswordWithNullAndOmitsUnset() async throws {
    MockURLProtocol.reset { _ in .json(200, Fixtures.shareJSON(url: "/s/abc")) }
    _ = try await Fixtures.client().updateShareLink(id: "s1", options: .init(password: .some(nil)))
    let raw = try XCTUnwrap(MockURLProtocol.requests.first?.bodyString)
    XCTAssertEqual(raw, #"{"password":null}"#)
}
func testRelativeShareURLResolvesAgainstServer() throws {
    let link = try JSONDecoder().decode(ShareLink.self, from: Data(Fixtures.shareJSON(url: "/s/abc").utf8))
    XCTAssertEqual(link.absoluteURL(server: URL(string: "https://synclet.dw83.de")!)?.absoluteString, "https://synclet.dw83.de/s/abc")
    let abs = try JSONDecoder().decode(ShareLink.self, from: Data(Fixtures.shareJSON(url: "https://pub.example/s/abc").utf8))
    XCTAssertEqual(abs.absoluteURL(server: URL(string: "https://synclet.dw83.de")!)?.absoluteString, "https://pub.example/s/abc")
}
func testRevokeShareLink() async throws { /* DELETE /api/shares/s1 → 204 */ }
```

  Add the helpers these tests use to `TestSupport.swift`:
  - `Fixtures.shareJSON(url:)`: a full `ShareLinkWire` JSON
  - `RecordedRequest.query`: `[String: String]` parsed from the URL
  - `RecordedRequest.jsonBody`: `[String: Any]?`
  - `RecordedRequest.bodyString`
  
  Check what `RecordedRequest` already has before adding any of them. JSON key order: encode with `JSONEncoder` and `outputFormatting = [.sortedKeys]`, so the single-key assertion is stable.

- [ ] **Step 2: Run the tests to verify they fail.** `swift test --filter AppAPITests` → compile errors (types missing).
- [ ] **Step 3: Implement.**
  - Write `AppModels.swift` and `AppAPI.swift`.
  - `absoluteURL`:

```swift
public func absoluteURL(server: URL) -> URL? {
    if let u = URL(string: url), u.scheme != nil { return u }
    var c = URLComponents(url: server, resolvingAgainstBaseURL: false); c?.path = url; c?.query = nil; c?.fragment = nil
    return c?.url
}
```

- [ ] **Step 4: Run the tests to verify they pass.**
  - `swift test --filter AppAPITests` → PASS
  - full `swift test` → PASS
  - `bash scripts/swiftkit-test-ios.sh`, if T1 is merged into your base; otherwise only `xcodebuild build -scheme SyncletKit -destination 'generic/platform=iOS Simulator'` → BUILD SUCCEEDED
- [ ] **Step 5: Commit.** `git commit -m "feat(kit): AppAPI for search, recent, trash and share links"`

---

### Task 3: Server – share links in the Sync contract; device-token conformance

**Files:**
- Modify: `docs/sync/SYNC_API.md`:
  - new section `## 11a. Share links (/api/shares)` after §11
  - remove share links from §12
  - add a line to §13 if Buro differs
- Modify: `packages/sync-contract/openapi.yaml` (paths `/shares`, `/shares/{id}`, `/shares/{id}/rotate`; schema `ShareLink`, `CreateShareLink`, `PatchShareLink`)
- Modify/Create: conformance tests in `packages/sync-contract/tests/` (follow the existing file layout; read `packages/sync-contract/README.md` first)
- Modify: `apps/server/src/shares/*` only if a test proves a deviation from the Sync error format or the documented shapes

**Interfaces:**
- Produces: a documented contract with exactly the request/response shapes of today's `ShareLinkWire` and `CreateShareInput` (`packages/shared/src/index.ts:77-93`) and `PatchBody` (`apps/server/src/shares/shares.controller.ts:21`). Document that `url` is relative (`/s/<token>`) unless `SYNCLET_PUBLIC_URL` is set.

- [ ] **Step 1: Write the failing conformance tests.** All use a **device token**: register a device via the documented flow, or use whatever the suite's existing helper uses for `syd_` tokens.
  - shares:
    - create on a folder with `password`, `expiresAt` (+1 day), `allowUpload: true` → 201 with the full shape
    - `GET /api/shares?itemId=` lists it
    - PATCH `{password:null}` → `hasPassword:false`
    - rotate changes `url`
    - DELETE → 204, after which list shows `revokedAt` set or the link is gone (assert today's behaviour; read `shares.service.ts` `revoke`)
    - `allowUpload` on a file → 400 `invalid_request` in Sync error format
    - unknown id → 404 `not_found`
    - an expired `expiresAt` → 400 `invalid_request`
  - trash with a device token:
    - delete a file via `DELETE /sync/v1/items/:id`, then `GET /api/trash` contains it
    - restore → 200 `{item, restoredTo, renamed:false}`
    - delete again and create a same-named file, then restore → `renamed:true`
    - `DELETE /api/trash/:id` → 204
    - `DELETE /api/trash` → `{removed:n}`
  - search and recent with a device token: upload `hello.txt` containing "kumquat", poll `search?q=kumquat` until it hits (≤ 30 s, extraction is async), and check that `recent` contains the file.
- [ ] **Step 2: Run them against the dev server.**
  - Command: as in `packages/sync-contract/README.md` (the dev Postgres from `deploy/compose.dev.yml` on 5434; start the server the way the README says).
  - Expected: the share tests fail on the OpenAPI response validation (no schema yet). Trash, search and recent pass unless there is a server bug.
- [ ] **Step 3: Update the documentation.** Write §11a in `SYNC_API.md` and the OpenAPI paths and schemas. Run `pnpm --filter @synclet/sync-contract lint` (redocly) → valid.
- [ ] **Step 4: Fix any proven deviation** in `apps/server/src/shares` or `trash` with a unit/e2e test next to it.
- [ ] **Step 5: Run everything.**
  - conformance suite → all pass
  - `pnpm --filter @synclet/server test` → all pass
- [ ] **Step 6: Commit.** `git commit -m "feat(contract): share links in Sync API v1; device-token conformance for shares, trash, search"`

---

### Task 4: UploadQueue (persistent, cross-process)

**Files:**
- Create: `apps/apple/SyncletKit/Sources/SyncletKit/Upload/UploadQueue.swift`
- Test: `apps/apple/SyncletKit/Tests/SyncletKitTests/UploadQueueTests.swift`
- Reference: `Sources/SyncletKit/Pinning/PinStore.swift`, the existing `flock` + versioned JSON pattern. Reuse its locking helper if it is factored; otherwise copy the pattern.

**Interfaces:**
- Produces:

```swift
public enum UploadStatus: String, Codable, Sendable, Hashable { case waiting, uploading, done, failed }
public enum UploadFailure: String, Codable, Sendable, Hashable {
    case insufficientStorage, targetGone, signedOut, tooLarge, invalidName, network, sourceUnreadable, other
}
public struct UploadEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String                 // UUID string
    public var accountKey: String
    public var parentId: String
    public var parentName: String         // for display ("→ Fotos")
    public var name: String               // requested name; after done = final server name
    public var size: Int64
    public var status: UploadStatus
    public var failure: UploadFailure?
    public var failureMessage: String?
    public var attempts: Int
    public var nextAttemptAt: Date?
    public var tusURL: URL?
    public var tusOffset: Int64
    public var itemId: String?            // set when done
    public var createdAt: Date
    public var finishedAt: Date?
}
public final class UploadQueue: Sendable {
    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() })   // directory = <appGroup>/uploads
    public convenience init(appGroup: String)
    public var filesDirectory: URL { get }                                             // <dir>/files
    public func fileURL(for id: String) -> URL                                         // <dir>/files/<id>
    /// Copies `source` (streaming, never loads it into memory) into files/<id>, then appends a waiting entry.
    /// The copy is complete when this returns. Throws when the source is unreadable.
    @discardableResult
    public func enqueue(source: URL, name: String, accountKey: String, parentId: String, parentName: String) throws -> UploadEntry
    public func all() -> [UploadEntry]                                                 // newest first, after pruning
    public func entry(id: String) -> UploadEntry?
    /// Atomic read-modify-write under the lock. Returns the updated entry (nil if gone).
    @discardableResult
    public func update(id: String, _ change: (inout UploadEntry) -> Void) -> UploadEntry?
    /// Entries ready to run now: waiting with nextAttemptAt == nil || <= now, oldest first.
    public func runnable() -> [UploadEntry]
    public func retry(id: String)                       // failed → waiting, attempts = 0, failure nil
    public func remove(id: String)                      // entry + copy
    public func removeAll(accountKey: String)           // on sign-out
    /// Drops done entries older than 24 h, deletes copies of done entries, deletes orphan files in files/.
    public func prune()
    public static let currentVersion = 1
}
```

- Storage:
  - `queue.json` = `{"v":1,"entries":[…]}`, written atomically (temp + rename) while holding `flock(LOCK_EX)` on `<dir>/queue.lock`
  - reads take `LOCK_SH`
  - a missing file means an empty queue
  - a corrupt file or an unknown `v` is moved to `queue.json.corrupt-<timestamp>`, and the queue starts empty; copies without entries are then pruned as orphans
  - dates are ISO 8601

- [ ] **Step 1: Write the failing tests:**

```swift
func testEnqueueCopiesSourceSoDeletingSourceIsHarmless() throws {
    let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
    let src = Fixtures.tempFile("hello")
    let e = try q.enqueue(source: src, name: "a.txt", accountKey: "k", parentId: "root", parentName: "Meine Dateien")
    try FileManager.default.removeItem(at: src)
    XCTAssertEqual(try String(contentsOf: q.fileURL(for: e.id), encoding: .utf8), "hello")
    XCTAssertEqual(e.status, .waiting); XCTAssertEqual(e.size, 5)
}
func testPersistsAcrossInstances() throws { /* enqueue on q1, read with q2 on same dir → same entry */ }
func testWritesVersionedJSON() throws { /* read queue.json, assert top-level "v" == 1 */ }
func testCorruptFileIsSetAsideAndQueueStartsEmpty() throws { /* write "garbage" → all() == [], a queue.json.corrupt-* exists */ }
func testUnknownVersionIsSetAside() throws { /* {"v":99,"entries":[]} → all() == [], corrupt file kept */ }
func testConcurrentEnqueueFromTwoStoresKeepsAll() async throws {
    let dir = Fixtures.tempDirectory(); let a = UploadQueue(directory: dir), b = UploadQueue(directory: dir)
    let src = Fixtures.tempFile("x")
    await withTaskGroup(of: Void.self) { g in
        for i in 0..<40 { let q = i.isMultiple(of: 2) ? a : b
            g.addTask { _ = try? q.enqueue(source: src, name: "f\(i)", accountKey: "k", parentId: "root", parentName: "M") } }
    }
    XCTAssertEqual(a.all().count, 40)
}
func testRunnableRespectsNextAttemptAndOrder() throws { /* clock injection via now; entry with future nextAttemptAt excluded; oldest first */ }
func testRetryResetsFailure() throws { /* update to failed(.network, attempts 10) → retry → waiting, attempts 0, failure nil */ }
func testPruneDropsOldDoneAndOrphans() throws {
    // done entry finishedAt = now-25h → gone; done entry finishedAt = now-1h → kept but its copy deleted;
    // files/<random> without entry → deleted; waiting entry's copy kept.
}
func testRemoveAllForAccount() throws { /* two accounts; removeAll("k1") keeps k2's entries and files */ }
func testEnqueueUnreadableSourceThrowsAndLeavesNoEntry() { /* source path that doesn't exist → throws; all() empty; files/ empty */ }
```

- [ ] **Step 2: Run the tests to verify they fail.** `swift test --filter UploadQueueTests` → compile errors.
- [ ] **Step 3: Implement.**
  - Copy with `FileManager.copyItem`, which clones or streams on APFS. When the source is security-scoped, the caller (app/extension) already holds access.
  - The entry is appended only after the copy succeeds. On a copy failure, remove the partial file.
- [ ] **Step 4: Run the tests to verify they pass.** `swift test --filter UploadQueueTests` → PASS; full `swift test` → PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(kit): persistent cross-process upload queue"`

---

### Task 5: BackgroundUploader (background URLSession, single + tus chunk files)

**Files:**
- Create: `apps/apple/SyncletKit/Sources/SyncletKit/Upload/BackgroundUploader.swift`
- Create: `apps/apple/SyncletKit/Sources/SyncletKit/Upload/UploadRequestBuilder.swift` (pure request construction + response interpretation, unit-testable without a session)
- Test: `apps/apple/SyncletKit/Tests/SyncletKitTests/UploadRequestBuilderTests.swift`, `BackgroundUploaderTests.swift`
- Read first: `Transfer/TusUploader.swift` (metadata encoding, header names, `TusPatchResult`, `isSameOrigin`), `API/SyncAPIClient.swift` `applyUploadHeaders`, `uploadNewFile`, `SYNC_API.md` §6.4 and §7

**Interfaces:**
- Consumes (T4): `UploadQueue`, `UploadEntry`, `UploadStatus`, `UploadFailure`.
- Produces:

```swift
public enum UploadPlan: Equatable, Sendable { case single, tus }
public enum UploadRequestBuilder {
    public static let threshold: Int64 = 32 * 1024 * 1024
    public static let chunkSize: Int64 = 16 * 1024 * 1024
    public static func plan(size: Int64) -> UploadPlan                         // size > threshold ⇒ .tus
    public static func singleUpload(api: SyncAPIClient, entry: UploadEntry, token: String) throws -> URLRequest   // POST …/items/upload?parentId&name&onConflict=rename
    public static func tusCreate(api: SyncAPIClient, entry: UploadEntry, token: String) throws -> URLRequest      // POST tus endpoint, Upload-Length, Upload-Metadata (name,parentId,onConflict=rename)
    public static func tusHead(url: URL, token: String) -> URLRequest
    public static func tusPatch(url: URL, offset: Int64, token: String) -> URLRequest                             // body comes from a chunk file
    /// Maps a finished task to the next step.
    public static func interpret(status: Int, headers: [String: String], body: Data, for step: UploadStep) -> UploadStepResult
}
public enum UploadStep: Codable, Sendable, Hashable { case single, tusCreate, tusHead, tusPatch(offset: Int64, length: Int64) }
public enum UploadStepResult: Equatable, Sendable {
    case finished(itemId: String, name: String)        // single 201 / last tus PATCH with item JSON or 204+header (see §7)
    case tusCreated(URL)                               // Location (resolved against the request URL, same-origin check)
    case tusOffset(Int64)                              // HEAD or non-final PATCH: Upload-Offset
    case restartTus                                    // HEAD/PATCH 404 or 410: the tus URL is gone
    case retry                                         // 5xx, 423, 409 offset mismatch (re-HEAD), transport errors
    case fail(UploadFailure, message: String?)         // 507 insufficientStorage, 404 parent (single/create) targetGone, 401 signedOut, 413 tooLarge, 400 invalid_name invalidName
}
public final class BackgroundUploader: NSObject, Sendable {
    /// identifier: "tech.jensk.synclet.upload.app" (app) or "tech.jensk.synclet.upload.share" (extension).
    public init(identifier: String, queue: UploadQueue, appGroup: String?, accounts: AccountStore, credentials: CredentialStore,
                sessionConfiguration: URLSessionConfiguration? = nil,   // tests inject .ephemeral + MockURLProtocol
                now: @escaping @Sendable () -> Date = { Date() },
                onChange: @escaping @Sendable (UploadEntry) -> Void = { _ in })
    /// Starts runnable entries (max 2 concurrently per process) that are not already in flight in this session.
    public func pump() async
    /// Cancels the in-flight task (if any) and removes the entry.
    public func cancel(id: String) async
    /// From application(_:handleEventsForBackgroundURLSession:completionHandler:).
    public func handleBackgroundEvents(completion: @escaping @Sendable () -> Void)
}
```

- How it works:
  - One `URLSession(configuration: .background(withIdentifier:))` with `sharedContainerIdentifier = appGroup`, `sessionSendsLaunchEvents = true`, `isDiscretionary = false`.
  - Every task is an `uploadTask(with:fromFile:)` or a `dataTask` for HEAD. `taskDescription` holds JSON `{entryId, step}`, so completions are routed after relaunch.
  - **Response bodies:** background upload tasks deliver the body via `urlSession(_:dataTask:didReceive:)`; accumulate it per task.
  - **tus chunks:** before each PATCH, write bytes `[offset, min(offset+chunk, size))` of `files/<id>` to `<dir>/chunks/<id>-<offset>`, upload from that file, and delete it after completion.
  - **Token:** read per task start from `CredentialStore` (`accountKey`). A missing token → `.fail(.signedOut)`.
  - **Before starting an entry, mark it `uploading`.** On `.retry`:
    - `attempts += 1`, `nextAttemptAt = now + min(2 * 2^attempts, 300)` s
    - `waiting`, or `failed(.network)` once `attempts >= 10`
  - **On `.finished`:** `done`, `itemId`, `name` = server name, `finishedAt`, delete the copy.
  - **After each completion:** call `pump()` again and `onChange(entry)`.
  - **After a relaunch, before pumping:** entries in `uploading` with no live task in `session.allTasks` go back to `waiting`. A tus entry with a `tusURL` starts with HEAD.

- [ ] **Step 1: Write the failing builder tests** (pure, no session):

```swift
func testPlanThreshold() { XCTAssertEqual(UploadRequestBuilder.plan(size: 32*1024*1024), .single); XCTAssertEqual(UploadRequestBuilder.plan(size: 32*1024*1024+1), .tus) }
func testSingleUploadRequest() throws { /* POST /api/sync/v1/items/upload ?parentId=d_1&name=Foto%20(1).heic&onConflict=rename, Bearer, Content-Type octet-stream */ }
func testTusCreateHeaders() throws { /* Tus-Resumable 1.0.0, Upload-Length = size, Upload-Metadata contains base64 name/parentId/onConflict=rename (same encoding as TusUploader) */ }
func testInterpretSingle201Finished() { /* body = item JSON with name "Foto (2).heic" → .finished(itemId, "Foto (2).heic") */ }
func testInterpretErrors() {
    // 507 → .fail(.insufficientStorage), 401 → .fail(.signedOut), 413 → .fail(.tooLarge), 400 invalid_name → .fail(.invalidName),
    // 404 on .single / .tusCreate → .fail(.targetGone); 404/410 on .tusHead/.tusPatch → .restartTus; 503 → .retry; 409 on .tusPatch → .retry
}
func testInterpretTusCreateLocationRelative() { /* Location "/api/sync/v1/uploads/abc" resolved against request → absolute */ }
func testInterpretTusCreateCrossOriginLocationIsRetry() { /* Location on another host → .fail(.other) — never send the token elsewhere */ }
func testInterpretPatchOffsetAndFinal() { /* 204 + Upload-Offset < size → .tusOffset; final PATCH per §7 → .finished */ }
```

  Read `SYNC_API.md` §7 for how the final PATCH reports the created item (header or body), and pin exactly that.
- [ ] **Step 2: Run the tests to verify they fail.** `swift test --filter UploadRequestBuilderTests` → compile errors.
- [ ] **Step 3: Implement `UploadRequestBuilder`** and run the builder tests → PASS.
- [ ] **Step 4: Write the failing uploader tests.**
  - Background sessions don't run in `swift test`, so the uploader takes `sessionConfiguration`. Tests pass `.ephemeral` with `protocolClasses = [MockURLProtocol.self]`.
  - Real background behaviour is covered by the live test in T10.

```swift
func testSmallFileSingleUploadMarksDoneAndDeletesCopy() async throws { /* enqueue 5 bytes; pump; wait onChange done; copy gone; one POST */ }
func testLargeFileUsesTusInChunks() async throws { /* size 40 MiB sparse file (truncate) → POST create, PATCH offset 0 (16 MiB), 16 MiB, 32 MiB (8 MiB) → done; chunk files cleaned */ }
func testResumeUsesHeadOffset() async throws { /* entry has tusURL + status uploading, no live task → HEAD → Upload-Offset 16 MiB → PATCH starts at 16 MiB */ }
func testExpiredTusURLRestarts() async throws { /* HEAD → 404 → new POST create → PATCH from 0 */ }
func testNetworkErrorsBackOffThenFail() async throws { /* always 503, injected clock; attempts increments, nextAttemptAt grows; after 10 → failed(.network) */ }
func testInsufficientStorageFailsImmediately() async throws { /* 507 → failed(.insufficientStorage), attempts 0, copy kept for retry */ }
func testMissingTokenFailsSignedOut() async throws { /* no credential → failed(.signedOut), no request sent */ }
func testCancelRemovesEntry() async throws { /* cancel while uploading → entry gone, copy gone */ }
```

  For the 40 MiB file use `FileHandle.truncate(atOffset:)` (a sparse file) to keep tests fast. The mock answers PATCH with `Upload-Offset = offset + body length`.
- [ ] **Step 5: Run the tests to verify they fail**, then implement `BackgroundUploader`.
- [ ] **Step 6: Run the tests to verify they pass.**
  - full `swift test` → PASS
  - iOS lane `bash scripts/swiftkit-test-ios.sh` → `** TEST SUCCEEDED **` (T1 is merged into `phase-3` before this wave)
- [ ] **Step 7: Commit.** `git commit -m "feat(kit): background uploader (single + tus chunk files) for the upload queue"`

---

### Task 6: iOS project, File Provider extension, accounts and login, foreground refresh

**Files:**
- Create: `apps/ios/project.yml`. Targets:
  - `Synclet` (application, iOS)
  - `SyncletFileProvider` (app-extension)
  - `SyncletShare` (app-extension: placeholder `ShareViewController` that shows "Kommt in Task 9" only in DEBUG; T9 replaces it)
  - `SyncletTests` (unit, host = app)
  - `SyncletUITests` (ui-testing)
- Create:
  - `apps/ios/Synclet/App/SyncletApp.swift`
  - `apps/ios/Synclet/App/AppDelegate.swift` (`UIApplicationDelegateAdaptor`: background URLSession events, BGTask registration)
  - `apps/ios/Synclet/Core/AppEnvironment.swift` (builds `SharedConfiguration`, `CredentialStore`, `AccountStore`, `AccountManager` with `deviceName: AccountManager.iOSDeviceName()`)
  - `apps/ios/Synclet/Core/AccountsModel.swift`, `LoginModel.swift`, `BrowserLogin.swift` (ported from macOS; drop Finder/AppKit/menu/pinning parts)
  - `apps/ios/Synclet/Core/ForegroundMonitor.swift` (ported from `ChangeMonitor` without `SystemWakeUps`/AppKit; SSE + 60 s polling while active; calls `onChange(accountKey)`, then `signalEnumerator(.workingSet)`)
  - `apps/ios/Synclet/Core/BackgroundRefresh.swift` (`BGAppRefreshTask` `tech.jensk.synclet.ios.refresh`: signals every domain's working set and reschedules for +30 min)
  - `apps/ios/Synclet/Core/TestLogin.swift` (DEBUG only, see below)
  - `apps/ios/Synclet/Views/RootView.swift` (empty state with "Konto hinzufügen" → `LoginView`; with accounts → placeholder list of accounts; T7 replaces the body with the browser shell)
  - `apps/ios/Synclet/Views/LoginView.swift`
  - `apps/ios/Synclet/Views/AccountsView.swift` (accounts list: status, „Neu anmelden“, Abmelden with confirmation)
  - `apps/ios/Synclet/Resources/{Assets.xcassets, Localizable.xcstrings}`
  - `apps/ios/Synclet/Synclet.entitlements` (app group, keychain group)
  - `apps/ios/SyncletFileProvider/{FileProviderExtension.swift, SyncletFileProvider.entitlements}`
  - `apps/ios/SyncletShare/{ShareViewController.swift, SyncletShare.entitlements}`
  - `apps/ios/SyncletTests/{AccountsModelTests, LoginModelTests, ForegroundMonitorTests, TestSupport}.swift`
  - `apps/ios/README.md` (build + test commands; T10 adds the checklist)
  - `scripts/ios-test.sh` (like `swiftkit-test-ios.sh`, but `xcodegen generate` + `xcodebuild test -scheme Synclet` on a private simulator)
- Info.plist values via `project.yml` `info.properties`:
  - App:
    - `CFBundleDisplayName: Synclet`, `SyncletAppGroup: group.tech.jensk.synclet`, `SyncletKeychainAccessGroup: $(AppIdentifierPrefix)tech.jensk.synclet.shared`
    - `CFBundleURLTypes` scheme `synclet`
    - `NSAppTransportSecurity: {NSAllowsLocalNetworking: true}`
    - `BGTaskSchedulerPermittedIdentifiers: [tech.jensk.synclet.ios.refresh]`, `UIBackgroundModes: [fetch, processing]`
    - `NSPhotoLibraryUsageDescription` (de/en via InfoPlist.xcstrings)
    - `ITSAppUsesNonExemptEncryption: false`
    - `UILaunchScreen: {}`, `UISupportedInterfaceOrientations` (all on iPad, portrait + landscape on iPhone)
  - FileProvider:
    - `NSExtension`: `NSExtensionPointIdentifier: com.apple.fileprovider-nonui`, `NSExtensionPrincipalClass: $(PRODUCT_MODULE_NAME).FileProviderExtension`, `NSExtensionFileProviderDocumentGroup: group.tech.jensk.synclet`, `NSExtensionFileProviderSupportsEnumeration: true`
    - the same `Synclet*` keys

**Interfaces:**
- Consumes (T1): public `AuthFailureSignal`, `SignallingEnumerator`, `AccountManager.iOSDeviceName()`.
- Produces, for T7–T10:

```swift
@MainActor @Observable final class AppEnvironment {
    static let shared: AppEnvironment
    let configuration: SharedConfiguration; let accountStore: AccountStore; let credentials: CredentialStore
    let manager: AccountManager; let accounts: AccountsModel
    func client(for accountKey: String) -> SyncAPIClient?        // manager.client(for:)
    func signalWorkingSet(accountKey: String) async               // signalEnumerator(.workingSet) for that domain
}
@MainActor @Observable final class AccountsModel {
    var entries: [AccountEntry]                                    // AccountEntry { account: StoredAccount; status: AccountStatus(.ok/.signInRequired) }
    var selectedKey: String?                                       // the account the browser shows (persisted in UserDefaults "selectedAccount")
    func reload(); func add(server: URL, tokens: AppTokens) async throws -> StoredAccount
    func signOut(key: String) async; func processAuthFailures()
    var changeEvents: AsyncStream<String> { get }                  // accountKey each time ForegroundMonitor sees a change (T7 subscribes)
}
```

- Extension: `final class FileProviderExtension: SyncletReplicatedExtension`. It wraps enumerators in `SignallingEnumerator` and reports `.notAuthenticated` via `AuthFailureSignal`. Port it from the macOS extension without `ErrorLog` and thumbnails overrides; keep the thumbnail override only if the macOS one adds behaviour beyond the base class.
- Scene phases:
  - `.active` → `ForegroundMonitor.start()` for each signed-in account, `processAuthFailures()`
  - `.background` → `stop()` all monitors, schedule `BGAppRefreshTask`
- **DEBUG test login** (`TestLogin.swift`, compiled only `#if DEBUG`):
  - Launch arguments `-SyncletTestServer <url> -SyncletTestToken <syd_…>` (both required).
  - It calls `AccountManager`'s existing path for storing an already-registered device token.
  - If no such API exists, add `func addRegistered(server: URL, deviceToken: String) async throws -> StoredAccount` to `AccountManager` in SyncletKit. It fetches `/account` with the token, then upserts the account, saves the token and adds the domain. Unit-test it in SyncletKit.
  - Release builds must not contain the symbol: guard the whole file with `#if DEBUG`, and verify with `nm` in Step 6.

- [ ] **Step 1: Generate the empty project and build it.**
  - Write `project.yml` (team, bundle IDs, deployment target `iOS: "26.0"`, `TARGETED_DEVICE_FAMILY: "1,2"`, package `SyncletKit` path `../apple/SyncletKit`).
  - Run `cd apps/ios && xcodegen generate && xcodebuild build -scheme Synclet -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` → BUILD SUCCEEDED.
- [ ] **Step 2: Write the failing tests:**
  - `LoginModelTests`, ported from macOS `LoginModelTests` (server check, PKCE URL, `client_id=ios`, state mismatch → error, cancel)
  - `AccountsModelTests`:
    - add → entry, selected
    - `signOut` → domain removed, token deleted, `selectedKey` moves to the next account or nil
    - an auth-failure marker → `.signInRequired`; signing in again clears it
  - `ForegroundMonitorTests`, ported from `ChangeMonitorTests` minus wake-ups:
    - SSE `changes` → `onChange`
    - stream down → polls every 60 s (injected clock/sleeper), compares cursors, calls `onChange` when it moved
    - `stop()` cancels
- [ ] **Step 3: Run the tests to verify they fail.** `bash scripts/ios-test.sh` → FAIL.
- [ ] **Step 4: Implement the models, views, extension, BGTask and DEBUG login.**
- [ ] **Step 5: Run the tests to verify they pass.**
  - `bash scripts/ios-test.sh` → `** TEST SUCCEEDED **`
  - also on iPad: `IOS_DEVICE="iPad Pro 13-inch (M5)" bash scripts/ios-test.sh` (the script honours `IOS_DEVICE`, default "iPhone 18 Pro") → `** TEST SUCCEEDED **`
- [ ] **Step 6: Verify the Release build.** `xcodebuild build -scheme Synclet -configuration Release -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO -derivedDataPath .build/rel` → BUILD SUCCEEDED, and `nm -j .build/rel/Build/Products/Release-iphonesimulator/Synclet.app/Synclet | grep -c SyncletTestToken` → `0`.
- [ ] **Step 7: Commit** (including the generated `Synclet.xcodeproj`). `git commit -m "feat(ios): project, File Provider extension, accounts/login, foreground + background refresh"`

---

### Task 7: Browser – folder view, thumbnails, QuickLook, manage actions

**Files:**
- Create in `apps/ios/Synclet/`:
  - `Browser/FolderModel.swift`
  - `Browser/FolderView.swift`
  - `Browser/ItemRow.swift`
  - `Browser/ItemGridCell.swift`
  - `Browser/MovePicker.swift`
  - `Browser/ItemActions.swift` (context menu + swipe actions)
  - `Browser/BrowserShell.swift` (iPhone `TabView` + `NavigationStack`; iPad `NavigationSplitView`)
  - `Preview/ThumbnailCache.swift`
  - `Preview/FileCache.swift`
  - `Preview/QuickLookView.swift` (`UIViewControllerRepresentable` around `QLPreviewController`)
  - `Core/MutationErrors.swift`
- Modify: `apps/ios/Synclet/Views/RootView.swift` (show `BrowserShell` when accounts exist)
- Test, in `apps/ios/SyncletTests/`:
  - `FolderModelTests.swift`
  - `ThumbnailCacheTests.swift`
  - `FileCacheTests.swift`
  - `MutationErrorsTests.swift`

**Interfaces:**
- Consumes (T6): `AppEnvironment`, `AccountsModel.changeEvents`, `AppEnvironment.signalWorkingSet`. From the Kit: `SyncAPIClient.children/createFolder/rename/move/deleteItem/thumbnail/downloadContent`, `SpaceLayout`/`SyncAccount.spaces`. The browser root is the `personal` space's `rootId`, titled „Meine Dateien“.
- Produces:

```swift
enum BrowserSort: String, CaseIterable { case name, modified, size }
enum BrowserLayout: String { case list, grid }                     // UserDefaults "browserLayout"
@MainActor @Observable final class FolderModel {
    init(accountKey: String, folderId: String, title: String, api: SyncAPIClient, signal: @escaping (String) async -> Void)
    private(set) var items: [SyncItem]; private(set) var state: LoadState   // .idle .loading .loaded .offline .failed(String)
    var sort: BrowserSort; var notice: String?                              // transient message („Wurde inzwischen geändert“)
    func load() async                                                       // all pages of children; folders first, then sort
    func createFolder(name: String) async -> Bool
    func rename(_ item: SyncItem, to name: String) async -> Bool
    func move(_ items: [SyncItem], to folderId: String) async
    func delete(_ items: [SyncItem]) async
}
enum MutationOutcome: Equatable { case ok, conflictReloaded, nameTaken, gone, invalidName(String), offline, failed(String) }
enum MutationErrors { static func outcome(for error: Error) -> MutationOutcome; static func message(_ o: MutationOutcome) -> String? }
actor ThumbnailCache { init(directory: URL, limitBytes: Int = 200_000_000); func image(for item: SyncItem, api: SyncAPIClient) async -> UIImage? }
actor FileCache { init(directory: URL, limitBytes: Int64 = 1_000_000_000); func localURL(for item: SyncItem, api: SyncAPIClient, progress: Progress) async throws -> URL; func clear() }
```

- Rules:
  - `load()` maps `URLError` transport errors to `.offline`.
  - Mutations use `If-Match` = `item.etag`.
  - Outcome handling:
    - `.conflict` (412) → `notice = „Wurde inzwischen geändert“`, reload, no retry
    - `.nameConflict` → `.nameTaken` (the sheet stays open, inline error „Name bereits vergeben“)
    - `.notFound` → `notice = „Nicht mehr vorhanden“`, reload
    - `.invalidName(msg)` → inline message
  - Every success → `signal(accountKey)` and reload.
  - Delete asks for confirmation (`confirmationDialog`, „In den Papierkorb legen“); multi-select delete shows the count.
  - `FileCache`:
    - the key is `item.id` plus `item.version ?? item.contentEtag`; a different version is a miss and evicts the old file
    - stored file name = item name, so QuickLook shows the right type
    - LRU by access date, evicting when over the limit
  - `ThumbnailCache`:
    - only items with `preview?.thumbnail == true`
    - stores data + ETag, revalidates with `If-None-Match` at most once per item per app session
    - LRU eviction
  - On `changeEvents` for the shown account, a visible `FolderModel` reloads, debounced to 0.5 s.
  - **Name pre-check:** reject empty names, `/`, `\`, `: * ? " < > |` and names over 255 UTF-8 bytes with an inline message before sending. The server stays authoritative.

- [ ] **Step 1: Write the failing tests.** They use a `MockURLProtocol`-style stub in `SyncletTests/TestSupport.swift`; copy the Kit's helper, since test targets don't share code.

```swift
func testLoadSortsFoldersFirstThenName() async { /* children: b.txt, A-folder, a.txt → [A-folder, a.txt, b.txt] */ }
func testLoadFollowsPagination() async { /* nextPageToken twice → all items */ }
func testOfflineState() async { /* URLError.notConnectedToInternet → .offline */ }
func testRenameSendsIfMatchAndSignals() async { /* PATCH If-Match "\"<etag>\"", signal called once, reload done */ }
func testRenameConflictReloadsAndReports() async {
    // PATCH → 412 conflict → returns false, notice == "Wurde inzwischen geändert" (de) / "Changed in the meantime" (en),
    // exactly one PATCH (no retry), followed by a children GET
}
func testCreateFolderNameTakenKeepsSheetOpen() async { /* 409 name_conflict → false, outcome .nameTaken */ }
func testDeleteGoneReloads() async { /* 404 → notice „Nicht mehr vorhanden“ */ }
func testMoveMultipleItems() async { /* two PATCH parentId, one signal */ }
func testNamePrecheckRejectsInvalid() { /* "", "a/b", "x:y", 256 × "a" → invalid; "Bericht 2026.pdf" → valid */ }
func testFileCacheHitMissOnVersionChangeAndLRU() async throws { /* 2 downloads same version → 1 GET; version+1 → GET again; limit 10 bytes evicts oldest */ }
func testThumbnailCacheRevalidatesOncePerSession() async { /* first: 200 + ETag; second call same session: no request; new cache instance: If-None-Match → 304 uses stored data */ }
```

- [ ] **Step 2: Run the tests to verify they fail.** `bash scripts/ios-test.sh` → FAIL.
- [ ] **Step 3: Implement the models, caches and views.**
  - **Views:**
    - `List` with `ItemRow` (thumbnail or SF Symbol by `mime`, name, size/date subtitle), or `LazyVGrid` with `ItemGridCell`
    - toolbar: layout toggle, sort menu, „+“ menu (T9 adds the upload entries; here only „Neuer Ordner“)
    - `EditButton` for multi-select
    - `.refreshable { await model.load() }`
    - offline: `ContentUnavailableView("Offline", systemImage: "wifi.slash")` with an „Erneut versuchen“ button
  - **Opening a file:** a download sheet with a `ProgressView`, then `QuickLookView`. Its share button is the system one; QuickLook provides „Sichern in Dateien/Fotos“.
- [ ] **Step 4: Run the tests to verify they pass.** `bash scripts/ios-test.sh` and `IOS_DEVICE="iPad Pro 13-inch (M5)" bash scripts/ios-test.sh` → `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ios): browser with thumbnails, QuickLook and manage actions"`

---

### Task 8: Search, recent, trash, share links (UI)

**Files:**
- Create in `apps/ios/Synclet/`:
  - `Search/SearchModel.swift`
  - `Search/SearchView.swift`
  - `Recent/RecentView.swift`
  - `Recent/RecentModel.swift`
  - `Trash/TrashModel.swift`
  - `Trash/TrashView.swift`
  - `Share/ShareLinkModel.swift`
  - `Share/ShareLinkView.swift`
  - `Share/ActivityView.swift` (`UIActivityViewController` wrapper)
- Modify:
  - `apps/ios/Synclet/Browser/BrowserShell.swift`: add the tabs/sidebar entries „Zuletzt“, „Suche“ and „Papierkorb“
  - `apps/ios/Synclet/Browser/ItemActions.swift`: add „Link teilen“
  
  T7 owns these files. If T7 is not merged yet when T8 starts, T8 adds its entries via a small `BrowserDestinations` enum in `Browser/BrowserDestinations.swift` that T7's shell reads. In that case, the controller merges T7 first and rebases T8.
- Test, in `apps/ios/SyncletTests/`:
  - `SearchModelTests.swift`
  - `TrashModelTests.swift`
  - `ShareLinkModelTests.swift`
  - `RecentModelTests.swift`

**Interfaces:**
- Consumes (T2): `search`, `recent`, `trash`, `restoreFromTrash`, `deleteFromTrash`, `emptyTrash`, `shareLinks`, `createShareLink`, `updateShareLink`, `revokeShareLink`, `ShareLink.absoluteURL(server:)`. From T6: `AppEnvironment`.
- Produces:

```swift
@MainActor @Observable final class SearchModel {
    var query: String; var scopeFolderId: String?; private(set) var hits: [SyncSearchHit]; private(set) var state: LoadState
    func queryChanged() // debounced 300 ms, min 2 chars, cancels the previous request
    func loadMore() async // offset paging, 20 per page, stops at total
    static func highlighted(_ snippet: String) -> AttributedString   // «…» → bold, markers removed
}
@MainActor @Observable final class TrashModel {
    private(set) var entries: [TrashEntry]; var notice: String?
    func load() async; func restore(_ e: TrashEntry) async; func deleteForever(_ e: TrashEntry) async; func empty() async
}
@MainActor @Observable final class ShareLinkModel {
    init(item: SyncItem, server: URL, api: SyncAPIClient)
    private(set) var active: ShareLink?        // newest link with isActive && (expiresAt == nil || expiresAt > now)
    var password: String; var usePassword: Bool; var expiresAt: Date?; var allowDownload: Bool; var allowUpload: Bool  // allowUpload only for folders
    func load() async; func createOrUpdate() async -> URL?; func revoke() async
}
```

- Rules:
  - **Trash:**
    - restore → `notice` „Wiederhergestellt in „<restoredTo>““; with `renamed` it reads „… als „<item.name>““
    - restore `409` → the server message
    - restore success → `signalWorkingSet`
    - delete forever and empty need confirmation
  - **Search:** a hit opens the file (T7's `FileCache` + QuickLook) or navigates to the folder. On iPad, „Im Ordner suchen“ sets `scopeFolderId` to the current folder.
  - **Share link:** `createOrUpdate()` → if there is no `active` link, POST; else PATCH the changed fields. It returns `absoluteURL`, which goes into the share sheet (`ActivityView`). „Link widerrufen“ needs confirmation.

- [ ] **Step 1: Write the failing tests:**

```swift
func testSearchDebouncesAndCancels() async { /* "ku","kum","kumq" within 100 ms → one request q=kumq */ }
func testSearchMinTwoChars() async { /* "k" → no request, hits empty */ }
func testSearchPaging() async { /* total 45 → 3 pages, stops */ }
func testHighlightedRemovesMarkers() { /* "a «b» c" → characters "a b c", "b" bold */ }
func testRestoreRenamedNotice() async { /* renamed:true → notice contains new name; signal called */ }
func testRestoreConflictShowsServerMessage() async { /* 409 conflict message "target busy" → notice "target busy" */ }
func testShareCreateWhenNoneActive() async { /* GET [] → POST; returns absolute URL (relative "/s/x" resolved) */ }
func testShareReuseActiveAndPatchOnlyChanges() async { /* GET [active] → toggle allowDownload → PATCH {"allowDownload":false} only */ }
func testExpiredOrRevokedLinkIsNotActive() async { /* revokedAt set or expiresAt past → active nil → POST on create */ }
func testAllowUploadIgnoredForFiles() async { /* file item → POST body has no allowUpload */ }
func testRecentLoads() async { /* GET recent → items */ }
```

- [ ] **Step 2: Run the tests to verify they fail.** `bash scripts/ios-test.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests to verify they pass.** `bash scripts/ios-test.sh` (iPhone and iPad) → `** TEST SUCCEEDED **`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ios): search, recent, trash and share links"`

---

### Task 9: Uploads – picker, uploads view, Share extension

**Files:**
- Create in `apps/ios/Synclet/`:
  - `Upload/UploadCenter.swift` (app-side owner of `UploadQueue` + `BackgroundUploader` identifier `tech.jensk.synclet.upload.app`)
  - `Upload/UploadsView.swift`
  - `Upload/PhotoImport.swift` (PhotosPicker items → temp files, original or JPEG)
  - `Upload/UploadMenu.swift` („Fotos“, „Dateien“ entries for the „+“ menu)
- Create in `apps/ios/SyncletShare/`:
  - `ShareViewController.swift`, which replaces T6's placeholder
  - `ShareRootView.swift` (account + folder picker, „Hochladen“)
  - `ShareFolderPicker.swift`
- Modify:
  - `apps/ios/project.yml`: Share extension `NSExtension`:
    - `NSExtensionPointIdentifier: com.apple.share-services`
    - `NSExtensionPrincipalClass: $(PRODUCT_MODULE_NAME).ShareViewController`
    - `NSExtensionAttributes.NSExtensionActivationRule` as a `SUBQUERY` string accepting `public.item`, `public.image` and `public.movie` (max 50 items)
    - the `Synclet*` keys; the extension depends on SyncletKit
  - `apps/ios/Synclet/App/AppDelegate.swift`: `handleEventsForBackgroundURLSession` → `UploadCenter.shared.uploader.handleBackgroundEvents`. On launch, `prune()` + `pump()`.
  - `apps/ios/Synclet/Browser/FolderView.swift`: add `UploadMenu` to the „+“ menu; T7 owns this file, so add only the menu hook.
  - `apps/ios/Synclet/Browser/BrowserShell.swift`: the „Uploads“ entry, with a badge for running and failed uploads.
  - Settings: the toggle „Fotos als JPEG hochladen“ (UserDefaults `uploadPhotosAsJPEG`, default false), and „Cache leeren“ (calls T7's `FileCache.clear()` and `ThumbnailCache`)
- Test, in `apps/ios/SyncletTests/`:
  - `UploadCenterTests.swift`
  - `PhotoImportTests.swift`
  - `ShareTargetTests.swift` (logic only)

**Interfaces:**
- Consumes (T4, T5): `UploadQueue`, `BackgroundUploader`, `UploadEntry`. From T6: `AppEnvironment`, `AccountsModel`. From T7: `FileCache.clear()`, `ThumbnailCache`, `FolderView` „+“ menu.
- Produces:

```swift
@MainActor @Observable final class UploadCenter {
    static let shared: UploadCenter
    private(set) var entries: [UploadEntry]                         // refreshed on onChange + Darwin notification "tech.jensk.synclet.uploadsChanged"
    var activeCount: Int { get }; var failedCount: Int { get }
    func enqueue(urls: [URL], accountKey: String, parentId: String, parentName: String) async   // security-scoped access around enqueue
    func enqueue(photos: [PhotosPickerItem], accountKey: String, parentId: String, parentName: String) async
    func retry(_ id: String); func cancel(_ id: String) async; func removeFinished()
}
enum PhotoImport { static func export(_ item: PhotosPickerItem, asJPEG: Bool, to dir: URL) async throws -> URL }  // keeps original filename when known, else "Foto <yyyy-MM-dd HH.mm.ss>.<ext>"
struct ShareTarget: Codable, Equatable { var accountKey: String; var folderId: String; var folderName: String }   // last used, in app-group UserDefaults "shareLastTarget"
```

- Rules:
  - After every queue write, the Share extension posts the Darwin notification `tech.jensk.synclet.uploadsChanged`. The app listens and refreshes.
  - The Share extension:
    - loads the attachments (`NSItemProvider.loadFileRepresentation`), enqueues them while the provided URL is valid, then starts its own `BackgroundUploader` (identifier `tech.jensk.synclet.upload.share`), pumps and completes the request
    - pre-selects the last target if that account still exists; otherwise it uses the first account's „Meine Dateien“
    - with no account, shows „In der Synclet-App anmelden“ and only a „Schließen“ button
  - After sign-out, `UploadCenter` removes that account's entries (`queue.removeAll(accountKey:)`).
  - Every finished upload → `AppEnvironment.signalWorkingSet(accountKey)`; if that folder is visible, it reloads via `changeEvents`, or directly.
  - Failure texts (de/en) for `UploadFailure`:
    - `insufficientStorage` „Speicher voll“
    - `targetGone` „Zielordner gelöscht“
    - `signedOut` „Neu anmelden“
    - `tooLarge` „Datei zu groß“
    - `invalidName` „Ungültiger Name“
    - `network` „Keine Verbindung“
    - `sourceUnreadable` „Datei nicht lesbar“
    - `other` „Fehler“
  - Each row: name, „→ <parentName>“, progress (`Progress` from the uploader's `onChange`/task progress), „Erneut versuchen“/„Entfernen“ for failed, „Abbrechen“ for running.

- [ ] **Step 1: Write the failing tests:**

```swift
func testEnqueueURLsCopiesAndPumps() async { /* two temp files → queue has 2 waiting/uploading; uploader stub's pump called */ }
func testSignOutRemovesAccountUploads() async { /* entries for k1,k2 → signOut(k1) → only k2 */ }
func testFailedCountAndRetry() async { /* failed entry → failedCount 1 → retry → waiting, pump called */ }
func testFinishedUploadSignalsWorkingSet() async { /* onChange(done) → signalWorkingSet(accountKey) called once */ }
func testPhotoExportNaming() async throws { /* no filename → "Foto 2026-10-16 08.30.00.heic"; JPEG flag → .jpg */ }
func testShareTargetFallsBackWhenAccountGone() { /* stored target k_gone, accounts [k1] → k1 root "Meine Dateien" */ }
```

  `BackgroundUploader` is a final class, so for the pump/cancel tests put a tiny protocol `UploadDriving { func pump() async; func cancel(id: String) async }` in front of it inside the app. `UploadCenter` takes it as a dependency.
- [ ] **Step 2: Run the tests to verify they fail.** `bash scripts/ios-test.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests to verify they pass.**
  - `bash scripts/ios-test.sh` (iPhone and iPad) → `** TEST SUCCEEDED **`
  - `xcodebuild build -scheme SyncletShare -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` → BUILD SUCCEEDED
- [ ] **Step 5: Commit.** `git commit -m "feat(ios): photo/file uploads, uploads view and Share extension"`

---

### Task 10: Live/UI tests, device checklist, archive script, app icon

**Files:**
- Create: `scripts/ios-live-tests.sh`. Copy the structure of `scripts/macos-live-tests.sh`:
  - a throwaway compose project with a unique `-p synclet-ios-live-<pid>` and a free port
  - set up the admin via the setup API, then register a device token through the documented device registration
  - run:
    1. SyncletKit live tests (`swift test --filter Live`), with the same env vars as the macOS script
    2. `xcodebuild test -scheme Synclet -only-testing:SyncletUITests` on a private simulator, with `-SyncletTestServer`/`-SyncletTestToken` passed via the scheme's test-plan environment → launch arguments
  - remove only its own compose project and simulator on EXIT
  - `--serve` mode: start the stack and print URL + token, as on macOS
- Create: `apps/apple/SyncletKit/Tests/SyncletKitTests/LiveBackgroundUploadTests.swift` (skips without `SYNCLET_LIVE_URL`/token env, like the other Live tests)
- Create, in `apps/ios/SyncletUITests/`:
  - `BrowserFlowUITests.swift`
  - `UITestSupport.swift`
- Create: `apps/ios/build_archive.sh`, `apps/ios/ExportOptions.plist` (method `app-store-connect`, team `JC32M95WLZ`)
- Create: the app icon in `apps/ios/Synclet/Resources/Assets.xcassets/AppIcon.appiconset` (1024 px single-size), rendered from the macOS AppIcon source (`apps/macos/Synclet/Resources/Assets.xcassets/AppIcon.appiconset`, largest PNG, flattened onto an opaque background, since iOS icons must have no alpha)
- Modify: `apps/ios/README.md` (device checklist), `docs/superpowers/followups/2026-10-16-phase-3-followups.md` (create; record limitations and rulings)

**Interfaces:**
- Consumes: everything above. The UI tests address elements by accessibility identifiers. Add them where missing, in the T7–T9 views:
  - `browser.addMenu`, `browser.newFolder`, `browser.item.<name>`
  - `item.rename`, `item.delete`, `item.share`
  - `trash.restore.<name>`
  - `search.field`
  - `upload.files`
  - `uploads.row.<name>`

- [ ] **Step 1: Write the live upload test, `LiveBackgroundUploadTests`:**
  - real server, `BackgroundUploader` with an `.ephemeral` configuration (no background daemon in `swift test`)
  - a 40 MiB file → tus
  - kill the in-flight upload after the first PATCH (cancel the session task), build a new uploader instance on the same queue directory, `pump()` → it resumes via HEAD
  - the final server item's `sha256` equals the local file's; exactly one item with that name in the folder (no duplicate)
- [ ] **Step 2: Write `BrowserFlowUITests`.** It launches with the test args and runs one flow, asserting each step:
  1. „Meine Dateien“ visible
  2. new folder „UITest“
  3. open it
  4. upload a file via `fileImporter` — the simulator file importer can't be driven reliably. Instead, in DEBUG, the launch argument `-SyncletTestUpload <path>` enqueues that file into the current folder; T10 adds that hook to `UploadMenu` under `#if DEBUG`.
  5. wait for the row
  6. rename to „renamed.txt“
  7. delete
  8. open „Papierkorb“ and restore
  9. search for „renamed“ → hit
  10. „Link teilen“ → share sheet appears with an `https?://…/s/` URL. Read it from a DEBUG-only accessibility label on the share view.
- [ ] **Step 3: Run `bash scripts/ios-live-tests.sh`** → Kit live tests pass, UI tests pass (`** TEST SUCCEEDED **`), and the stack and simulator are removed. Docker must be running; if Docker Desktop is not running, start it with `open -a Docker` and wait. Never prune.
- [ ] **Step 4: Write `build_archive.sh`.**
  - Steps: `xcodegen generate`, then `xcodebuild archive -scheme Synclet -configuration Release -destination 'generic/platform=iOS' -archivePath build/Synclet.xcarchive -allowProvisioningUpdates`, then `xcodebuild -exportArchive -exportOptionsPlist ExportOptions.plist -exportPath build/export`.
  - Before archiving, check `security find-identity -v -p codesigning | grep -q "Apple Distribution"`. If missing, exit 2 with „Kein Apple-Distribution-Zertifikat – in Xcode → Settings → Accounts anlegen“.
  - Run it once: it either succeeds or stops with that message. Record which in the report.
- [ ] **Step 5: Write the device checklist** in `apps/ios/README.md`, numbered, each step with its expected result:
  - install via Xcode on a device
  - log in (browser) with 2 accounts
  - Files app shows both locations with „Meine Dateien“
  - open a file in Files
  - edit it in another app (e.g. Pages/Numbers or Markup) → the change reaches the web
  - edit the same file in the web and on the device offline → conflict copy
  - change a file in the web while the app is in the foreground → the browser updates within seconds
  - with the app in the background, the Files app shows the change on open
  - Share from Photos (3 photos) → arrives in the selected folder; lock the device during a 200 MB video upload → completes
  - 507 path (fill quota / disk) → „Speicher voll“ + retry
  - revoke the device in the web → „Neu anmelden“ in app and Files
  - sign out → the location disappears from Files
  - iPad: Split View layout, drag & drop from Files into the app is not in scope; note it
- [ ] **Step 6: Write the follow-ups file.** Record: no pinning; no APNs; background refresh timing is up to iOS; Files app and Share extension untested in automation (checklist); the archive-script result.
- [ ] **Step 7: Run everything.**
  - `swift test` (Kit, macOS)
  - `bash scripts/swiftkit-test-ios.sh`
  - `bash scripts/ios-test.sh` (iPhone + iPad)
  - macOS app `xcodebuild test`
  - server `pnpm --filter @synclet/server test`
  
  All must pass.
- [ ] **Step 8: Commit.** `git commit -m "test(ios): live + UI tests, device checklist, archive script, app icon"`
