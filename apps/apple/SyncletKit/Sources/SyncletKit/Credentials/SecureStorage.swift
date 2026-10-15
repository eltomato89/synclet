import Foundation
import Security

/// Secret storage (keychain, or in-memory for tests).
public protocol SecureStorage: Sendable {
    func read(account: String) -> String?
    /// Writes (replaces) the value; returns the keychain status (`errSecSuccess` on success).
    @discardableResult func write(_ value: String, account: String) -> OSStatus
    func remove(account: String)
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
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public func write(_ value: String, account: String) -> OSStatus {
        remove(account: account)
        var query = baseQuery(account: account)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
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
