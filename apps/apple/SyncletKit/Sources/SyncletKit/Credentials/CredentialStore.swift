import Foundation
import Security

/// Group identifiers shared by app and extension. They are not hard-coded but read
/// from the Info.plist of each target (resolved at build time).
public struct SharedConfiguration: Sendable, Hashable {
    /// Info.plist key of the app group (`$(TeamIdentifierPrefix)group.tech.jensk.synclet`).
    public static let appGroupInfoKey = "SyncletAppGroup"
    /// Info.plist key of the keychain access group (`$(AppIdentifierPrefix)tech.jensk.synclet.shared`).
    public static let keychainAccessGroupInfoKey = "SyncletKeychainAccessGroup"

    /// App group for the shared container (`nil` ⇒ not configured).
    public var appGroup: String?
    /// Keychain access group (`nil` ⇒ the process's default group).
    public var keychainAccessGroup: String?

    public init(appGroup: String?, keychainAccessGroup: String?) {
        self.appGroup = appGroup
        self.keychainAccessGroup = keychainAccessGroup
    }

    /// Reads both identifiers from the bundle's Info.plist (empty or unresolved ⇒ `nil`).
    public static func fromInfoPlist(_ bundle: Bundle = .main) -> SharedConfiguration {
        func value(_ key: String) -> String? {
            guard let text = bundle.object(forInfoDictionaryKey: key) as? String,
                  !text.isEmpty, !text.hasPrefix("$(") else { return nil }
            return text
        }
        return SharedConfiguration(appGroup: value(appGroupInfoKey),
                                   keychainAccessGroup: value(keychainAccessGroupInfoKey))
    }
}

/// Error when storing a token.
public enum CredentialStoreError: Error, Sendable, Equatable {
    /// Keychain status of the failed write.
    case saveFailed(OSStatus)
}

/// Device tokens per account, in the shared keychain (service `tech.jensk.synclet.sync`,
/// account = account key `<serverId>:<userId>`). Nothing else lives here – the account
/// metadata is in the ``AccountStore``.
public final class CredentialStore: Sendable {
    /// Keychain service of the device tokens.
    public static let defaultService = "tech.jensk.synclet.sync"

    private let storage: SecureStorage

    /// Production: data protection keychain with the shared access group.
    public convenience init(service: String = CredentialStore.defaultService, accessGroup: String?) {
        self.init(storage: KeychainStorage(service: service, accessGroup: accessGroup))
    }

    /// From the Info.plist configuration.
    public convenience init(configuration: SharedConfiguration) {
        self.init(accessGroup: configuration.keychainAccessGroup)
    }

    /// Any storage (tests: ``InMemorySecureStorage``).
    public init(storage: SecureStorage) {
        self.storage = storage
    }

    /// Stores (replaces) the device token of an account.
    public func save(token: String, for accountKey: String) throws {
        let status = storage.write(token, account: accountKey)
        guard status == errSecSuccess else { throw CredentialStoreError.saveFailed(status) }
    }

    /// The device token of an account, if any.
    public func token(for accountKey: String) -> String? {
        storage.read(account: accountKey)
    }

    /// The device token, or why there is none: ``SecureLookup/notFound`` means signed out,
    /// ``SecureLookup/failed(_:)`` a transient keychain error (retry, do not ask for a sign-in).
    public func lookupToken(for accountKey: String) -> SecureLookup {
        storage.lookup(account: accountKey)
    }

    /// Deletes the device token of an account.
    public func delete(for accountKey: String) {
        storage.remove(account: accountKey)
    }
}
