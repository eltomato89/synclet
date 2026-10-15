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

    @ObservationIgnored let manager: AccountManager
    @ObservationIgnored let finder: FinderIntegrating
    @ObservationIgnored var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// Called once an account was added and the list was empty before (login item default).
    @ObservationIgnored var onFirstAccountAdded: () -> Void = {}

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

    // MARK: - List

    /// Reads the accounts from the store and the auth-failure markers of the extension.
    func reload() {
        entries = manager.accounts.all().map { account in
            let failed = AuthFailureSignal.pending(container: container, key16: account.key16) != nil
            let missingToken = manager.credentials.token(for: account.key) == nil
            return AccountEntry(account: account, status: failed || missingToken ? .needsLogin : .ok)
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
        reload()
        if wasEmpty { onFirstAccountAdded() }
        // Let the extension retry what failed while the token was rejected.
        await finder.signalWorkingSet(domain: manager.domain(for: stored.key))
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
        await manager.remove(key: key)
        AuthFailureSignal.clear(container: container, key16: key16)
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
