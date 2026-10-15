import CryptoKit
import Foundation
import os

/// Metadata of a signed-in account, stored as JSON in the app group
/// (`accounts/<key16>/account.json`). The device token lives in the ``CredentialStore``.
public struct StoredAccount: Codable, Sendable, Hashable, Identifiable {
    /// Account key = `SyncAccount.organizationId` (`<serverId>:<userId>`).
    public var key: String
    /// Server origin.
    public var serverURL: URL
    public var userId: String
    /// `SyncAccount.slug`.
    public var username: String
    public var displayName: String
    /// Spaces in display order (refreshed by the app).
    public var spaces: [SyncSpace]
    public var addedAt: Date
    /// Name of this device at the server (also used for conflict copies).
    public var deviceName: String?
    public var deviceId: String?
    public var email: String?

    public init(key: String, serverURL: URL, userId: String, username: String, displayName: String,
                spaces: [SyncSpace], addedAt: Date = Date(), deviceName: String? = nil,
                deviceId: String? = nil, email: String? = nil) {
        self.key = key
        self.serverURL = serverURL
        self.userId = userId
        self.username = username
        self.displayName = displayName
        self.spaces = spaces
        self.addedAt = addedAt
        self.deviceName = deviceName
        self.deviceId = deviceId
        self.email = email
    }

    public var id: String { key }

    /// Directory name and File Provider domain identifier (see ``AccountStore/key16(for:)``).
    public var key16: String { AccountStore.key16(for: key) }

    /// `Synclet – <username>@<host>`.
    public var domainDisplayName: String {
        "Synclet – \(username)@\(ServerURL.displayHost(serverURL))"
    }

    private enum CodingKeys: String, CodingKey {
        case key, serverURL, userId, username, displayName, spaces, addedAt, deviceName, deviceId, email
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        serverURL = try c.decode(URL.self, forKey: .serverURL)
        userId = try c.decode(String.self, forKey: .userId)
        username = try c.decode(String.self, forKey: .username)
        displayName = try c.decode(String.self, forKey: .displayName)
        spaces = try c.decodeIfPresent([SyncSpace].self, forKey: .spaces) ?? [.personal()]
        addedAt = try c.decodeIfPresent(Date.self, forKey: .addedAt) ?? Date(timeIntervalSince1970: 0)
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName)
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
        email = try c.decodeIfPresent(String.self, forKey: .email)
    }
}

/// Sync state of one space (informational; the File Provider anchor is authoritative).
public struct SpaceSyncState: Codable, Sendable, Hashable {
    /// Last change cursor the extension reported to the system.
    public var cursor: String
    public var updatedAt: Date

    public init(cursor: String, updatedAt: Date = Date()) {
        self.cursor = cursor
        self.updatedAt = updatedAt
    }
}

/// Account metadata and per-space state in the app group container:
///
/// ```
/// accounts/<key16>/account.json
/// accounts/<key16>/spaces/<spaceId>/        (cursor state, pins, upload state …)
/// ```
///
/// `<key16>` = the first 16 hex characters of `sha256(accountKey)`.
public final class AccountStore: Sendable {
    /// Root of the shared container (parent of `accounts/`).
    public let directory: URL

    /// The app group container (`FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`).
    /// Falls back to `Application Support/tech.jensk.synclet` when the group is not available
    /// (unsigned builds, tests).
    public convenience init(appGroup: String) {
        if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            self.init(directory: container)
        } else {
            // App and extension would no longer share state – a signing/entitlement problem.
            Log.account.fault("app group \(appGroup, privacy: .public) unavailable; falling back to Application Support")
            self.init(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "tech.jensk.synclet", directoryHint: .isDirectory))
        }
    }

    /// Any directory (tests).
    public init(directory: URL) {
        self.directory = directory
    }

    /// `sha256(accountKey)` as hex, first 16 characters.
    public static func key16(for accountKey: String) -> String {
        SHA256.hash(data: Data(accountKey.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    private var accountsDirectory: URL { directory.appending(path: "accounts", directoryHint: .isDirectory) }

    /// `accounts/<key16>/`.
    public func accountDirectory(key: String) -> URL {
        accountDirectory(key16: Self.key16(for: key))
    }

    public func accountDirectory(key16: String) -> URL {
        accountsDirectory.appending(path: key16, directoryHint: .isDirectory)
    }

    private func accountFile(key16: String) -> URL {
        accountDirectory(key16: key16).appending(path: "account.json", directoryHint: .notDirectory)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    // MARK: Accounts

    /// All stored accounts, oldest first.
    public func all() -> [StoredAccount] {
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: accountsDirectory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        return entries
            .compactMap { account(key16: $0.lastPathComponent) }
            .sorted { ($0.addedAt, $0.key) < ($1.addedAt, $1.key) }
    }

    /// The account with this account key.
    public func account(key: String) -> StoredAccount? {
        account(key16: Self.key16(for: key)).flatMap { $0.key == key ? $0 : nil }
    }

    /// The account of a File Provider domain (identifier = key16).
    public func account(key16: String) -> StoredAccount? {
        guard let data = try? Data(contentsOf: accountFile(key16: key16)) else { return nil }
        return try? Self.decoder().decode(StoredAccount.self, from: data)
    }

    /// Inserts or replaces the account with the same key. A replaced account keeps its
    /// `addedAt` and its state directory (spaces, pins).
    @discardableResult
    public func upsert(_ account: StoredAccount) throws -> StoredAccount {
        var stored = account
        // Whole seconds: the JSON stores ISO 8601 without fractions.
        stored.addedAt = Date(timeIntervalSince1970: account.addedAt.timeIntervalSince1970.rounded(.down))
        if let existing = self.account(key: account.key) {
            stored.addedAt = existing.addedAt
        }
        let directory = accountDirectory(key: account.key)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.encoder.encode(stored).write(to: accountFile(key16: stored.key16), options: .atomic)
        return stored
    }

    /// Removes the account and its whole state directory (spaces, pins, upload state).
    public func remove(key: String) throws {
        let directory = accountDirectory(key: key)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.removeItem(at: directory)
    }

    // MARK: Per-space state

    /// `accounts/<key16>/spaces/<spaceId>/`, created on demand.
    public func spaceStateDirectory(key: String, spaceId: String) throws -> URL {
        let url = accountDirectory(key: key)
            .appending(path: "spaces", directoryHint: .isDirectory)
            .appending(path: Self.safeComponent(spaceId), directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Stores the last cursor of a space (`spaces/<spaceId>/sync-state.json`).
    public func saveSyncState(_ state: SpaceSyncState, key: String, spaceId: String) throws {
        let file = try spaceStateDirectory(key: key, spaceId: spaceId).appending(path: "sync-state.json")
        try Self.encoder.encode(state).write(to: file, options: .atomic)
    }

    public func syncState(key: String, spaceId: String) -> SpaceSyncState? {
        guard let directory = try? spaceStateDirectory(key: key, spaceId: spaceId),
              let data = try? Data(contentsOf: directory.appending(path: "sync-state.json")) else { return nil }
        return try? Self.decoder().decode(SpaceSyncState.self, from: data)
    }

    /// A file system safe directory name for a space id.
    static func safeComponent(_ id: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_")
        let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
        return encoded.isEmpty ? "_" : encoded
    }
}
