import FileProvider
import Foundation

/// Wrapper to pass system objects (not `Sendable`) into a `Task`. The File Provider
/// system allows calling its observers from any thread.
struct UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// Sync anchors of the domain: a JSON object `{ "<spaceId>": "<cursor>" }` holding one
/// change cursor per space with a change feed, so later spaces with their own feed can
/// join without a migration.
public enum SyncAnchorCodec {
    public static func encode(_ cursors: [String: String]) -> NSFileProviderSyncAnchor {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return NSFileProviderSyncAnchor((try? encoder.encode(cursors)) ?? Data("{}".utf8))
    }

    /// `nil` when the anchor is not such an object (⇒ re-enumerate).
    public static func decode(_ anchor: NSFileProviderSyncAnchor) -> [String: String]? {
        try? JSONDecoder().decode([String: String].self, from: anchor.rawValue)
    }
}

/// Enumeration of a container or of the working set.
///
/// - Container: children page by page via `GET /items/:id/children` (page token =
///   `nextPageToken` as UTF-8). A space folder enumerates its `rootId`.
/// - Sync anchor = ``SyncAnchorCodec`` map of the cursors of the feed spaces
///   (``SpaceLayout/feedSpaces``). `currentSyncAnchor` uses the cursor **before** the
///   first page (children response), else `GET /cursor`.
/// - Changes via `GET /changes`, pulled per feed space from its own cursor; `hasMore`
///   ⇒ `moreComing`; 410 ⇒ `NSFileProviderError(.syncAnchorExpired)` (full
///   re-enumeration). The working set gets every change; a single container only the
///   upserts of its direct children and all deletions. Space roots are never reported
///   as ordinary items.
/// - Pinning (``PinningContext``, Strategy B): every reported item carries its
///   ``PinPolicy`` content policy. The working set additionally re-reports subtrees whose
///   policy changed (pins changed since last applied, a folder moved into or out of a
///   pinned folder), drops pins of deleted folders, and announces pinned content.
public final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator, @unchecked Sendable {
    /// Default and maximum page size of the API.
    public static let defaultPageSize = 500
    public static let maxPageSize = 1000

    public let containerIdentifier: NSFileProviderItemIdentifier
    private let client: SyncAPIClient
    private let layoutProvider: @Sendable () -> SpaceLayout
    private let cursorSink: (@Sendable (_ spaceID: String, _ cursor: String) -> Void)?
    private let pinning: PinningContext?
    private let lock = NSLock()
    private var firstPageCursor: String?
    private var tasks: [UUID: Task<Void, Never>] = [:]

    /// - Parameters:
    ///   - layout: current space layout (read on every call; spaces may change).
    ///   - cursorSink: called with each space's cursor after a change page was reported.
    ///   - pinning: offline pins of the account (`nil` ⇒ every item `.inherited`).
    public init(containerIdentifier: NSFileProviderItemIdentifier, client: SyncAPIClient,
                layout: @escaping @Sendable () -> SpaceLayout,
                cursorSink: (@Sendable (_ spaceID: String, _ cursor: String) -> Void)? = nil,
                pinning: PinningContext? = nil) {
        self.containerIdentifier = containerIdentifier
        self.client = client
        self.layoutProvider = layout
        self.cursorSink = cursorSink
        self.pinning = pinning
    }

    /// Variant with a fixed layout.
    public convenience init(containerIdentifier: NSFileProviderItemIdentifier, client: SyncAPIClient, layout: SpaceLayout) {
        self.init(containerIdentifier: containerIdentifier, client: client, layout: { layout })
    }

    private var isWorkingSet: Bool { containerIdentifier == .workingSet }

    public func invalidate() {
        let running = lock.withLock { () -> [Task<Void, Never>] in
            defer { tasks.removeAll() }
            return Array(tasks.values)
        }
        running.forEach { $0.cancel() }
    }

    /// Runs `operation` as a task that `invalidate()` cancels; finished tasks are forgotten.
    private func track(_ operation: @escaping @Sendable () async -> Void) {
        let id = UUID()
        lock.withLock {
            let task = Task { [weak self] in
                await operation()
                self?.finish(id)
            }
            tasks[id] = task
        }
    }

    private func finish(_ id: UUID) {
        _ = lock.withLock { tasks.removeValue(forKey: id) }
    }

    /// Number of running tasks (tests).
    var runningTaskCount: Int { lock.withLock { tasks.count } }

    // MARK: - Items

    /// Page token from an `NSFileProviderPage` (initial pages ⇒ `nil`).
    static func pageToken(from page: NSFileProviderPage) -> String? {
        let raw = page.rawValue
        if raw == NSFileProviderPage.initialPageSortedByName as Data
            || raw == NSFileProviderPage.initialPageSortedByDate as Data
            || raw.isEmpty {
            return nil
        }
        return String(data: raw, encoding: .utf8)
    }

    static func pageSize(suggested: Int?) -> Int {
        guard let suggested, suggested > 0 else { return defaultPageSize }
        return min(suggested, maxPageSize)
    }

    public func enumerateItems(for observer: any NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let box = UncheckedBox(observer)
        // Working set: no up-front enumeration – the system loads containers on demand;
        // changes arrive through `enumerateChanges`.
        guard !isWorkingSet else {
            observer.finishEnumerating(upTo: nil)
            return
        }
        let layout = layoutProvider()
        guard let containerID = layout.serverID(for: containerIdentifier) else {
            observer.finishEnumeratingWithError(NSFileProviderError(.noSuchItem))
            return
        }
        let token = Self.pageToken(from: page)
        let limit = Self.pageSize(suggested: observer.suggestedPageSize)
        let resolver = pinning?.resolver(layout: layout, client: client)
        track { [client, weak self] in
            do {
                let result = try await client.children(of: containerID, pageToken: token, limit: limit)
                if token == nil {
                    self?.lock.withLock { self?.firstPageCursor = result.cursor }
                }
                let items: [FileProviderItem]
                if let resolver {
                    let resolved = try await resolver.items(result.items)
                    items = resolved.items
                    Self.finishPinning(resolver.pinning, announce: resolved.announce, workingSet: false)
                } else {
                    items = result.items.map { FileProviderItem($0, layout: layout) }
                }
                box.value.didEnumerate(items)
                let next = result.nextPageToken.map { NSFileProviderPage(Data($0.utf8)) }
                box.value.finishEnumerating(upTo: next)
            } catch {
                box.value.finishEnumeratingWithError(ErrorMapping.fileProviderError(error))
            }
        }
    }

    // MARK: - Changes

    public func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
        let feeds = layoutProvider().feedSpaces
        // Every feed space reads the user's journal in Phase 2, so one cursor serves all.
        if let cursor = lock.withLock({ firstPageCursor }) {
            completionHandler(SyncAnchorCodec.encode(Dictionary(feeds.map { ($0.id, cursor) }, uniquingKeysWith: { a, _ in a })))
            return
        }
        track { [client] in
            guard let cursor = try? await client.cursor() else {
                completionHandler(nil)
                return
            }
            completionHandler(SyncAnchorCodec.encode(Dictionary(feeds.map { ($0.id, cursor) }, uniquingKeysWith: { a, _ in a })))
        }
    }

    public func enumerateChanges(for observer: any NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        let box = UncheckedBox(observer)
        guard let cursors = SyncAnchorCodec.decode(anchor) else {
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
        let layout = layoutProvider()
        let limit = Self.pageSize(suggested: observer.suggestedBatchSize)
        let filterParent = isWorkingSet ? nil : layout.serverID(for: containerIdentifier)
        let isWorkingSet = isWorkingSet
        track { [client, cursorSink, pinning] in
            do {
                var next: [String: String] = [:]
                var moreComing = false
                var updated: [SyncItem] = []
                var deleted: [NSFileProviderItemIdentifier] = []
                for space in layout.feedSpaces {
                    try Task.checkCancellation()
                    guard let cursor = cursors[space.id] else {
                        // A space that joined after the anchor: start from the head; its
                        // content arrives through the enumeration of its folder.
                        next[space.id] = try await client.cursor()
                        continue
                    }
                    let page = try await client.changes(since: cursor, limit: limit)
                    let (up, del) = Self.split(page.changes, onlyChildrenOf: filterParent, layout: layout)
                    updated += up
                    deleted += del
                    next[space.id] = page.cursor
                    moreComing = moreComing || page.hasMore
                }
                if let pinning {
                    let more = try await Self.reportPinned(updated: updated, deleted: deleted, pinning: pinning, layout: layout,
                                                           client: client, isWorkingSet: isWorkingSet, budget: limit) {
                        box.value.didUpdate($0)
                    }
                    moreComing = moreComing || more
                } else if !updated.isEmpty {
                    box.value.didUpdate(updated.map { FileProviderItem($0, layout: layout) })
                }
                if !deleted.isEmpty { box.value.didDeleteItems(withIdentifiers: deleted) }
                box.value.finishEnumeratingChanges(upTo: SyncAnchorCodec.encode(next), moreComing: moreComing)
                for (spaceID, cursor) in next { cursorSink?(spaceID, cursor) }
            } catch {
                if case SyncAPIError.cursorExpired = error {
                    Log.fileProvider.info("cursor expired: full re-enumeration")
                }
                box.value.finishEnumeratingWithError(ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// Reports the upserts of a change batch with their content policy. In the working set
    /// also: drop pins of deleted folders, queue re-reports for changed pins, and work off at
    /// most about `budget` items of the persistent re-report queue. Pinning never fails the
    /// batch: lookups fall back to `.inherited`, queue work pauses on errors.
    /// - Returns: `true` when re-report work is left (⇒ `moreComing`).
    static func reportPinned(updated: [SyncItem], deleted: [NSFileProviderItemIdentifier], pinning: PinningContext,
                             layout: SpaceLayout, client: SyncAPIClient, isWorkingSet: Bool, budget: Int,
                             report: ([FileProviderItem]) -> Void) async throws -> Bool {
        let goneIDs = deleted.compactMap { layout.serverID(for: $0) }
        pinning.parentMap.remove(goneIDs)
        pinning.ledger.remove(goneIDs)
        if isWorkingSet {
            for id in goneIDs {
                do {
                    if try pinning.store.forget(folder: id, spaces: layout.spaces.map(\.id)) {
                        Log.pinning.info("pinned folder \(id, privacy: .public) was deleted: pin dropped")
                    }
                } catch {
                    Log.pinning.error("dropping the pin of \(id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
        let resolver = pinning.resolver(layout: layout, client: client)
        let resolved = try await resolver.items(updated)
        if !resolved.items.isEmpty { report(resolved.items) }
        var announce = resolved.announce
        var more = false
        if isWorkingSet {
            resolver.enqueueChangedPins(gone: Set(goneIDs), report: report)
            let drained = await resolver.drain(budget: budget, report: report)
            more = drained.more
            announce += drained.announce
        }
        finishPinning(pinning, announce: announce, workingSet: isWorkingSet)
        return more
    }

    /// Persists the pinning state, announces new kept content, and asks for a working-set
    /// round when work was queued outside of it.
    static func finishPinning(_ pinning: PinningContext, announce: [String], workingSet: Bool) {
        pinning.flush()
        if !announce.isEmpty { pinning.announce(announce) }
        if !workingSet, !pinning.queue.isEmpty { pinning.requestWorkingSetRound() }
    }

    /// Splits changes into upserts and deletions (optionally only the direct children of
    /// `parentID`). Space roots are skipped: they are virtual folders.
    static func split(_ changes: [SyncChange], onlyChildrenOf parentID: String?,
                      layout: SpaceLayout) -> ([SyncItem], [NSFileProviderItemIdentifier]) {
        let roots = layout.rootIds
        var updated: [SyncItem] = []
        var deleted: [NSFileProviderItemIdentifier] = []
        for change in changes {
            switch change {
            case .upsert(let item):
                guard !roots.contains(item.id) else { continue }
                if parentID == nil || item.parentId == parentID { updated.append(item) }
            case .delete(let id):
                guard !roots.contains(id) else { continue }
                deleted.append(layout.providerIdentifier(forServerID: id))
            }
        }
        return (updated, deleted)
    }
}

/// Enumeration of the root container: one folder per space (``SpaceLayout/topLevelItems(bundle:)``).
///
/// The anchor is the list of space ids. A change of the spaces (the app signals the root
/// container) reports vanished spaces as deleted and every current space as updated.
public final class TopLevelEnumerator: NSObject, NSFileProviderEnumerator, Sendable {
    private let layoutProvider: @Sendable () -> SpaceLayout
    private let pinsProvider: @Sendable () -> [String: PinSet]

    /// - Parameter pins: offline pins per space id (a fully pinned space folder is kept offline).
    public init(layout: @escaping @Sendable () -> SpaceLayout,
                pins: @escaping @Sendable () -> [String: PinSet] = { [:] }) {
        self.layoutProvider = layout
        self.pinsProvider = pins
    }

    /// The space folders with their content policy.
    private func items(_ layout: SpaceLayout) -> [FileProviderItem] {
        let pins = pinsProvider()
        return layout.topLevelItems().map { item in
            guard let space = item.space else { return item }
            return item.withContentPolicy(PinPolicy.contentPolicy(forSpace: space.id, pins: pins[space.id] ?? PinSet()))
        }
    }

    public convenience init(layout: SpaceLayout) {
        self.init(layout: { layout })
    }

    public func invalidate() {}

    static func anchor(for layout: SpaceLayout) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor((try? JSONEncoder().encode(layout.spaces.map(\.id))) ?? Data("[]".utf8))
    }

    public func enumerateItems(for observer: any NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.didEnumerate(items(layoutProvider()))
        observer.finishEnumerating(upTo: nil)
    }

    public func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(Self.anchor(for: layoutProvider()))
    }

    public func enumerateChanges(for observer: any NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        guard let previous = try? JSONDecoder().decode([String].self, from: anchor.rawValue) else {
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
        let layout = layoutProvider()
        let current = Set(layout.spaces.map(\.id))
        let gone = previous.filter { !current.contains($0) }
            .map { NSFileProviderItemIdentifier(SpaceLayout.identifierPrefix + $0) }
        let items = self.items(layout)
        if !items.isEmpty { observer.didUpdate(items) }
        if !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone) }
        observer.finishEnumeratingChanges(upTo: Self.anchor(for: layout), moreComing: false)
    }
}
