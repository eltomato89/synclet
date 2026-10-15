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

    @ObservationIgnored let log: ErrorLog
    /// Finder URL of an item of a domain (production: `NSFileProviderManager.getUserVisibleURL`).
    @ObservationIgnored var itemURL: (NSFileProviderDomain, String) async throws -> URL = { domain, identifier in
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        return try await manager.getUserVisibleURL(for: NSFileProviderItemIdentifier(identifier))
    }
    @ObservationIgnored var fileExists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    /// Selects a file in a Finder window.
    @ObservationIgnored var reveal: (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) }

    init(container: URL) {
        log = ErrorLog(container: container)
        reload()
    }

    func reload() {
        entries = log.entries().reversed()
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
