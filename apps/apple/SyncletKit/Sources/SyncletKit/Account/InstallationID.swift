import CryptoKit
import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import IOKit
#endif

/// Stable, anonymized identifier of this installation for `POST /devices`
/// (`installationId`). On a new login the server replaces the old device entry with
/// it instead of adding another one.
///
/// - iOS: `identifierForVendor` (survives updates and new logins).
/// - macOS: hardware UUID (`IOPlatformUUID`), survives reinstalls too.
///
/// Only a SHA-256 hash is sent, never the raw id.
public enum InstallationID {
    @MainActor
    public static func current() -> String? {
        guard let raw = rawIdentifier(), !raw.isEmpty else { return nil }
        return hashed(raw)
    }

    /// Hash with a fixed prefix (testable without a device id).
    public static func hashed(_ raw: String) -> String {
        let digest = SHA256.hash(data: Data("synclet-sync-installation:\(raw)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    @MainActor
    private static func rawIdentifier() -> String? {
        #if os(iOS)
        return UIDevice.current.identifierForVendor?.uuidString
        #elseif os(macOS)
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)
        return value?.takeRetainedValue() as? String
        #else
        return nil
        #endif
    }
}
