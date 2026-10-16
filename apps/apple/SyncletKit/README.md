# SyncletKit

Portable core of the native Synclet clients: the macOS menu bar app and File Provider
extension (`apps/macos`, Phase 2) and later iOS (Phase 3).

Implements the Synclet Sync API (`docs/sync/SYNC_API.md`).

## Layout

```
Sources/SyncletKit/
  API/           SyncAPIClient (Sync API v1 below <origin>/api/sync/v1), SyncAPIError,
                 AuthAPI (PKCE browser login, code exchange, device registration)
  Models/        SyncModels: SyncItem, SyncAccount (+ spaces), SyncSpace, changes, devices, tokens
  FileProvider/  SyncletReplicatedExtension (base class of the extension), FileProviderEnumerator,
                 TopLevelEnumerator, FileProviderItem, SpaceLayout (virtual top level),
                 ItemMapping, ErrorMapping, ConflictNaming
  Transfer/      TransferEngine (≤ 32 MiB single request – POST upload / PUT replace; above tus,
                 replace with itemId + ifMatch),
                 TusUploader (tus 1.0, 16 MiB chunks), UploadStateStore (resume state),
                 RangeDownloader (streamed, resumable downloads)
  Pinning/       PinStore (offline pins per account/space), PinPolicy (content policy decision),
                 ParentMap (folder → parent, first-level ancestor), PinResolver (policy per item,
                 PinWorkQueue: persistent, bounded re-reports), PinningState (flock,
                 PinnedContentLedger, PinnedDownloadQueue for the app)
  Credentials/   CredentialStore (device tokens in the shared keychain), SecureStorage
  Account/       AccountManager (add/remove accounts and domains), AccountStore (JSON in the
                 app group), InstallationID, ServerURL
  Resources/     en + de strings
Tests/SyncletKitTests/   XCTest suite with a URLProtocol stub (no server needed)
```

Key rules:

- Account key = `SyncAccount.organizationId` (`<serverId>:<userId>`); File Provider domain
  identifier and state directory = the first 16 hex characters of `sha256(accountKey)`.
- App group layout: `accounts/<key16>/account.json`, per-space state in
  `accounts/<key16>/spaces/<spaceId>/`.
- The root container lists one read-only folder per space (`space:<id>`); a space folder shows
  the children of the space's `rootId`. Server ids below stay unchanged.
- Unfinished tus uploads are remembered in `accounts/<key16>/uploads/<sha256(item + content version)>.json`
  (dropped after 24 h, like on the server).
- The extension reads `SyncletAppGroup` and `SyncletKeychainAccessGroup` from its Info.plist.

## Testing

```bash
cd apps/apple/SyncletKit && swift test
```

Live transfer checks (200 MB tus upload and 100 MB tus replace, optionally interrupted) run against a real server:
`SYNCLET_LIVE_URL=… SYNCLET_LIVE_USER=… SYNCLET_LIVE_PASSWORD=… SYNCLET_LIVE_INTERRUPT='docker restart <container>' swift test --filter LiveTransferTests`.

The iOS build can be checked with
`xcodebuild -scheme SyncletKit -destination 'generic/platform=iOS Simulator' build`.
