import Foundation
import Observation
import os
import SyncletKit

/// The trash of an account (`/api/trash`, spec §2.3, §2.8): restore, delete forever, empty.
/// The confirmations for deleting forever and emptying are the view's job.
@MainActor
@Observable
final class TrashModel {
    let accountKey: String
    private(set) var entries: [TrashEntry] = []
    private(set) var state: LoadState = .idle
    /// Transient message ("Restored to …", the server's `409` text, errors).
    var notice: String?

    @ObservationIgnored let api: SyncAPIClient
    @ObservationIgnored private let signal: (String) async -> Void
    @ObservationIgnored private var generation = 0

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "trash")

    init(accountKey: String, api: SyncAPIClient, signal: @escaping (String) async -> Void) {
        self.accountKey = accountKey
        self.api = api
        self.signal = signal
    }

    func load() async {
        generation += 1
        let generation = generation
        if state != .loaded { state = .loading }
        do {
            let entries = try await api.trash()
            guard generation == self.generation else { return }
            self.entries = entries
            state = .loaded
        } catch is CancellationError {
            guard generation == self.generation else { return }
            if state == .loading { state = .idle }
        } catch {
            guard generation == self.generation else { return }
            Self.log.error("trash failed: \(String(describing: error), privacy: .public)")
            state = FolderModel.loadState(for: error)
        }
    }

    /// `POST /api/trash/:id/restore`. Success: notice with the target (and the new name when the
    /// server renamed it), the working set is signalled. `409`: the server's message.
    func restore(_ entry: TrashEntry) async {
        do {
            let result = try await api.restoreFromTrash(id: entry.id)
            notice = Self.restoredNotice(result)
            await signal(accountKey)
        } catch is CancellationError {
            return
        } catch {
            report(error)
        }
        await load()
    }

    /// `DELETE /api/trash/:id`.
    func deleteForever(_ entry: TrashEntry) async {
        do {
            try await api.deleteFromTrash(id: entry.id)
        } catch is CancellationError {
            return
        } catch {
            report(error)
        }
        await load()
    }

    /// Entries of "My Files" (entries of servers before spaces carry no space id). Only these
    /// are emptied by `DELETE /api/trash`: other spaces' entries stay.
    var personalEntries: [TrashEntry] {
        entries.filter { ($0.spaceId ?? SyncAPIClient.personalSpaceID) == SyncAPIClient.personalSpaceID }
    }

    /// "Empty Trash" is offered only when it would delete something (like the web).
    var canEmpty: Bool { state == .loaded && !personalEntries.isEmpty }

    /// The confirmation text for emptying (a key of Localizable.xcstrings).
    static let emptyMessageKey = "All items deleted from “My Files” will be deleted forever. Deleted items of other spaces stay in the trash. This can’t be undone."

    /// `DELETE /api/trash`: empties the personal space only (the server's default).
    func empty() async {
        do {
            _ = try await api.emptyTrash()
        } catch is CancellationError {
            return
        } catch {
            report(error)
        }
        await load()
    }

    static func restoredNotice(_ result: RestoreResult) -> String {
        if result.renamed {
            return String(localized: "Restored to “\(result.restoredTo)” as “\(result.item.name)”")
        }
        return String(localized: "Restored to “\(result.restoredTo)”")
    }

    private func report(_ error: Error) {
        Self.log.error("trash change failed: \(String(describing: error), privacy: .public)")
        if case .http(409, _, let message?)? = error as? SyncAPIError {
            notice = message
            return
        }
        notice = MutationErrors.message(MutationErrors.outcome(for: error))
    }
}
