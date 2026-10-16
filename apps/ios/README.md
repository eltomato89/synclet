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

The UI tests have their own scheme (`SyncletUITests`).

## Debug sign-in without the browser

Debug builds accept a device token registered beforehand (UI tests, scripted checks):

```
-SyncletTestServer http://localhost:18140 -SyncletTestToken syd_…
```

Both arguments are required. Release builds do not contain this code path.
