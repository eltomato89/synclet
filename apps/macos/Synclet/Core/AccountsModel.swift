import AppKit
import FileProvider
import Foundation
import Observation
import os
import SyncletKit

/// State of an account in the menu (T6/T8 add connection and sync states).
enum AccountStatus: Equatable, Sendable {
    case ok
    /// The extension reported a rejected device token ⇒ sign in again (keeps the domain).
    case needsLogin

    var label: String {
        switch self {
        case .ok: return String(localized: "OK")
        case .needsLogin: return String(localized: "Sign-in required")
        }
    }
}

/// An account in the menu and the settings.
struct AccountEntry: Identifiable, Equatable, Sendable {
    var account: StoredAccount
    var status: AccountStatus

    var id: String { account.key }
    /// `<username>@<host[:port]>`.
    var title: String { "\(account.username)@\(ServerURL.displayHost(account.serverURL))" }
}

/// What a sign-out would lose (for the confirmation).
enum PendingChanges: Equatable, Sendable {
    case none
    case some(Int)
    /// The pending set could not be read – always warn.
    case unknown
}

/// Accounts, their status and the actions of the menu bar app.
@MainActor
@Observable
final class AccountsModel {
    private(set) var entries: [AccountEntry] = []
    /// Last error of an action (open in Finder …), shown by the app.
    var lastActionError: String?
    /// Live-change monitor per account key (connection state and last sync for the menu).
    /// Empty until ``startMonitoring(factory:)``.
    private(set) var monitors: [String: ChangeMonitor] = [:]
    /// Builds an account's monitor; set by ``startMonitoring(factory:)``.
    @ObservationIgnored private var makeMonitor: ((StoredAccount) -> ChangeMonitor)?

    @ObservationIgnored let manager: AccountManager
    @ObservationIgnored let finder: FinderIntegrating
    @ObservationIgnored var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// Called once an account was added and the list was empty before (login item default).
    @ObservationIgnored var onFirstAccountAdded: () -> Void = {}
    /// Connection state for accounts without a running ``ChangeMonitor`` (which takes precedence).
    @ObservationIgnored var statusProvider: (AccountEntry) -> any AccountStatusProviding = { FallbackAccountStatus(entry: $0) }

    init(manager: AccountManager, finder: FinderIntegrating = SystemFinderIntegration()) {
        self.manager = manager
        self.finder = finder
        reload()
    }

    var isEmpty: Bool { entries.isEmpty }
    var hasProblem: Bool { entries.contains { $0.status != .ok } }
    /// Root of the app group container (parent of `accounts/`), where the extension's signals live.
    var container: URL { manager.accounts.directory }

    func entry(key: String) -> AccountEntry? { entries.first { $0.id == key } }

    /// The live-change monitor of an account (`nil` before ``startMonitoring(factory:)``).
    func monitor(key: String) -> ChangeMonitor? { monitors[key] }

    /// The menu's status line of an account.
    func menuState(for entry: AccountEntry, problems: [ErrorLogEntry], now: Date = Date()) -> AccountMenuState {
        let provider: any AccountStatusProviding = monitors[entry.id] ?? statusProvider(entry)
        return AccountMenuState.derive(status: entry.status, connection: provider.connectionState, lastSync: provider.lastSync,
                                       problems: problems, accountKey: entry.id, now: now)
    }

    // MARK: - List

    /// Reads the accounts from the store and the auth-failure markers of the extension.
    func reload() {
        entries = manager.accounts.all().map { account in
            let failed = AuthFailureSignal.pending(container: container, key16: account.key16) != nil
            let missingToken = manager.credentials.token(for: account.key) == nil
            return AccountEntry(account: account, status: failed || missingToken ? .needsLogin : .ok)
        }
        syncMonitors()
    }

    // MARK: - Live changes

    /// Starts one ``ChangeMonitor`` per account (app launch; tests pass a factory). Accounts
    /// added later get theirs in ``reload()``.
    func startMonitoring(factory: ((StoredAccount) -> ChangeMonitor)? = nil) {
        makeMonitor = factory ?? { [weak self, manager] account in
            ChangeMonitor.live(account: account, manager: manager, container: manager.accounts.directory) {
                self?.processAuthFailures()
            }
        }
        syncMonitors()
    }

    /// Stops all monitors (app end).
    func stopMonitoring() {
        for monitor in monitors.values { monitor.stop() }
        monitors = [:]
        makeMonitor = nil
    }

    /// One monitor per account: new accounts start theirs (or wait for sign-in), removed
    /// accounts stop theirs, accounts needing sign-in suspend. Leaving `.authFailed` is
    /// explicit (``add(server:tokens:)``), so a rejected token never reconnects in a loop.
    private func syncMonitors() {
        guard let makeMonitor else { return }
        let keys = Set(entries.map(\.id))
        for (key, monitor) in monitors where !keys.contains(key) {
            monitor.stop()
            monitors[key] = nil
        }
        for entry in entries {
            let monitor: ChangeMonitor
            if let existing = monitors[entry.id] {
                monitor = existing
            } else {
                monitor = makeMonitor(entry.account)
                monitors[entry.id] = monitor
                if entry.status == .ok { monitor.start() }
            }
            if entry.status == .needsLogin, monitor.state != .authFailed {
                monitor.suspendForSignIn()
            }
        }
    }

    /// Darwin notification of the extension: re-read the markers.
    func processAuthFailures() {
        reload()
    }

    // MARK: - Add / sign out

    /// Adds (or replaces) the account of a finished browser login. Re-login of an account
    /// that needed it clears the marker and keeps the domain.
    @discardableResult
    func add(server: URL, tokens: AppTokens) async throws -> StoredAccount {
        let wasEmpty = manager.accounts.all().isEmpty
        let stored = try await manager.add(server: server, tokens: tokens)
        AuthFailureSignal.clear(container: container, key16: stored.key16)
        let existingMonitor = monitors[stored.key]
        reload()
        // A monitor from before the sign-in reconnects with the new token (also out of `.authFailed`).
        existingMonitor?.restart()
        if wasEmpty { onFirstAccountAdded() }
        // Let the system retry what failed while the token was rejected (always: a rejected
        // token may not have been reported yet when the user signs in again).
        await finder.resolveAuthentication(domain: manager.domain(for: stored.key))
        return stored
    }

    /// Local changes of the account that are not uploaded yet.
    func pendingChanges(key: String) async -> PendingChanges {
        guard let count = await finder.pendingItemCount(domain: manager.domain(for: key)) else { return .unknown }
        return count == 0 ? .none : .some(count)
    }

    /// Signs out: revokes the device (best effort), removes the domain, token and state.
    func signOut(key: String) async {
        let key16 = AccountStore.key16(for: key)
        monitors[key]?.stop()
        await manager.remove(key: key)
        AuthFailureSignal.clear(container: container, key16: key16)
        ErrorLog(container: container).remove(accountKey: key)
        reload()
    }

    // MARK: - Finder / web

    func openInFinder(key: String) async {
        do {
            openURL(try await finder.userVisibleURL(domain: manager.domain(for: key)))
        } catch {
            Logger.app.error("open in Finder failed: \(String(describing: error), privacy: .public)")
            lastActionError = String(localized: "The folder could not be opened: \(error.localizedDescription)")
        }
    }

    func openWeb(key: String) {
        guard let account = entry(key: key)?.account else { return }
        openURL(account.serverURL)
    }
}
