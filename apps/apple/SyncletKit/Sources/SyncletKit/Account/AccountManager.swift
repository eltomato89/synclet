import FileProvider
import Foundation

/// Control of the File Provider domains (replaceable in tests).
public protocol FileProviderDomainControlling: Sendable {
    func addDomain(identifier: String, displayName: String) async throws
    func removeDomain(identifier: String) async throws
    func domainIdentifiers() async throws -> [String]
    /// Lets the system re-enumerate a container (`.workingSet`, `.rootContainer`, …).
    func signalEnumerator(domainIdentifier: String, container: NSFileProviderItemIdentifier) async
}

/// Default: `NSFileProviderManager`.
public struct SystemFileProviderDomains: FileProviderDomainControlling {
    public init() {}

    private func domain(_ identifier: String, displayName: String = "") -> NSFileProviderDomain {
        NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(identifier), displayName: displayName)
    }

    public func addDomain(identifier: String, displayName: String) async throws {
        try await NSFileProviderManager.add(domain(identifier, displayName: displayName))
    }

    public func removeDomain(identifier: String) async throws {
        let existing = try await NSFileProviderManager.domains()
        guard let match = existing.first(where: { $0.identifier.rawValue == identifier }) else { return }
        try await NSFileProviderManager.remove(match)
    }

    public func domainIdentifiers() async throws -> [String] {
        try await NSFileProviderManager.domains().map(\.identifier.rawValue)
    }

    public func signalEnumerator(domainIdentifier: String, container: NSFileProviderItemIdentifier) async {
        guard let manager = NSFileProviderManager(for: domain(domainIdentifier)) else { return }
        try? await manager.signalEnumerator(for: container)
    }
}

/// Adds and removes Synclet accounts: device registration, token, metadata and the
/// File Provider domain (one per account). Shared by the macOS app and, later, iOS.
///
/// - Account key = `SyncAccount.organizationId` (`<serverId>:<userId>`).
/// - Domain identifier = ``AccountStore/key16(for:)`` of the key, display name
///   `Synclet – <username>@<host>`.
/// - Signing in again with the same key replaces the token and metadata and keeps the
///   existing domain (no second domain, no re-download of pinned content).
public final class AccountManager: Sendable {
    public let credentials: CredentialStore
    public let accounts: AccountStore
    private let domains: FileProviderDomainControlling
    private let session: URLSession
    private let deviceName: String
    private let installationID: @Sendable () async -> String?

    /// - Parameters:
    ///   - deviceName: name registered at the server (default: the computer name).
    ///   - installationID: hashed installation id (default: ``InstallationID/current()``).
    public init(credentials: CredentialStore, accounts: AccountStore,
                domains: FileProviderDomainControlling = SystemFileProviderDomains(),
                session: URLSession = .shared,
                deviceName: String = AccountManager.defaultDeviceName(),
                installationID: @escaping @Sendable () async -> String? = { await MainActor.run { InstallationID.current() } }) {
        self.credentials = credentials
        self.accounts = accounts
        self.domains = domains
        self.session = session
        self.deviceName = deviceName
        self.installationID = installationID
    }

    /// The computer name (macOS), else a generic name.
    public static func defaultDeviceName() -> String {
        #if os(macOS)
        if let name = Host.current().localizedName, !name.isEmpty { return name }
        return "Mac"
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }

    /// Registers this device with the login's access token, fetches `/account`, stores
    /// token and metadata (upsert by account key) and adds the domain unless it exists.
    /// Finally ends the login session (the refresh token is not needed any more).
    @discardableResult
    public func add(server: URL, tokens: AppTokens) async throws -> StoredAccount {
        let auth = AuthAPI(session: session)
        let registration = try await auth.registerDevice(server: server, accessToken: tokens.accessToken,
                                                         name: deviceName, installationId: await installationID())
        // The login session is not needed after the registration – end it whatever happens next.
        do {
            let stored = try await activate(registration: registration, server: server)
            await auth.endSession(server: server, refreshToken: tokens.refreshToken)
            return stored
        } catch {
            await auth.endSession(server: server, refreshToken: tokens.refreshToken)
            Log.account.error("adding the account failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    /// Second half of ``add(server:tokens:)``. If `addDomain` fails, token and metadata
    /// stay stored; ``restoreMissingDomains()`` (called at app start) adds the domain later.
    private func activate(registration: SyncDeviceRegistration, server: URL) async throws -> StoredAccount {
        let deviceClient = SyncAPIClient(baseURL: server, token: registration.token, session: session)
        // `/account` with the new device token (authoritative for `spaces`); the
        // registration's copy is the fallback.
        let account = (try? await deviceClient.account()) ?? registration.account
        let key = account.organizationId
        // Re-login of a known account: remember the previous device token to revoke it.
        let previousToken = credentials.token(for: key)
        let previousServer = accounts.account(key: key)?.serverURL ?? server

        // Every operation that started before this moment may still hold the previous token.
        let tokenStoredAt = Date()
        do {
            try credentials.save(token: registration.token, for: key)
        } catch {
            // Token cannot be stored ⇒ sign the device out again.
            try? await deviceClient.revokeCurrentDevice()
            throw error
        }

        // The new token is stored: sign the previous device out (best effort, bounded). The
        // server may already have revoked it (same installationId, §2.2) – that is fine.
        if let previousToken, previousToken != registration.token {
            let previousClient = SyncAPIClient(baseURL: previousServer, token: previousToken, session: session)
            await Self.bestEffort(timeout: .seconds(3)) { try? await previousClient.revokeCurrentDevice() }
        }

        let stored = try accounts.upsert(StoredAccount(
            key: key, serverURL: server, userId: account.userId, username: account.slug,
            displayName: account.displayName, spaces: account.spaces,
            deviceName: registration.device.name, deviceId: registration.device.id, email: account.email,
            signedInAt: tokenStoredAt))

        try await ensureDomain(stored)
        return stored
    }

    /// Stores an account whose device token was registered elsewhere (the iOS app's DEBUG
    /// test login with `-SyncletTestToken`): `GET /account` with the token, then token,
    /// metadata (upsert by account key) and the domain unless it exists. Nothing is
    /// registered or revoked; a rejected token stores nothing.
    @discardableResult
    public func addRegistered(server: URL, deviceToken: String) async throws -> StoredAccount {
        let account = try await SyncAPIClient(baseURL: server, token: deviceToken, session: session).account()
        let key = account.organizationId
        let tokenStoredAt = Date()
        try credentials.save(token: deviceToken, for: key)
        let stored = try accounts.upsert(StoredAccount(
            key: key, serverURL: server, userId: account.userId, username: account.slug,
            displayName: account.displayName, spaces: account.spaces, deviceName: deviceName,
            email: account.email, signedInAt: tokenStoredAt))
        try await ensureDomain(stored)
        return stored
    }

    /// Adds the account's domain unless the system already has it.
    private func ensureDomain(_ stored: StoredAccount) async throws {
        let existing = (try? await domains.domainIdentifiers()) ?? []
        if !existing.contains(stored.key16) {
            try await domains.addDomain(identifier: stored.key16, displayName: stored.domainDisplayName)
        }
    }

    /// Signs an account out: `DELETE /devices/current` (best effort, at most `timeout`),
    /// removes the domain, the token and the account's state directory (spaces, pins).
    public func remove(key: String, timeout: Duration = .seconds(3)) async {
        if let account = accounts.account(key: key), let token = credentials.token(for: key) {
            let client = SyncAPIClient(baseURL: account.serverURL, token: token, session: session)
            await Self.bestEffort(timeout: timeout) { try? await client.revokeCurrentDevice() }
        }
        try? await domains.removeDomain(identifier: AccountStore.key16(for: key))
        credentials.delete(for: key)
        try? accounts.remove(key: key)
    }

    /// Runs `operation`, giving up after `timeout`.
    private static func bestEffort(timeout: Duration, _ operation: @escaping @Sendable () async -> Void) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await operation() }
            group.addTask { try? await Task.sleep(for: timeout) }
            await group.next()
            group.cancelAll()
        }
    }

    /// The File Provider domain of an account.
    public func domain(for key: String) -> NSFileProviderDomain {
        let displayName = accounts.account(key: key)?.domainDisplayName ?? "Synclet"
        return NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(AccountStore.key16(for: key)),
                                    displayName: displayName)
    }

    /// API client of an account; reads the token from the keychain on every request.
    public func client(for key: String) -> SyncAPIClient? {
        guard let account = accounts.account(key: key) else { return nil }
        let credentials = credentials
        return SyncAPIClient(baseURL: account.serverURL, token: {
            guard let token = credentials.token(for: key) else { throw SyncAPIError.unauthorized(message: "no device token") }
            return token
        }, session: session)
    }

    /// Re-adds domains of stored accounts that the system lost. Returns the keys restored.
    @discardableResult
    public func restoreMissingDomains() async throws -> [String] {
        let existing = Set(try await domains.domainIdentifiers())
        var restored: [String] = []
        for account in accounts.all() where !existing.contains(account.key16) {
            try await domains.addDomain(identifier: account.key16, displayName: account.domainDisplayName)
            restored.append(account.key)
        }
        return restored
    }

    /// Updates the stored spaces of an account; returns `true` when they changed
    /// (the caller then signals the root container).
    @discardableResult
    public func updateSpaces(key: String, spaces: [SyncSpace]) throws -> Bool {
        guard var account = accounts.account(key: key), account.spaces != spaces else { return false }
        account.spaces = spaces
        try accounts.upsert(account)
        return true
    }

    /// `GET /account` with the device token and ``updateSpaces(key:spaces:)`` (SSE `account`,
    /// periodic refresh). Returns `true` when the spaces changed (the caller then signals the
    /// root container and the working set).
    @discardableResult
    public func refreshSpaces(key: String) async throws -> Bool {
        guard let client = client(for: key) else { throw SyncAPIError.unauthorized(message: "account removed") }
        let account = try await client.account()
        return try updateSpaces(key: key, spaces: account.spaces)
    }
}

#if os(iOS)
import UIKit

extension AccountManager {
    /// The device name shown in the web's device list ("Jens' iPhone"). The iOS app passes
    /// it into `init(deviceName:)`.
    @MainActor public static func iOSDeviceName() -> String {
        let name = UIDevice.current.name
        if !name.isEmpty { return name }
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }
}
#endif
