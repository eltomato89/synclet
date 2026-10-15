# Synclet Phase 2 – macOS Sync Client, Spaces, SSE Events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native macOS client (menu bar app + File Provider extension) that mounts one or more Synclet accounts in Finder with on-demand files, a virtual top level of "spaces" ("Meine Dateien"), per-folder offline pinning, resumable large uploads, server thumbnails and near-instant remote changes via a new SSE endpoint.

**Architecture:**
- **Server:** additive changes only:
  - `spaces` in `GET /sync/v1/account`
  - `GET /sync/v1/events` (SSE, woken by Postgres `LISTEN/NOTIFY` after journal commits)
  - `507 insufficient_storage` on ENOSPC
- **Client:** a port of Buro's Apple stack:
  - `apps/apple/SyncletKit` — Swift package with the API client, models, keychain, account manager and File Provider logic, reusable by iOS later
  - `apps/macos` — XcodeGen project with the `Synclet` menu bar app and the `SyncletFileProvider` extension
- **Wake-up path:** the menu bar app holds one SSE stream per account and calls `signalEnumerator`; the extension pulls `/changes`.

**Tech Stack (additions):**
- Swift 6 with swift-tools 6.2, SwiftUI `MenuBarExtra`, FileProvider (`NSFileProviderReplicatedExtension`), `ASWebAuthenticationSession`, `SMAppService`, `Network` (`NWPathMonitor`), Security (data-protection keychain), `os.Logger`, XCTest
- XcodeGen (`/opt/homebrew/bin/xcodegen`); Xcode 27 is installed
- Server: `pg` LISTEN connection (a dedicated client, not Prisma)

**Spec:** `docs/superpowers/specs/2026-10-15-phase-2-macos-client-design.md` (binding), main spec `docs/superpowers/specs/2026-10-15-synclet-design.md` §4.

**Buro reference (copy, then adapt; never import):**
- `/Volumes/Daten/Privat/SaaS/BuroApp/buro/apps/apple-shared/BuroFileProviderKit` with:
  - `API/SyncAPIClient.swift`, `API/SyncAPIError.swift`
  - `Models/SyncModels.swift`
  - `FileProvider/{BuroReplicatedExtension, FileProviderEnumerator, FileProviderItem, ItemMapping, ErrorMapping, ConflictNaming}.swift`
  - `Credentials/{CredentialStore, SecureStorage}.swift`
  - `Account/{SyncAccountManager, InstallationID}.swift`
  - its `Tests/`
- `/Volumes/Daten/Privat/SaaS/BuroApp/buro/apps/macos-app` with:
  - `project.yml`
  - `BuroMac/{App, Core, Views}`
  - `BuroMacFileProvider/FileProviderExtension.swift`
  - `Shared/AuthFailureSignal.swift`
  - `BuroMacTests`
  - `build_and_notarize.sh`, `dmg/`, `README.md`

**Contracts:**
- Synclet `docs/sync/SYNC_API.md` (authoritative for every endpoint the client calls)
- `packages/sync-contract/openapi.yaml`

**User decisions (2026-10-15):**
- Changes arrive via SSE plus polling fallback; no APNs.
- Pinning is configured inside the app: per space, the whole space or individual first-level folders.
- Signing: Team `JC32M95WLZ`, bundle IDs `tech.jensk.synclet.*`.
- macOS only; Windows becomes Phase 2b.
- Minimum macOS 26.
- tus uploads above 32 MiB.
- Multiple accounts.
- Virtual top level made of server-provided spaces: Phase 2 has only `personal` = "Meine Dateien".

## Global Constraints

**Server:**
- Everything from the Phase 1 Global Constraints holds:
  - English code, de+en UI strings
  - mutations under `journal.lockUser` + `TX_OPTS`
  - `/data` holds only user content
  - server tests: `cd apps/server && TEST_DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet_test_2_tN pnpm test`
  - never `migrate reset`
  - `test/schema-drift.spec.ts` green
- Server changes are **additive**. No existing response field, route or status code changes meaning. The Phase 1c contract suite must stay green.

**Git:**
- Branch `phase-2` (stacked on `phase-1c`, PR #2 open). Task branches are `phase2/task-N` in worktrees `/Volumes/Daten/Privat/Synclet-wt/2-tN`, merged by the controller.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012XgXSgUMDR71rtNA64nYDi
  ```

**Apple identifiers (exact):**

| What | Value |
|---|---|
| Team | `JC32M95WLZ` |
| App bundle ID | `tech.jensk.synclet.mac` |
| Extension bundle ID | `tech.jensk.synclet.mac.fileprovider` |
| App group | `$(TeamIdentifierPrefix)group.tech.jensk.synclet` |
| Keychain access group | `$(AppIdentifierPrefix)tech.jensk.synclet.shared` |
| Keychain service | `tech.jensk.synclet.sync` |
| URL scheme | `synclet` (redirect `synclet://oauth`) |
| OAuth client_id | `macos` |
| Logger subsystem | `tech.jensk.synclet` |
| Product / display name | "Synclet" |
| Domain display name | `Synclet – <username>@<host>` |
| Deployment target | macOS 26.0 |
| Swift language mode | 6 |
| Marketing version | 0.1.0 |

**Apple code rules:**
- Info.plist keys use the `Synclet` prefix instead of `Buro` (`SyncletAppGroup`, `SyncletKeychainAccessGroup`).
- No Buro names or strings remain. `grep -ri buro apps/apple apps/macos` must be empty, except in comments that credit the origin, which go only in `apps/apple/SyncletKit/README.md`.
- Removed Buro concepts must not reappear:
  - tenants/subdomains/organizations UI, `/auth/organizations`, `/auth/switch`, base domain, "Arbeitsbereich"/"Firmenkürzel"
  - customers/projects area rules, link items `l_…`
  - feature flag `files.storage`
  - PushKit/APNs, `aps-environment`
- Account key = `SyncAccount.organizationId` (`<serverId>:<userId>`). Per-account state lives in the app group under `accounts/<sha256(accountKey) hex prefix 16>/`. Sync state (cursor, pins) is stored **per space**.
- **Tests:**
  - SwiftPM tests: `cd apps/apple/SyncletKit && swift test`
  - App tests: `cd apps/macos && xcodegen generate && xcodebuild test -scheme Synclet -destination 'platform=macOS'`
  - Live tests are opt-in via env `SYNCLET_LIVE_URL` / `SYNCLET_LIVE_USER` / `SYNCLET_LIVE_PASSWORD` and skipped otherwise.
- The generated `Synclet.xcodeproj` is committed (like Buro), regenerated whenever `project.yml` changes.
- `apps/macos/build/` and `apps/macos/DerivedData/` are git-ignored.
- **Machine safety (unchanged from Phase 1c):** never run machine-wide destructive cleanup (`pkill`/`killall` by pattern, docker prune, `rm -rf ~/Library/...` of anything you did not create). File Provider domains you add during manual tests must be removed again: `NSFileProviderManager.remove`, or the app's sign-out.

## Review Focus

1. **Writes into the virtual top level.**
   - Creating, moving or renaming anything into or out of the root container or a space folder in Finder must fail cleanly with a File Provider error. It must never create a stray item on the server or lose the user's file.
   - Moving an item between two folders of the same space works.
   - Tests in Task 3 (mapping and capabilities) and Task 4 (extension handlers).
2. **Interrupted large uploads.**
   - Wi-Fi drops mid-tus, the Mac sleeps, the extension is killed, the local file changes before resume, or the server answers 404/410 for an expired upload.
   - Expected: resume from the server offset, or restart cleanly. Never produce a corrupted file on the server, never a duplicate "(2)". A replace keeps the base ETag, so a concurrent web edit yields a conflict copy.
   - Tests in Task 5.
3. **SSE stream lifecycle.**
   - Server: no notification for rolled-back transactions; streams of a revoked device or disabled user end; 10-stream cap; burst coalescing.
   - Client: reconnect with backoff, no busy loop when the server returns 401/404/HTML from a misconfigured proxy, fallback polling while disconnected.
   - Tests in Task 2 (server) and Task 6 (client).
4. **Pinning edge cases.**
   - Pinned folder renamed: the pin survives, because it is keyed by item id.
   - Pinned folder deleted remotely: the pin is dropped.
   - New file appears remotely inside a pinned folder: it is downloaded without user action.
   - Unpinning stops keeping new files but does not evict files the user marked "Keep downloaded" in Finder.
   - Two accounts with a folder of the same name: the pins stay independent.
   - Tests in Task 7.
5. **Account identity and sign-out.**
   - Signing in twice to the same server/user replaces the account and does not create a second domain.
   - Two servers with the same username are two accounts.
   - Sign-out with pending local changes warns first.
   - A revoked device token shows "Anmeldung erforderlich", and re-login reuses the domain without re-downloading pinned content.
   - Tests in Task 4.

---

## Parallel execution waves (max 5 concurrent subagents)

| Wave | Tasks | Depends on |
|---|---|---|
| 0 | T1 Server spaces + 507 · T2 Server SSE events · T3 SyncletKit core port | – |
| 1 | T4 macOS app + extension (login, accounts, virtual top level, file ops) · T5 Transfers (tus upload, resumable download, progress) | T3 (T4 live check needs T1) |
| 2 | T6 Live changes (EventStream + app wake-up loop) · T7 Offline pinning · T8 Thumbnails + menu bar status/errors | T4 (T6←T2, T5 merged before T8) |
| 3 | T9 Live tests, E2E checklist, notarized DMG, README | all |

Swift files in `apps/macos/project.yml` are touched by T4, T6, T7, T8. Each later task adds only its own files and source groups; the controller resolves `project.yml` conflicts and regenerates the project.

---

### Task 1: Server – spaces in the account + 507 on full disk

**Files:**
- Modify:
  - `packages/shared/src/` (the `SyncAccount` type, new `SyncSpace`)
  - `apps/server/src/sync/sync.controller.ts` (`account()`)
  - `docs/sync/SYNC_API.md` (§3 + error table + new §"Insufficient storage")
  - `packages/sync-contract/openapi.yaml`
  - the contract suite (`packages/sync-contract/test/…account…`)
  - `apps/server/src/common/` (error mapping)
  - the write paths that can hit ENOSPC: `files/files.service.ts` (upload/replace/copy/restore/office save commit), `uploads/tus.ts` (publish), `trash/trash.service.ts` (restore copy), `versions/versions.service.ts` (prepare/restore)
- Test: `apps/server/src/sync/sync.e2e.spec.ts`, `apps/server/src/common/storage-errors.spec.ts` (new), `apps/server/src/files/files.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type SyncSpaceKind = 'personal' | 'shared' | 'external';
  interface SyncSpace { id: string; kind: SyncSpaceKind; name: string; rootId: string; canWrite: boolean }
  SyncAccount.spaces: SyncSpace[]   // Phase 2: [{ id: 'personal', kind: 'personal', name: 'Meine Dateien', rootId: 'root', canWrite: true }]
  ```
  - `name` is taken from the server's UI default language. There is none server-side, so it is always "Meine Dateien". Clients localize by `kind`.
- Produces: `class InsufficientStorageError extends SyncError` → HTTP `507`, body `{ code: 'insufficient_storage', message }`.
  - Helper `rethrowStorageError(err: unknown): never` maps `err.code === 'ENOSPC' || err.code === 'EDQUOT'` to `InsufficientStorageError`; anything else is rethrown unchanged.
  - Every write path wraps its filesystem write/rename/copy in a try that calls the helper **after** its existing temp-file cleanup.
- Docs: §3 adds the `SyncSpace` shape and the rules from spec §1.1:
  - the virtual top level is client-side and read-only
  - unknown `kind` → show as an ordinary folder
  - clients store state per space
  - `areas` stays for Buro compatibility

  The error table adds `507 insufficient_storage` (retry later, show to the user).

- [ ] Write failing tests:
  - `GET /sync/v1/account` returns exactly the one personal space with `rootId: 'root'`, and all old fields are unchanged.
  - A unit test injects `{ code: 'ENOSPC' }` from a mocked `fs.promises.rename` / `copyFile` in the upload commit and in the replace → `507 insufficient_storage`, with no temp file left in the target folder and no DB row/journal change.
  - `EIO` still → 500.
  - A tus publish with ENOSPC → 507 and the upload stays resumable (the part is not deleted).
- [ ] Implement; extend the contract suite (account has `spaces`, each with string `id`/`name`/`rootId`, `kind` in the enum) and the OpenAPI schema; run `pnpm lint:openapi`.
- [ ] Run the full server suite; commit `feat(sync): spaces in account, 507 on full disk`.

---

### Task 2: Server – SSE change events

**Files:**
- Create: `apps/server/src/events/{events.module.ts, events.controller.ts, change-notifier.ts, events.e2e.spec.ts, change-notifier.spec.ts}`
- Modify:
  - `apps/server/src/journal/` (the journal append path → `pg_notify` inside the transaction)
  - `app.module.ts`
  - `apps/server/src/config.ts` (`SYNCLET_EVENTS_PING_SECONDS`, default 25, test override)
  - `deploy/Caddyfile` (`/api/sync/v1/events`: `flush_interval -1`, exclude from `encode`)
  - `README.md` (outer proxies: read timeout > 25 s; NPM works by default)
  - `docs/sync/SYNC_API.md` (new §"Events")
  - `packages/sync-contract` (openapi + conformance test)

**Interfaces:**
- Journal: wherever a `FileChange` row is inserted (the single append helper used by API and indexer), also run
  ```sql
  SELECT pg_notify('synclet_changes', $userId)
  ```
  on the same transaction client. Postgres delivers it only on commit, and a rolled-back transaction delivers nothing.
- `ChangeNotifier`:
  - one dedicated `pg.Client` per process (connection string = `DATABASE_URL`), `LISTEN synclet_changes`
  - reconnect with backoff 1–30 s; on reconnect, emit a synthetic wake-up to all open streams, because events may have been missed
  - `subscribe(userId, cb: () => void): () => void` (unsubscribe)
  - coalescing: at most one callback per user per 250 ms (trailing edge)
  - server role only, not the worker
- `GET /api/sync/v1/events`:
  - `@UseGuards(AuthGuard)`: device token **or** web access token
  - response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; write via the raw Fastify reply (`reply.hijack()`)
  - **Stream lifecycle:**
    1. On open: `event: hello\ndata: {"cursor":"<current>"}\n\n`.
    2. On a notifier callback: read the current cursor and send `event: changes\ndata: {"space":"personal","cursor":"<cursor>"}\n\n`.
    3. Every `pingSeconds`: `: ping\n\n`. Before each ping, re-validate the token (device not revoked, user enabled, session not revoked); if invalid, end the stream.
    4. On client disconnect: unsubscribe and clear timers.
  - Limit: 10 open streams per user. Opening the 11th closes the oldest with `event: bye\ndata: {"reason":"too_many_streams"}`.
  - Rate limit: the existing per-user bucket, at most 30 opens per minute (429 otherwise).
- **Docs §Events:** format, the event types `hello`/`changes`/`bye`, ping, the "wake-up only, always pull `/changes`" rule, reconnect guidance (exponential backoff 1–60 s, honour `retry:` if sent), and the proxy notes.

- [ ] Write failing tests:
  - Unit (`ChangeNotifier`): coalescing (5 notifies within 100 ms → 1 callback); unsubscribe; reconnect emits wake-up.
  - E2E against a real listen socket (`app.listen(0)`, Node `http.get`, parse the stream):
    - `hello` arrives with a cursor equal to `/account`'s.
    - Creating a folder via the API yields `changes` within 3 s with the new cursor.
    - A transaction that inserts a FileChange and rolls back yields no event within 1 s.
    - With `SYNCLET_EVENTS_PING_SECONDS=1`, a ping arrives.
    - Revoking the device ends the stream after the next ping.
    - 11 streams → the first gets `bye`.
    - Another user's change → no event.
    - No token → 401.
- [ ] Implement.
- [ ] Contract test: hello, then a change via the API → `changes` within 3 s. Run against the dev stack per the existing suite rules.
- [ ] Verify Caddy: `caddy adapt` in a throwaway container (remove it by exact name).
- [ ] If the e2e stack is used, `curl -N` through Caddy shows events unbuffered.
- [ ] Run the full server suite; commit `feat(events): SSE change notifications`.

---

### Task 3: SyncletKit core port

**Files:**
- Create `apps/apple/SyncletKit/` (`Package.swift`, swift-tools 6.2, platforms `.macOS("26.0")`, `.iOS("26.0")`, library `SyncletKit`, test target `SyncletKitTests`), with:
  - `Sources/SyncletKit/API/{SyncAPIClient.swift, SyncAPIError.swift, AuthAPI.swift}`
  - `Sources/SyncletKit/Models/SyncModels.swift`
  - `Sources/SyncletKit/FileProvider/{SyncletReplicatedExtension.swift, FileProviderEnumerator.swift, FileProviderItem.swift, ItemMapping.swift, ErrorMapping.swift, ConflictNaming.swift, SpaceLayout.swift}`
  - `Sources/SyncletKit/Credentials/{CredentialStore.swift, SecureStorage.swift}`
  - `Sources/SyncletKit/Account/{AccountManager.swift, AccountStore.swift, InstallationID.swift, ServerURL.swift}`
  - `Tests/SyncletKitTests/*` (ported + new)
  - `README.md` (origin credit, layout, how to test)
- Copy the Buro files listed in the header, then adapt.

**Interfaces (Produces, used by T4–T8):**
- `ServerURL.normalize(_ input: String) throws -> URL`
  - adds `https://` when no scheme is given, strips the path/query/trailing slash
  - accepts `http://` only for `localhost`, `127.0.0.1` and private IPs (dev)
  - throws `ServerURLError.invalid`
- `SyncAPIClient(baseURL: URL, token: @Sendable () async throws -> String, session: URLSession = .shared)`:
  - API base = `<origin>/api`
  - every call from Buro's client, re-pointed to Synclet paths per `SYNC_API.md`: account, capabilities, children, item, changes(cursor), download (Range), upload (new file), replace (If-Match, `X-Synclet-Modified-At`), createFolder, move/rename (If-Match), delete, thumbnail URL, devices register/delete-current
  - `SyncAPIError` maps every `code` in `SYNC_API.md` (incl. `cursor_expired` 410, `conflict` 412, `precondition_required` 428, `too_large` 413, `insufficient_storage` 507, `rate_limited` 429 with `Retry-After`)
- `AuthAPI`:
  - `exchangeCode(server: URL, code: String, verifier: String) async throws -> AppTokens` (`POST /api/auth/app/token`, client_id `macos`, redirect `synclet://oauth`)
  - `registerDevice(server:accessToken:name:platform:installationId:) async throws -> DeviceRegistration` (`POST /api/sync/v1/devices`, returns `syd_…`)
  - `PKCE.make() -> (verifier: String, challenge: String, state: String)`
- Models: `SyncAccount` incl. `spaces: [SyncSpace]`; `SyncSpace { id, kind: SyncSpaceKind (.personal, .shared, .external, .unknown(String)), name, rootId, canWrite }`; `SyncItem`, `ChangesPage`.
  - Decoding tolerates unknown fields and unknown `kind`.
  - If `spaces` is absent (older server), synthesize `[personal → root]`.
- `SpaceLayout` — pure, unit-tested:
  - `static func identifier(for space: SyncSpace) -> NSFileProviderItemIdentifier` → `"space:<id>"`
  - `static func spaceID(from identifier:) -> String?`
  - `func providerParent(forServerParentId: String) -> NSFileProviderItemIdentifier`: a space's `rootId` maps to that space's identifier; everything else passes through unchanged
  - `func serverParentId(for providerParent: NSFileProviderItemIdentifier) throws -> String`: the root container → `throws .readOnlyTopLevel`; a space id → its `rootId`; else unchanged
  - `func topLevelItems() -> [FileProviderItem]`: folders, localized display name by kind (personal: "Meine Dateien"/"My Files" via `String(localized:)`), capabilities `[.allowsReading, .allowsContentEnumerating]` only, no writing/renaming/reparenting/deleting
- `ItemMapping`: Buro's mapping with area/link/customer/project branches removed; capabilities from `SyncItem.capabilities`; parent via `SpaceLayout`.
- `CredentialStore(service: "tech.jensk.synclet.sync", accessGroup: String)`: `save(token:for accountKey:)`, `token(for:)`, `delete(for:)` (data-protection keychain).
- `AccountStore(appGroup: String)`:
  - JSON per account at `accounts/<key16>/account.json` (`StoredAccount { key, serverURL, userId, username, displayName, spaces, addedAt }`)
  - `all()`, `upsert(_:)`, `remove(key:)`
  - per-space state dir `accounts/<key16>/spaces/<spaceId>/`
- `AccountManager`:
  - `add(server:tokens:) async throws -> StoredAccount`: register the device, fetch `/account`, upsert by `organizationId` (same key → replace token, keep the domain), add or keep the `NSFileProviderDomain(identifier: key16, displayName: "Synclet – <username>@<host>")`
  - `remove(key:) async`: best-effort `DELETE /devices/current`, remove the domain, delete the token, the state dir and the pins
  - `domain(for key:)`
- `ConflictNaming.name(original: String, device: String, date: Date) -> String` → `"<base> (Konflikt <device> <yyyy-MM-dd HH-mm>).<ext>"`. The Buro rule, with tests for no extension, multiple dots and dotfiles.
- `SyncletReplicatedExtension`: Buro's `BuroReplicatedExtension` adapted:
  - enumerator for the root container → `SpaceLayout.topLevelItems()`
  - working-set and container enumerators pull `/changes` per space; cursor stored per space; 410 → full re-enumeration
  - `createItem`/`modifyItem`/`deleteItem` with conflict copies per spec §2.7
  - writes into the root container or a space container itself are rejected (`NSFileProviderError(.cannotSynchronize)` for create/reparent-into-root, `NSCocoaErrorDomain NSFeatureUnsupportedError` for rename/delete of space folders; use whatever Buro's ErrorMapping uses for read-only)
  - Upload/download use the simple paths here; T5 swaps in `TransferEngine`.

**Steps:**
- [ ] Copy the Buro kit and tests; rename symbols (`Buro*` → `Synclet*`).
- [ ] Delete tenant/area/link/push code; fix the build (`swift build`).
- [ ] Port and adapt the Buro tests, then add new tests (failing first):
  - `SpaceLayout`: round trip; root writes throw; personal localized; unknown kind uses the server name
  - `ServerURL.normalize`: 10 cases incl. `synclet.dw83.de`, `http://localhost:8080/`, `ftp://x` (throws), `http://8.8.8.8` (throws)
  - `SyncModels`: decoding the real JSON of a Phase-1c server `/account` without `spaces` → personal synthesized; with an unknown kind
  - `SyncAPIClient` against a `URLProtocol` stub: paths, headers (`Authorization`, `If-Match`, `X-Synclet-Modified-At`), error mapping for 410/412/413/429/507
  - `ConflictNaming`
  - `AccountStore` upsert-by-key
- [ ] `swift test` green; `grep -ri buro apps/apple` → only the README credit line.
- [ ] Commit `feat(apple): SyncletKit core ported from Buro`.

---

### Task 4: macOS app + File Provider extension

**Files:**
- Create `apps/macos/`:
  - `project.yml` (XcodeGen; targets `Synclet` app, `SyncletFileProvider` app-extension, `SyncletTests`; local package `../apple/SyncletKit`)
  - `Synclet/App/{SyncletApp.swift, AppDelegate.swift}`
  - `Synclet/Core/{BrowserLogin.swift, LoginModel.swift, AccountsModel.swift, SystemIntegration.swift}`
  - `Synclet/Views/{MenuView.swift, LoginView.swift, SettingsView.swift, AccountsSettingsView.swift}`
  - `Synclet/Resources/{Assets.xcassets, Localizable.xcstrings}`
  - `Synclet/Synclet.entitlements`
  - `SyncletFileProvider/{FileProviderExtension.swift, Info.plist, SyncletFileProvider.entitlements}`
  - `Shared/AuthFailureSignal.swift`
  - `SyncletTests/*`
  - `.gitignore`
  - the generated `Synclet.xcodeproj`
- Port from Buro `apps/macos-app` and strip the removed concepts.

**Interfaces:**
- Consumes: everything T3 produces.
- **Entitlements:**
  - app: app group, keychain group, `com.apple.security.network.client` not needed (unsandboxed)
  - extension: `com.apple.security.app-sandbox`, `network.client`, app group, keychain group
  - Info.plist of both: `SyncletAppGroup`, `SyncletKeychainAccessGroup`
  - The app registers the URL scheme `synclet`.
- **Login flow** (`LoginModel`):
  1. Server field → `ServerURL.normalize` → `GET /api/health` (expect 200 JSON) → `GET /api/sync/v1/capabilities` (200, or 404 = older Synclet); anything else → "Kein Synclet-Server unter <host>".
  2. `PKCE.make` → `ASWebAuthenticationSession(url: <server>/app-login?client_id=macos&redirect_uri=synclet://oauth&code_challenge=…&code_challenge_method=S256&state=…, callbackURLScheme: "synclet")`.
  3. Verify `state` → `AuthAPI.exchangeCode` → `AccountManager.add`.
  4. Errors → inline messages (de/en).
- **`AuthFailureSignal`:** the extension writes `accounts/<key16>/auth-failed` and posts the Darwin notification `tech.jensk.synclet.authFailed`. The app observes it and marks the account "Anmeldung erforderlich". Re-login of that account clears it and reuses the domain.
- **`SystemIntegration`:**
  - `SMAppService.mainApp` register/unregister (Settings toggle "Bei Anmeldung starten", default on after the first account)
  - `NSFileProviderManager(for:)?.getUserVisibleURL(for: .rootContainer)` → "Im Finder öffnen"
  - "Web öffnen" → `serverURL`
- **Menu (minimal here; T8 extends it):** per account a name and state (OK / Anmeldung erforderlich); items "Im Finder öffnen", "Web öffnen", "Konto hinzufügen…", "Einstellungen…", "Beenden".
- **Settings/Accounts:**
  - list, add, sign out
  - Sign out warns when `NSFileProviderManager.getPendingItems` / the domain has pending uploads (use the manager's pending enumeration; if not determinable, always warn "Nicht hochgeladene Änderungen gehen verloren").
- `FileProviderExtension: SyncletReplicatedExtension`: reads the account key from `domain.identifier`, token via `CredentialStore`.

**Steps:**
- [ ] Unit tests (`SyncletTests`), failing first:
  - `LoginModel` with a stubbed `AuthAPI`/`URLProtocol`: non-Synclet server; state mismatch; success upserts
  - `AccountsModel`: same key twice → one account, token replaced; two hosts with the same username → two accounts
  - auth-failure signal round trip via a temp app-group dir
- [ ] Implement; `xcodegen generate`; `xcodebuild build` and `test` with signing (automatic, team JC32M95WLZ).
- [ ] Manual check against the local dev stack (`scripts/e2e-fresh.sh`-style compose, or `deploy/compose.dev.yml` + server):
  - sign in, Finder shows "Synclet – <user>@<host>" → "Meine Dateien" → files
  - create/rename/move/delete in Finder reflect on the server
  - dropping a file directly into the root fails cleanly
  - Write the observed results into the report. Sign out at the end (the domain is removed).
- [ ] Commit `feat(macos): menu bar app and File Provider extension`.

---

### Task 5: Transfers – tus uploads, resumable downloads, progress

**Files:**
- Create in SyncletKit:
  - `Sources/SyncletKit/Transfer/{TusUploader.swift, TransferEngine.swift, UploadStateStore.swift, RangeDownloader.swift}`
  - `Tests/SyncletKitTests/{TusUploaderTests.swift, TransferEngineTests.swift, RangeDownloaderTests.swift}`
- Modify: `SyncletReplicatedExtension` (use `TransferEngine` in create/modify/fetchContents).

**Interfaces:**
- `TransferEngine(api: SyncAPIClient, tus: TusUploader, stateDir: URL, threshold: Int = 32 << 20)`:
  - `upload(file: URL, newIn parentId: String, name: String, modifiedAt: Date, progress: Progress) async throws -> SyncItem`
  - `replace(file: URL, itemId: String, baseEtag: String, modifiedAt: Date, progress: Progress) async throws -> SyncItem`
  - At or below the threshold: the single-request API calls. Above: tus.
- `TusUploader`, tus 1.0 per `SYNC_API.md` §7:
  - `create(length:metadata:)`: `POST /api/sync/v1/uploads`, metadata `name`, `parentId`, and for replace `itemId` + `ifMatch` (exact keys per §7)
  - `patch(chunk 16 MiB)`, `head` for the offset, `terminate`
  - The final PATCH response carries the `SyncItem` per §7. If not, fetch the item per §7's documented way.
- `UploadStateStore`:
  - JSON per pending upload, key = `sha256(itemIdentifier + contentVersion)`, value `{ uploadURL, length, fileSize, fileMtime, target, baseEtag, createdAt }`
  - entries older than 24 h are dropped (the server expires them)
- **Resume rules:**
  - State exists and the local file's size/mtime are unchanged → `HEAD` → continue from `Upload-Offset`.
  - `HEAD` 404/410 → delete the state and restart from 0.
  - File changed → `terminate` (best effort) and restart.
  - `423` → retry after 2 s, up to 5 times.
  - `412` on finish of a replace → conflict path (T3's conflict copy).
- `RangeDownloader`: streams `GET content` into a temp file in the extension's container, resumes with `Range: bytes=<have>-` and `If-Range: <etag>` after network errors (3 attempts); a 200 instead of 206 → restart.
- `Progress.totalUnitCount` = file size, updated per chunk.

**Steps:**
- [ ] Tests (failing first) with a `URLProtocol` fake tus server (in-memory offsets; inject failures):
  - 100 MiB synthetic file: create + 7 patches
  - failure after chunk 3 → new engine instance resumes at 48 MiB (assert the server received each byte range once)
  - HEAD 404 → restart
  - local file changed between attempts → terminate + restart
  - 423 retry
  - replace with a stale etag → conflict error surfaced
  - exactly 32 MiB → single request; 32 MiB + 1 → tus
  - 0-byte file → single request
  - Range download resume and the 200-instead-of-206 restart
- [ ] Implement; wire into the extension.
- [ ] `swift test` and `xcodebuild test` green.
- [ ] Manual check: upload 200 MB, toggle Wi-Fi off/on mid-way → completes, and the server sha256 equals the local one. Record it in the report.
- [ ] Commit `feat(apple): resumable transfers`.

---

### Task 6: Live changes – EventStream + wake-up loop

**Files:**
- Create:
  - SyncletKit `Sources/SyncletKit/Events/{SSEParser.swift, EventStream.swift}` + tests
  - `apps/macos/Synclet/Core/ChangeMonitor.swift` + `SyncletTests/ChangeMonitorTests.swift`
- Modify: `AccountsModel` (start/stop monitors per account), `project.yml`.

**Interfaces:**
- `SSEParser`: incremental, pure; `mutating func feed(_ bytes: Data) -> [SSEEvent]`, `SSEEvent { event: String; data: String; id: String?; retry: Int? }`. Handles CRLF/LF, multi-line `data:`, comments (`:`), missing trailing newline across chunks, BOM.
- `EventStream(url: URL, token: @Sendable () async throws -> String, session: URLSession)`:
  - `func events() -> AsyncThrowingStream<StreamSignal, Error>`
  - `StreamSignal = .connected(cursor: String) | .changes(space: String, cursor: String) | .disconnected(reason)`
  - uses `URLSession.bytes(for:)`
  - **Reconnect:** exponential backoff 1, 2, 4 … 60 s with ±20 % jitter, reset after 60 s of healthy connection; honours `retry:`.
  - **Non-retryable responses:** non-`text/event-stream` content type, or 404 → treat as "server has no events" and back off at 60 s without logging spam.
  - **401/403:** stop, raise the auth-failure signal.
- `ChangeMonitor(account:)`, owned by `AccountsModel`, one per account:
  - runs the stream
  - on `.connected` or `.changes`: `NSFileProviderManager(for: domain).signalEnumerator(for: .workingSet)` (coalesced: at most one per 500 ms)
  - while disconnected: a 60 s timer signals the working set
  - `NWPathMonitor` path becomes satisfied, or `NSWorkspace.didWakeNotification` → restart the stream immediately and signal
  - also re-fetches `/account` on each `.connected` and every 15 min; if `spaces` changed, update `AccountStore` and signal `.rootContainer`
  - exposes `@Observable` state `connected | connecting | offline | authFailed` and `lastSync: Date?` for the menu (T8)

**Steps:**
- [ ] Tests (failing first):
  - `SSEParser` table: ≥ 12 cases incl. a split in the middle of `data:` and in the middle of a CRLF
  - `EventStream` with a `URLProtocol` stub streaming chunks: hello→connected; changes→changes; stream end → reconnect with the backoff (inject a clock/sleeper)
  - 404/HTML → slow backoff; 401 → stop + auth signal
  - `ChangeMonitor` with a fake manager/signaler: coalescing; the fallback timer only while disconnected; a spaces change signals the root
- [ ] Implement.
- [ ] Manual check: with the app running, create a file in the web UI → Finder shows it in ≤ 3 s; stop the server → the menu shows offline; start it → reconnects. Record it in the report.
- [ ] Commit `feat(macos): live changes via SSE`.

---

### Task 7: Offline pinning

**Files:**
- Create:
  - SyncletKit `Sources/SyncletKit/Pinning/{PinStore.swift, PinPolicy.swift}` + tests
  - `apps/macos/Synclet/Views/PinningSettingsView.swift`
  - `apps/macos/Synclet/Core/PinningModel.swift` + tests
- Modify: `FileProviderItem`/`ItemMapping` (contentPolicy), the extension enumerators (ancestor tracking), `SettingsView` (a new "Offline" tab), `project.yml`.

**Interfaces:**
- `PinStore(stateDir:)`, per account and space:
  - `pins(space:) -> PinSet { wholeSpace: Bool; folders: Set<String> /* first-level item ids */ }`
  - `setWholeSpace(_:space:)`, `setFolder(_:pinned:space:)`, `prune(existingFirstLevel: Set<String>, space:)`
  - The file lives under the space state dir. Writes are atomic.
  - Posts the Darwin notification `tech.jensk.synclet.pinsChanged.<key16>` on change.
- `PinPolicy.contentPolicy(for item: SyncItem, firstLevelAncestor: String?, space: String, pins: PinSet) -> NSFileProviderContentPolicy`:
  - `.downloadEagerlyAndKeepDownloaded` if `pins.wholeSpace` or `firstLevelAncestor ∈ pins.folders`
  - else `.inherited`
- **First-level ancestor:** the extension keeps a small parent map (`itemId → parentId`, SQLite or JSON in the space state dir, updated on every enumeration/change) to resolve the ancestor directly below the space root. Unknown → resolve via `GET /items/:id` walking parents, at most 64 hops, then cache.
- **Step 1 is a probe** that decides between two strategies:
  - **A:** setting `.downloadEagerlyAndKeepDownloaded` only on the first-level folder makes macOS 26 download new and existing descendants.
  - **B:** it doesn't, so every descendant needs the policy explicitly.

  The probe: a pinned folder with 3 levels of files, a new remote file added afterwards. Record the result in the report and the ledger.
  - Strategy A → set it on the pinned folder items only (and on the space item for `wholeSpace`).
  - Strategy B → set it per item via `PinPolicy`.

  Both keep `PinPolicy` as the single decision point. If neither downloads new files, add `NSFileProviderManager.requestDownloadForItem` calls from the app on each `changes` signal for new items under pinned folders (enumerate the working-set changes through the manager).
- **On a pin change:** the app signals the affected container identifiers (or `.workingSet`) so the extension re-reports items with the new policy.
  - Unpin: only the policy goes back to `.inherited`. Files the user explicitly kept (Finder "Keep Downloaded") are not touched, because the user's own pin state is independent.
- **UI:** "Offline" settings tab with per account → per space:
  - toggle "Ganzer Bereich offline"
  - list of first-level folders (`GET children` of `rootId`, folders only, sorted) with toggles
  - size hint "≈ <bytes>" from the folder size when known
  - the stored-offline total in the footer

**Steps:**
- [ ] The probe (above) with the T4 app on the dev stack; record which strategy.
- [ ] Tests (failing first):
  - `PinStore` round trip, prune, independence across accounts/spaces
  - `PinPolicy` table: whole space; folder pinned; nested descendant; other folder; renamed folder keeps the id
  - parent map ancestor resolution incl. a move into/out of a pinned folder
  - `PinningModel`: toggles write the store and post the notification
- [ ] Implement.
- [ ] Manual check: pin "Fotos" → all files inside are downloaded (Finder shows no cloud icon); add a file in the web UI → it is downloaded automatically; unpin → no new downloads; whole-space pin. Record in the report.
- [ ] Commit `feat(macos): offline pinning`.

---

### Task 8: Thumbnails + menu bar status and errors

**Files:**
- Create:
  - SyncletKit `Sources/SyncletKit/FileProvider/Thumbnails.swift` + tests
  - `apps/macos/Synclet/Core/ErrorLog.swift`
  - `apps/macos/Synclet/Views/{AccountStatusView.swift, ErrorListView.swift}`
- Modify: the extension (conform to `NSFileProviderThumbnailing`), `MenuView`, `ErrorMapping` (record user-visible errors), `project.yml`.

**Interfaces:**
- `fetchThumbnails(for identifiers:, requestedSize:, perThumbnailCompletionHandler:, completionHandler:)`:
  - for file items, `GET /api/sync/v1/items/:id/thumbnail?size=<256|1024>` (the size bucket nearest to the requested size, per `SYNC_API.md` §9.1)
  - 404/415 → nil, no error
  - cache: `Caches/thumbnails/<itemId>-<etag>-<size>.webp` inside the extension container, LRU 200 MB
  - folders and the space/root items → nil
- `ErrorLog`, in the app group as JSON lines, keeping the last 20:
  - entry `{ date, accountKey, fileName, message (de/en), code }`
  - the extension appends on non-transient failures: 413 too_large, 507 insufficient_storage, invalid name, permission, conflict copy created (as info)
  - the app reads it on a Darwin notification
- **Menu:**
  - per account: status from `ChangeMonitor` (Verbunden · Synchronisiert vor <rel> / Offline / Anmeldung erforderlich (button "Erneut anmelden") / Fehler)
  - "Im Finder öffnen", "Web öffnen"
  - section "Letzte Probleme" (the last 20, each opens Finder at the file if it still exists)
  - "Konto hinzufügen…", "Einstellungen…", "Beenden"
  - the menu bar icon shows a badge on auth failure or a recent error
- de+en strings in `Localizable.xcstrings`.

**Steps:**
- [ ] Tests (failing first):
  - thumbnail size bucketing; cache hit by etag; 404 → nil
  - `ErrorLog` cap 20, concurrent appends (file lock), malformed line skipped
  - menu state derivation from monitor states (pure view model)
- [ ] Implement.
- [ ] Manual check: Finder icon view shows server thumbnails for unhydrated images/PDFs; a 413 shows in the menu. Record in the report.
- [ ] Commit `feat(macos): thumbnails and status menu`.

---

### Task 9: Live tests, E2E checklist, notarized DMG, docs

**Files:**
- Create:
  - `apps/apple/SyncletKit/Tests/SyncletKitTests/LiveAPITests.swift` (opt-in env)
  - `apps/macos/build_and_notarize.sh`, `apps/macos/dmg/` (background, volume icon)
  - `apps/macos/README.md` (build, signing, notary profile setup `xcrun notarytool store-credentials synclet-notary`, the manual E2E checklist from spec §3, known limitations)
- Modify:
  - `README.md` (a "macOS client" section)
  - `scripts/` (a helper `scripts/macos-live-tests.sh` that starts a throwaway stack like `e2e-fresh.sh`, creates a test user via the setup API, runs `swift test` with the live env, and tears down only its own project)
  - `docs/superpowers/followups/` (Phase 2 follow-ups at the end)

**Requirements:**
- **LiveAPITests:** sign in via the password app-login path (the test user, the `/api/auth/app/*` flow with PKCE using the same HTTP calls the web page makes), register a device, then:
  - `/account` has the personal space
  - upload small and tus 40 MiB → sha matches
  - replace with a stale etag → 412 and the conflict path names a copy
  - SSE hello + changes after an API change within 3 s
  - thumbnail for a PNG
  - sign out revokes the device (the next call → 401)
- **`build_and_notarize.sh`:**
  - `xcodegen generate`, `xcodebuild archive` (Release), export with Developer ID (`ExportOptions.plist` method `developer-id`, team JC32M95WLZ)
  - `notarytool submit --keychain-profile synclet-notary --wait`, `stapler staple`
  - DMG via `hdiutil` with the background image and an Applications link
  - output `apps/macos/build/Synclet-<version>.dmg`
  - The script fails clearly when the notary profile is missing.
- **Run:**
  - `scripts/macos-live-tests.sh` → green
  - `build_and_notarize.sh`, if the notary profile exists on this Mac; otherwise run up to export and report that notarization needs the profile
  - the full server suite, `swift test`, `xcodebuild test`
- [ ] Implement, run, record results; commit `chore(macos): live tests, DMG build, docs`.
