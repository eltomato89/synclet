// swift-tools-version: 6.2
import PackageDescription

// Portable core of the native Synclet clients (macOS menu bar app + File Provider
// extension now, iOS later): models and client of the Sync API v1
// (docs/sync/SYNC_API.md), shared credentials, account management and the
// NSFileProviderReplicatedExtension base class.
let package = Package(
    name: "SyncletKit",
    defaultLocalization: "en",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "SyncletKit", targets: ["SyncletKit"]),
    ],
    targets: [
        .target(
            name: "SyncletKit",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "SyncletKitTests",
            dependencies: ["SyncletKit"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
