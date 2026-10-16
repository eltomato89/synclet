import Foundation
import Observation
import os
import SyncletKit

/// Recently changed files (`GET /sync/v1/recent`, spec §2.3).
@MainActor
@Observable
final class RecentModel {
    private(set) var items: [SyncItem] = []
    private(set) var state: LoadState = .idle
    @ObservationIgnored let api: SyncAPIClient
    @ObservationIgnored private var generation = 0

    static let limit = 50
    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "recent")

    init(api: SyncAPIClient) {
        self.api = api
    }

    /// Loads the list; the items shown stay until the new list arrives. The latest call wins.
    func load() async {
        generation += 1
        let generation = generation
        if state != .loaded { state = .loading }
        do {
            let items = try await api.recent(limit: Self.limit)
            guard generation == self.generation else { return }
            self.items = items
            state = .loaded
        } catch is CancellationError {
            guard generation == self.generation else { return }
            if state == .loading { state = .idle }
        } catch {
            guard generation == self.generation else { return }
            Self.log.error("recent failed: \(String(describing: error), privacy: .public)")
            state = FolderModel.loadState(for: error)
        }
    }
}
