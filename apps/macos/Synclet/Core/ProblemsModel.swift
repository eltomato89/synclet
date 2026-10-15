import AppKit
import FileProvider
import Foundation
import Observation
import os

/// The menu's "Letzte Probleme": the shared ``ErrorLog``, re-read when the extension posts
/// ``ErrorLog/notificationName``.
@MainActor
@Observable
final class ProblemsModel {
    /// Newest first.
    private(set) var entries: [ErrorLogEntry] = []
    /// The time the menu evaluates "recent" against. Updated on every `reload()` and by a
    /// one-shot timer when the next problem leaves ``AccountMenuState/recentProblemWindow``,
    /// so the badge and "Fehler" expire without any other change. Views read it (to be
    /// re-rendered) instead of calling `Date()` alone.
    private(set) var now: Date

    @ObservationIgnored let log: ErrorLog
    /// Finder URL of an item of a domain (production: `NSFileProviderManager.getUserVisibleURL`).
    @ObservationIgnored var itemURL: (NSFileProviderDomain, String) async throws -> URL = { domain, identifier in
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        return try await manager.getUserVisibleURL(for: NSFileProviderItemIdentifier(identifier))
    }
    @ObservationIgnored var fileExists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    /// Selects a file in a Finder window.
    @ObservationIgnored var reveal: (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) }
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private let sleeper: (Duration) async throws -> Void
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    /// Woken a little after the exact expiry, so the derivation surely sees it as expired.
    static let expirySlack: TimeInterval = 0.5

    init(container: URL, clock: @escaping () -> Date = { Date() },
         sleeper: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        log = ErrorLog(container: container)
        self.clock = clock
        self.sleeper = sleeper
        now = clock()
        reload()
    }

    func reload() {
        entries = log.entries().reversed()
        tick()
    }

    /// Updates ``now`` and arms the timer for the next expiry.
    private func tick() {
        now = clock()
        expiryTask?.cancel()
        expiryTask = nil
        guard let expiry = Self.nextExpiry(entries, after: now) else { return }
        let delay = expiry.timeIntervalSince(now) + Self.expirySlack
        let sleeper = self.sleeper
        expiryTask = Task { [weak self] in
            do { try await sleeper(.milliseconds(Int64((delay * 1000).rounded(.up)))) } catch { return }
            guard !Task.isCancelled else { return }
            self?.tick()
        }
    }

    /// When the next non-info problem stops being "recent" (`nil`: none is recent).
    static func nextExpiry(_ entries: [ErrorLogEntry], after now: Date) -> Date? {
        entries.filter { !$0.isInfo }
            .map { $0.date.addingTimeInterval(AccountMenuState.recentProblemWindow) }
            .filter { $0 > now }
            .min()
    }

    func clear() {
        log.clear()
        reload()
    }

    /// Opens Finder at the entry's file if it still exists, else at the account's folder.
    func reveal(_ entry: ErrorLogEntry, accounts: AccountsModel) async {
        guard accounts.entry(key: entry.accountKey) != nil else { return }
        if let identifier = entry.itemIdentifier {
            do {
                let url = try await itemURL(accounts.manager.domain(for: entry.accountKey), identifier)
                if fileExists(url) {
                    reveal(url)
                    return
                }
            } catch {
                Logger.app.info("problem item not found: \(String(describing: error), privacy: .public)")
            }
        }
        await accounts.openInFinder(key: entry.accountKey)
    }
}
