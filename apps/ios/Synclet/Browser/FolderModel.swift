import Foundation
import Observation
import os
import SyncletKit

/// Sort order of the browser (folders always come first). Persisted as `browserSort`.
enum BrowserSort: String, CaseIterable {
    case name, modified, size
}

/// List or grid. Persisted per device as `browserLayout`.
enum BrowserLayout: String {
    case list, grid
}

/// The contents of one folder and the changes made from the browser (spec §2.3, §2.8).
///
/// Every mutation sends `If-Match` with the item's `etag` (PATCH; DELETE has no precondition in
/// the Sync API). A success signals the account's working set once and reloads. Errors become a
/// ``MutationOutcome``: conflicts and vanished items set ``notice`` and reload (never retried),
/// name errors set ``fieldError`` for the open name sheet.
@MainActor
@Observable
final class FolderModel {
    let accountKey: String
    let folderId: String
    let title: String
    @ObservationIgnored let api: SyncAPIClient

    private(set) var items: [SyncItem] = []
    /// The folder itself, reloaded with its children when ``fetchesFolder`` (its current
    /// capabilities: a space can turn read-only while the folder is open).
    private(set) var folder: SyncItem?
    @ObservationIgnored let fetchesFolder: Bool
    private(set) var state: LoadState = .idle
    var sort: BrowserSort = .name {
        didSet { if sort != oldValue { items = Self.sorted(items, by: sort) } }
    }
    /// Transient message for the user („Wurde inzwischen geändert“, „Nicht mehr vorhanden“ …).
    var notice: String?
    /// Inline error of the name sheet (pre-check, „Name bereits vergeben“, server `invalid_name`).
    var fieldError: String?
    /// Outcome of the last mutation.
    private(set) var lastOutcome: MutationOutcome?
    /// Delay that coalesces change events into one reload.
    @ObservationIgnored var debounce: Duration = .milliseconds(500)

    @ObservationIgnored private let signal: (String) async -> Void
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var pendingReload: Task<Void, Never>?

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "browser")

    init(accountKey: String, folderId: String, title: String, api: SyncAPIClient, fetchesFolder: Bool = false,
         signal: @escaping (String) async -> Void) {
        self.accountKey = accountKey
        self.folderId = folderId
        self.title = title
        self.api = api
        self.fetchesFolder = fetchesFolder
        self.signal = signal
    }

    // MARK: - Loading

    /// Loads all pages of children; folders first, then ``sort``. While items are shown, a
    /// reload keeps them until the new list arrives. The latest call wins.
    func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        if state != .loaded { state = .loading }
        do {
            let api = api, folderId = folderId, fetchesFolder = fetchesFolder
            // `GET /items/:id` next to the children; its failure never fails the folder.
            async let folderItem: SyncItem? = fetchesFolder ? try? await api.item(id: folderId) : nil
            var all: [SyncItem] = []
            var pageToken: String?
            repeat {
                let page = try await api.children(of: folderId, pageToken: pageToken)
                all.append(contentsOf: page.items)
                pageToken = page.nextPageToken
            } while pageToken != nil
            let reloadedFolder = await folderItem
            guard generation == loadGeneration else { return }
            if let reloadedFolder { folder = reloadedFolder }
            items = Self.sorted(all, by: sort)
            state = .loaded
        } catch is CancellationError {
            guard generation == loadGeneration else { return }
            if state == .loading { state = .idle }
        } catch {
            guard generation == loadGeneration else { return }
            Self.log.error("loading \(self.folderId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            state = Self.loadState(for: error)
        }
    }

    /// Reloads after ``debounce``; calls within that window are coalesced into one reload.
    func reloadSoon() {
        pendingReload?.cancel()
        let delay = debounce
        pendingReload = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.pendingReload = nil
            await self.load()
        }
    }

    /// Reloads (debounced) for every change event of this account until `events` ends or the
    /// calling task is cancelled (the view disappears).
    func observe(_ events: AsyncStream<String>) async {
        for await key in events where key == accountKey {
            reloadSoon()
        }
        pendingReload?.cancel()
    }

    static func sorted(_ items: [SyncItem], by sort: BrowserSort) -> [SyncItem] {
        items.sorted { lhs, rhs in
            if lhs.isFolder != rhs.isFolder { return lhs.isFolder }
            switch sort {
            case .name:
                break
            case .modified:
                let left = lhs.modifiedDate ?? .distantPast, right = rhs.modifiedDate ?? .distantPast
                if left != right { return left > right }
            case .size:
                if lhs.size != rhs.size { return lhs.size > rhs.size }
            }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    // MARK: - Mutations

    /// `POST /items` in this folder. `false` keeps the name sheet open (see ``fieldError``) or
    /// reports a ``notice``.
    func createFolder(name: String) async -> Bool {
        guard precheck(name) else { return false }
        do {
            _ = try await api.createFolder(parentID: folderId, name: name)
            await succeeded()
            return true
        } catch {
            await failed(error)
            return false
        }
    }

    /// `PATCH /items/:id` with the new name and `If-Match`. An unchanged name sends nothing.
    func rename(_ item: SyncItem, to name: String) async -> Bool {
        guard name != item.name else {
            lastOutcome = .ok
            return true
        }
        guard precheck(name) else { return false }
        do {
            _ = try await api.rename(id: item.id, to: name, ifMatch: item.etag)
            await succeeded()
            return true
        } catch {
            await failed(error)
            return false
        }
    }

    /// Moves each item into `folderId` (`PATCH parentId`, `If-Match`). One signal and one reload
    /// at the end; the first error is reported.
    func move(_ items: [SyncItem], to folderId: String) async {
        await runBatch(items) { api, item in
            _ = try await api.move(id: item.id, toParent: folderId, ifMatch: item.etag)
        }
    }

    /// Moves the items to the trash (`DELETE /items/:id`).
    func delete(_ items: [SyncItem]) async {
        await runBatch(items) { api, item in
            try await api.deleteItem(id: item.id)
        }
    }

    private func runBatch(_ items: [SyncItem],
                          _ operation: (SyncAPIClient, SyncItem) async throws -> Void) async {
        guard !items.isEmpty else { return }
        fieldError = nil
        var firstError: Error?
        var anySucceeded = false
        for item in items {
            do {
                try await operation(api, item)
                anySucceeded = true
            } catch is CancellationError {
                break
            } catch {
                Self.log.error("change of \(item.id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                if firstError == nil { firstError = error }
            }
        }
        if anySucceeded { await signal(accountKey) }
        guard let firstError else {
            lastOutcome = .ok
            await load()
            return
        }
        let outcome = MutationErrors.outcome(for: firstError)
        lastOutcome = outcome
        notice = MutationErrors.message(outcome)
        if anySucceeded || outcome == .conflictReloaded || outcome == .gone { await load() }
    }

    private func precheck(_ name: String) -> Bool {
        if let problem = MutationErrors.nameProblem(name) {
            fieldError = problem
            lastOutcome = .invalidName(problem)
            return false
        }
        fieldError = nil
        return true
    }

    private func succeeded() async {
        lastOutcome = .ok
        fieldError = nil
        await signal(accountKey)
        await load()
    }

    /// A single mutation (create, rename) failed.
    private func failed(_ error: Error) async {
        Self.log.error("change failed: \(String(describing: error), privacy: .public)")
        let outcome = MutationErrors.outcome(for: error)
        lastOutcome = outcome
        switch outcome {
        case .nameTaken, .invalidName:
            fieldError = MutationErrors.message(outcome)
        case .conflictReloaded, .gone:
            notice = MutationErrors.message(outcome)
            await load()
        case .offline, .failed:
            notice = MutationErrors.message(outcome)
        case .ok:
            break
        }
    }

    // MARK: - Errors

    /// The state of a list whose load failed: offline, unavailable space or an error message.
    static func loadState(for error: Error) -> LoadState {
        if isOffline(error) { return .offline }
        if (error as? SyncAPIError)?.isSpaceUnavailable == true { return .unavailable }
        return .failed(describe(error))
    }

    static func isOffline(_ error: Error) -> Bool {
        if error is URLError { return true }
        if case .transport? = error as? SyncAPIError { return true }
        return false
    }

    static func describe(_ error: Error) -> String {
        if case .notFound? = error as? SyncAPIError { return String(localized: "No longer exists") }
        return error.localizedDescription
    }
}
