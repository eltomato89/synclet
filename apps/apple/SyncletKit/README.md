# SyncletKit

Portable core of the native Synclet clients: the macOS menu bar app and File Provider
extension (`apps/macos`, Phase 2) and later iOS (Phase 3).

Origin: ported from Buro's `BuroFileProviderKit` (`buro/apps/apple-shared/BuroFileProviderKit`) and adapted to the Synclet Sync API (`docs/sync/SYNC_API.md`, §13 lists the differences).

## Layout

```
Sources/SyncletKit/
  API/           SyncAPIClient (Sync API v1 below <origin>/api/sync/v1), SyncAPIError,
                 AuthAPI (PKCE browser login, code exchange, device registration)
  Models/        SyncModels: SyncItem, SyncAccount (+ spaces), SyncSpace, changes, devices, tokens
  FileProvider/  SyncletReplicatedExtension (base class of the extension), FileProviderEnumerator,
                 TopLevelEnumerator, FileProviderItem, SpaceLayout (virtual top level),
                 ItemMapping, ErrorMapping, ConflictNaming
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
- The extension reads `SyncletAppGroup` and `SyncletKeychainAccessGroup` from its Info.plist.

## Testing

```bash
cd apps/apple/SyncletKit && swift test
```

The iOS build can be checked with
`xcodebuild -scheme SyncletKit -destination 'generic/platform=iOS Simulator' build`.
