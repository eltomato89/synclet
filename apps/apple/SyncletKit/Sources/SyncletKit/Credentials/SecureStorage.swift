import Foundation
import Security

/// Secret storage (keychain, or in-memory for tests).
/// Result of a lookup that tells "no entry" apart from "the keychain could not be read".
public enum SecureLookup: Sendable, Equatable {
    case found(String)
    case notFound
    /// Any other keychain status (locked, interaction not allowed, daemon hiccup …): transient.
    case failed(OSStatus)
}

public protocol SecureStorage: Sendable {
    func read(account: String) -> String?
    /// Like ``read(account:)``, but reports why nothing was returned.
    func lookup(account: String) -> SecureLookup
    /// Writes (replaces) the value; returns the keychain status (`errSecSuccess` on success).
    @discardableResult func write(_ value: String, account: String) -> OSStatus
    func remove(account: String)
}

public extension SecureStorage {
    func lookup(account: String) -> SecureLookup {
        read(account: account).map(SecureLookup.found) ?? .notFound
    }
}

/// Keychain storage (generic password) in the data protection keychain, with an
/// optional access group so app and File Provider extension see the same entries.
///
/// Readable after the first unlock (`AfterFirstUnlockThisDeviceOnly`) – the extension
/// also runs while the screen is locked; device tokens are bound to this device.
public struct KeychainStorage: SecureStorage {
    /// Service name of the entries.
    public let service: String
    /// Fully qualified access group (`<TeamID>.tech.jensk.synclet.shared`) or `nil`.
    public let accessGroup: String?

    public init(service: String, accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // macOS: the modern (iOS style) keychain, needed for access groups.
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup, !accessGroup.isEmpty {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    public func read(account: String) -> String? {
        if case .found(let value) = lookup(account: account) { return value }
        return nil
    }

    public func lookup(account: String) -> SecureLookup {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else { return .notFound }
            return .found(value)
        case errSecItemNotFound:
            return .notFound
        default:
            return .failed(status)
        }
    }

    @discardableResult
    public func write(_ value: String, account: String) -> OSStatus {
        // Update in place, so a reader never sees a gap and a failed write keeps the old value.
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery(account: account) as CFDictionary, attributes as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        var query = baseQuery(account: account)
        query.merge(attributes) { _, new in new }
        return SecItemAdd(query as CFDictionary, nil)
    }

    public func remove(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }
}

/// Volatile storage (tests, previews).
public final class InMemorySecureStorage: SecureStorage, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func read(account: String) -> String? {
        lock.withLock { values[account] }
    }

    @discardableResult
    public func write(_ value: String, account: String) -> OSStatus {
        lock.withLock { values[account] = value }
        return errSecSuccess
    }

    public func remove(account: String) {
        lock.withLock { values[account] = nil }
    }
}
