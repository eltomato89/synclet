import FileProvider
import Foundation
import Observation
import os
import SyncletKit

/// State of an account in the account list.
enum AccountStatus: Equatable, Sendable {
    case ok
    /// The server rejected the device token (or none is stored) ⇒ „Neu anmelden“ (keeps the domain).
    case signInRequired

    var label: String {
        switch self {
        case .ok: return String(localized: "Signed in")
        case .signInRequired: return String(localized: "Sign-in required")
        }
    }
}

/// An account of the app.
struct AccountEntry: Identifiable, Equatable, Sendable {
    var account: StoredAccount
    var status: AccountStatus

    var id: String { account.key }
    /// `<username>@<host[:port]>`.
    var title: String { "\(account.username)@\(ServerURL.displayHost(account.serverURL))" }
}

/// Lifting the system's throttling of failed File Provider operations (replaceable in tests).
protocol FileProviderResolving: Sendable {
    /// After a new sign-in: `.notAuthenticated` resolved, working set signalled.
    func resolveAuthentication(domain: NSFileProviderDomain) async
    /// The server is reachable again: `.serverUnreachable` and `.insufficientQuota` resolved.
    func resolveTransientErrors(domain: NSFileProviderDomain) async
}

struct SystemFileProviderResolver: FileProviderResolving {
    func resolveAuthentication(domain: NSFileProviderDomain) async {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        do {
            try await manager.signalErrorResolved(NSFileProviderError(.notAuthenticated))
        } catch {
            Logger.app.error("signalErrorResolved failed: \(String(describing: error), privacy: .public)")
        }
        try? await manager.signalEnumerator(for: .workingSet)
    }

    func resolveTransientErrors(domain: NSFileProviderDomain) async {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        for code in [NSFileProviderError.Code.serverUnreachable, .insufficientQuota] {
            do {
                try await manager.signalErrorResolved(NSFileProviderError(code))
            } catch {
                Logger.app.error("signalErrorResolved(\(code.rawValue, privacy: .public)) failed: \(String(describing: error), privacy: .public)")
            }
        }
    }
}

/// Accounts, their status, the selected account and the foreground monitors.
@MainActor
@Observable
final class AccountsModel {
    /// `UserDefaults` key of ``selectedKey``.
    static let selectedAccountKey = "selectedAccount"

    private(set) var entries: [AccountEntry] = []
    /// The account the browser shows; persisted. Always one of ``entries`` (or `nil` without accounts).
    var selectedKey: String? {
        didSet {
            guard selectedKey != oldValue else { return }
            defaults.set(selectedKey, forKey: Self.selectedAccountKey)
        }
    }
    /// One monitor per signed-in account while the app is active (empty in the background).
    private(set) var monitors: [String: ForegroundMonitor] = [:]

    @ObservationIgnored let manager: AccountManager
    @ObservationIgnored let resolver: FileProviderResolving
    @ObservationIgnored private let defaults: UserDefaults
    /// Builds an account's monitor; set by ``startMonitoring(factory:)``, `nil` in the background.
    @ObservationIgnored private var makeMonitor: ((StoredAccount) -> ForegroundMonitor)?
    @ObservationIgnored private var subscribers: [UUID: AsyncStream<String>.Continuation] = [:]

    init(manager: AccountManager, resolver: FileProviderResolving = SystemFileProviderResolver(),
         defaults: UserDefaults = .standard) {
        self.manager = manager
        self.resolver = resolver
        self.defaults = defaults
        selectedKey = defaults.string(forKey: Self.selectedAccountKey)
        reload()
    }

    /// Root of the app group container (parent of `accounts/`), where the extension's signals live.
    var container: URL { manager.accounts.directory }

    func entry(key: String) -> AccountEntry? { entries.first { $0.id == key } }

    var selectedEntry: AccountEntry? { selectedKey.flatMap(entry(key:)) }

    // MARK: - List

    /// Reads the accounts and the extension's auth-failure markers; keeps the selection valid.
    func reload() {
        entries = manager.accounts.all().map { account in
            let failed = AuthFailureSignal.pending(container: container, key16: account.key16) != nil
            // Only a missing token asks for a sign-in; a keychain read error is transient.
            let missingToken = manager.credentials.lookupToken(for: account.key) == .notFound
            return AccountEntry(account: account, status: failed || missingToken ? .signInRequired : .ok)
        }
        if selectedKey.flatMap(entry(key:)) == nil {
            selectedKey = entries.first?.id
        }
        syncMonitors()
    }

    /// Darwin notification of the extension (or scene activation): re-read the markers.
    func processAuthFailures() {
        reload()
    }

    // MARK: - Add / sign out

    /// Adds (or replaces) the account of a finished browser login and selects it. Signing in
    /// again clears the auth-failure marker and keeps the domain.
    @discardableResult
    func add(server: URL, tokens: AppTokens) async throws -> StoredAccount {
        let stored = try await manager.add(server: server, tokens: tokens)
        await didSignIn(stored)
        return stored
    }

    /// Shared tail of every sign-in (also the DEBUG test login).
    func didSignIn(_ stored: StoredAccount) async {
        AuthFailureSignal.clear(container: container, key16: stored.key16)
        let existingMonitor = monitors[stored.key]
        reload()
        selectedKey = stored.key
        // A monitor from before the sign-in reconnects with the new token (also out of `.authFailed`).
        existingMonitor?.restart()
        // Let the system retry what failed while the token was rejected.
        await resolver.resolveAuthentication(domain: manager.domain(for: stored.key))
    }

    /// Signs out: revokes the device (best effort), removes the domain, token and state. The
    /// selection moves to the next account in the list (the previous one for the last).
    func signOut(key: String) async {
        let key16 = AccountStore.key16(for: key)
        let wasSelected = selectedKey == key
        let index = entries.firstIndex { $0.id == key }
        monitors[key]?.stop()
        monitors[key] = nil
        await manager.remove(key: key)
        AuthFailureSignal.clear(container: container, key16: key16)
        if wasSelected { selectedKey = nil }
        reload()
        if wasSelected, let index, !entries.isEmpty {
            selectedKey = entries[min(index, entries.count - 1)].id
        }
    }

    // MARK: - Foreground monitors

    /// App active: one ``ForegroundMonitor`` per signed-in account (tests pass a factory).
    func startMonitoring(factory: ((StoredAccount) -> ForegroundMonitor)? = nil) {
        makeMonitor = factory ?? { [weak self, manager, resolver] account in
            ForegroundMonitor.live(account: account, manager: manager, resolver: resolver) {
                self?.processAuthFailures()
            }
        }
        syncMonitors()
    }

    /// App in the background: all streams and polling stop.
    func stopMonitoring() {
        for monitor in monitors.values { monitor.stop() }
        monitors = [:]
        makeMonitor = nil
    }

    /// New accounts get a monitor, removed ones lose theirs, accounts that need a sign-in
    /// suspend. Leaving `.authFailed` is explicit (``didSignIn(_:)``), so a rejected token
    /// never reconnects in a loop.
    private func syncMonitors() {
        guard let makeMonitor else { return }
        let keys = Set(entries.map(\.id))
        for (key, monitor) in monitors where !keys.contains(key) {
            monitor.stop()
            monitors[key] = nil
        }
        for entry in entries {
            let monitor: ForegroundMonitor
            if let existing = monitors[entry.id] {
                monitor = existing
            } else {
                monitor = makeMonitor(entry.account)
                monitor.onChange = { [weak self] key in self?.publishChange(key) }
                monitors[entry.id] = monitor
                if entry.status == .ok { monitor.start() }
            }
            if entry.status == .signInRequired, monitor.state != .authFailed {
                monitor.suspendForSignIn()
            }
        }
    }

    // MARK: - Change events

    /// The account key each time a monitor sees a change. Every access returns a new
    /// subscriber; each one receives every change (broadcast).
    var changeEvents: AsyncStream<String> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: String.self, bufferingPolicy: .bufferingNewest(16))
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.subscribers[id] = nil }
        }
        subscribers[id] = continuation
        return stream
    }

    /// Number of live ``changeEvents`` subscribers (tests).
    var subscriberCount: Int { subscribers.count }

    private func publishChange(_ key: String) {
        for continuation in subscribers.values { continuation.yield(key) }
    }
}
