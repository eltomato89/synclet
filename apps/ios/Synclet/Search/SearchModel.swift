import Foundation
import Observation
import os
import SyncletKit

/// Full-text search (`GET /sync/v1/search`, spec §2.3): debounced as the user types, at least two
/// characters, optionally limited to a folder; offset paging with 20 hits per page.
@MainActor
@Observable
final class SearchModel {
    /// The text in the search field. Call ``queryChanged()`` after changing it.
    var query = ""
    /// Limits the search to this folder („Im Ordner suchen“, iPad); `nil` searches everything.
    var scopeFolderId: String? {
        didSet { if scopeFolderId != oldValue { queryChanged() } }
    }
    private(set) var hits: [SyncSearchHit] = []
    private(set) var total = 0
    private(set) var state: LoadState = .idle
    /// A further page is being loaded.
    private(set) var isLoadingMore = false
    /// A new search (debounce or request) has not applied its result yet; the hits shown
    /// belong to the previous query and are not paged.
    private(set) var isSearchPending = false

    @ObservationIgnored let api: SyncAPIClient
    @ObservationIgnored var debounce: Duration = .milliseconds(300)
    @ObservationIgnored private var pending: Task<Void, Never>?
    /// Incremented by every new query; results of older queries are dropped.
    @ObservationIgnored private var generation = 0
    /// Query and folder that produced ``hits`` (used for paging).
    @ObservationIgnored private var activeQuery = ""
    @ObservationIgnored private var activeFolder: String?

    static let pageSize = 20
    static let minimumLength = 2

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "search")

    init(api: SyncAPIClient) {
        self.api = api
    }

    var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// More hits than shown.
    var canLoadMore: Bool { state == .loaded && !isSearchPending && hits.count < total }

    /// Starts a search for ``query`` after the debounce delay; cancels the previous search (also
    /// one in flight). Shorter than two characters: no request, no hits.
    func queryChanged() {
        pending?.cancel()
        pending = nil
        generation += 1
        // A page of the previous query still in flight is dropped (generation) and must not
        // block paging of the new one.
        isLoadingMore = false
        let text = trimmedQuery
        guard text.count >= Self.minimumLength else {
            hits = []
            total = 0
            state = .idle
            isSearchPending = false
            return
        }
        isSearchPending = true
        if hits.isEmpty { state = .loading }
        let generation = generation
        let delay = debounce
        let folder = scopeFolderId
        pending = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            await self.search(text, folder: folder, generation: generation)
        }
    }

    private func search(_ text: String, folder: String?, generation: Int) async {
        if hits.isEmpty { state = .loading }
        do {
            let result = try await api.search(text, folder: folder, limit: Self.pageSize, offset: 0)
            guard generation == self.generation else { return }
            hits = result.hits
            total = result.total
            activeQuery = text
            activeFolder = folder
            isSearchPending = false
            state = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard generation == self.generation else { return }
            Self.log.error("search failed: \(String(describing: error), privacy: .public)")
            hits = []
            total = 0
            isSearchPending = false
            state = FolderModel.isOffline(error) ? .offline : .failed(FolderModel.describe(error))
        }
    }

    /// Loads the next page (`offset` = hits shown); does nothing once all ``total`` hits are shown.
    func loadMore() async {
        guard canLoadMore, !isLoadingMore else { return }
        let generation = generation
        isLoadingMore = true
        defer { if generation == self.generation { isLoadingMore = false } }
        do {
            let result = try await api.search(activeQuery, folder: activeFolder, limit: Self.pageSize,
                                              offset: hits.count)
            guard generation == self.generation else { return }
            hits.append(contentsOf: result.hits)
            total = result.hits.isEmpty ? hits.count : result.total
        } catch {
            guard generation == self.generation, !(error is CancellationError) else { return }
            Self.log.error("search page failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// The snippet with the server's `«…»` markers removed and their contents bold.
    static func highlighted(_ snippet: String) -> AttributedString {
        var result = AttributedString()
        var bold = false
        var part = ""
        func flush() {
            guard !part.isEmpty else { return }
            var piece = AttributedString(part)
            if bold { piece.inlinePresentationIntent = .stronglyEmphasized }
            result.append(piece)
            part = ""
        }
        for character in snippet {
            switch character {
            case "«":
                flush()
                bold = true
            case "»":
                flush()
                bold = false
            default:
                part.append(character)
            }
        }
        flush()
        return result
    }
}
