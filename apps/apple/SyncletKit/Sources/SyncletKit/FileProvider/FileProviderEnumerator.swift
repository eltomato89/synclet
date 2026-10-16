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
///   (``SpaceLayout/feedSpaces``, every space). `currentSyncAnchor` uses the cursor
///   **before** the first page (children response) for the enumerated folder's space, and
///   `GET /cursor?space=<id>` for every other space.
/// - Changes via `GET /changes?space=<id>`, pulled per feed space from its own cursor;
///   `hasMore` ⇒ `moreComing`; 410 ⇒ `NSFileProviderError(.syncAnchorExpired)` (full
///   re-enumeration). The working set gets every change; a single container only the
///   upserts of its direct children and all deletions. Space roots are never reported
///   as ordinary items.
/// - A feed of a non-personal space that the server cannot serve (400/404 of a server
///   without spaces or a lost membership, 503 `space_unavailable`) is skipped: its cursor
///   stays (or it stays out of the anchor) and the other spaces go on. Errors of the
///   personal feed fail the batch as before.
/// - A move between spaces keeps the item id: the old space reports `delete`, the new one
///   `upsert` – in the same round, or rounds apart in either order. With more than one space
///   a `delete` is therefore only reported when no feed upserted the id in this round and
///   `GET /items/:id` answers 404/403 (gone or no access); an item that still exists is left
///   alone (its upsert arrives through its current space's feed). Other errors of that check
///   fail the batch (retried later) rather than deleting anything.
/// - A space that left the layout: its cursor is dropped; the working set reports its
///   folder (`space:<id>`) deleted, so the system removes everything below it, and forgets
///   the space's pins and pinning bookkeeping.
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
    /// Cursor before the first page and the space of the enumerated folder (`nil` = unknown).
    private var firstPage: (space: String?, cursor: String)?
    private var tasks: [UUID: Task<Void, Never>] = [:]
    /// Parallel `GET /items/:id` checks of deletions (multi-space layouts).
    static let deleteCheckConcurrency = 8

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
                if token == nil, let self {
                    let space = self.space(ofContainer: containerID, items: result.items, layout: layout)
                    self.lock.withLock { self.firstPage = (space, result.cursor) }
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

    /// The space of the enumerated folder: a space folder (root) names it, else the items'
    /// `spaceId`; a layout with a single space (a server before Phase 4) has only that one.
    private func space(ofContainer containerID: String, items: [SyncItem], layout: SpaceLayout) -> String? {
        if let space = layout.space(forRootId: containerID) { return space.id }
        if let spaceID = items.lazy.compactMap(\.spaceId).first { return spaceID }
        return layout.feedSpaces.count == 1 ? layout.feedSpaces.first?.id : nil
    }

    public func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
        let feeds = layoutProvider().feedSpaces
        let first = lock.withLock { firstPage }
        track { [client] in
            var cursors: [String: String] = [:]
            for space in feeds {
                if let first, first.space == space.id {
                    cursors[space.id] = first.cursor
                    continue
                }
                do {
                    cursors[space.id] = try await client.cursor(space: space.id)
                } catch where Self.isSkippable(error, space: space) {
                    Log.fileProvider.info("no change feed for space \(space.id, privacy: .public): \(String(describing: error), privacy: .public)")
                } catch {
                    completionHandler(nil)
                    return
                }
            }
            completionHandler(SyncAnchorCodec.encode(cursors))
        }
    }

    /// An error of a non-personal space's feed that must not stop the other spaces: 404 (a lost
    /// membership, a removed space) and 503 `space_unavailable`. A 400 is not skipped: see
    /// `isRejectedCursor`.
    static func isSkippable(_ error: Error, space: SyncSpace) -> Bool {
        guard space.id != SyncAPIClient.personalSpaceID, let error = error as? SyncAPIError else { return false }
        switch error {
        case .notFound: return true
        case .http(let status, let code, _): return isSpaceUnavailable(status: status, code: code)
        default: return false
        }
    }

    /// 400 on a non-personal feed: the server does not accept that cursor. Skipping it would keep
    /// the cursor (and freeze the feed) forever, so it becomes a full re-enumeration.
    static func isRejectedCursor(_ error: Error, space: SyncSpace) -> Bool {
        guard space.id != SyncAPIClient.personalSpaceID, let error = error as? SyncAPIError else { return false }
        switch error {
        case .invalidRequest: return true
        case .http(let status, _, _): return status == 400
        default: return false
        }
    }

    static func isSpaceUnavailable(status: Int, code: String?) -> Bool { status == 503 && code == "space_unavailable" }

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
                var pages: [(space: String, changes: [SyncChange])] = []
                for space in layout.feedSpaces {
                    try Task.checkCancellation()
                    guard let cursor = cursors[space.id] else {
                        // A space that joined after the anchor: start from the head; its
                        // content arrives through the enumeration of its folder.
                        do {
                            next[space.id] = try await client.cursor(space: space.id)
                        } catch where Self.isSkippable(error, space: space) {
                            Log.fileProvider.info("no change feed for space \(space.id, privacy: .public): \(String(describing: error), privacy: .public)")
                        }
                        continue
                    }
                    let page: SyncChangesPage
                    do {
                        page = try await client.changes(space: space.id, since: cursor, limit: limit)
                    } catch where Self.isRejectedCursor(error, space: space) {
                        Log.fileProvider.info("cursor of space \(space.id, privacy: .public) rejected: full re-enumeration")
                        throw SyncAPIError.cursorExpired
                    } catch where Self.isSkippable(error, space: space) {
                        // Try again next round from the same cursor.
                        Log.fileProvider.info("change feed of space \(space.id, privacy: .public) unavailable: \(String(describing: error), privacy: .public)")
                        next[space.id] = cursor
                        continue
                    }
                    pages.append((space.id, page.changes))
                    next[space.id] = page.cursor
                    moreComing = moreComing || page.hasMore
                }
                let kept = try await Self.confirmedDeletes(pages.flatMap(\.changes), layout: layout, client: client)
                for (_, changes) in pages {
                    let (up, del) = Self.split(changes.filter { change in
                        guard case .delete(let id) = change else { return true }
                        return kept.contains(id)
                    }, onlyChildrenOf: filterParent, layout: layout)
                    updated += up
                    deleted += del
                }
                if isWorkingSet {
                    // Spaces that left the layout: their folder (and everything below) is gone.
                    let current = Set(layout.spaces.map(\.id))
                    for spaceID in cursors.keys.sorted() where !current.contains(spaceID) {
                        deleted.append(NSFileProviderItemIdentifier(SpaceLayout.identifierPrefix + spaceID))
                    }
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

    /// The deleted ids of a round that really are gone. A single space: every delete. More
    /// spaces: an id upserted by any feed of the round moved (dropped); every other id is
    /// checked with `GET /items/:id` – 404/403 ⇒ gone, found or 503 `space_unavailable` ⇒
    /// still exists (moved to another space, its upsert comes with that feed, maybe later; or in
    /// a space that is unavailable for now) ⇒ dropped. Other errors are thrown.
    static func confirmedDeletes(_ changes: [SyncChange], layout: SpaceLayout, client: SyncAPIClient) async throws -> Set<String> {
        var upserted: Set<String> = []
        var deletes: [String] = []
        var seen: Set<String> = []
        for change in changes {
            switch change {
            case .upsert(let item): upserted.insert(item.id)
            case .delete(let id): if seen.insert(id).inserted { deletes.append(id) }
            }
        }
        guard layout.spaces.count > 1 else { return Set(deletes) }
        let roots = layout.rootIds
        let candidates = deletes.filter { !upserted.contains($0) && !roots.contains($0) }
        var gone: Set<String> = []
        try await withThrowingTaskGroup(of: (String, Bool).self) { group in
            var next = 0
            func start() {
                let id = candidates[next]
                next += 1
                group.addTask {
                    do {
                        _ = try await client.item(id: id)
                        return (id, false)
                    } catch SyncAPIError.notFound, SyncAPIError.forbidden {
                        return (id, true)
                    } catch SyncAPIError.http(let status, let code, _) where isSpaceUnavailable(status: status, code: code) {
                        // Its space's storage is gone for now: it still exists, keep it.
                        return (id, false)
                    }
                }
            }
            while next < min(candidates.count, deleteCheckConcurrency) { start() }
            while let (id, isGone) = try await group.next() {
                if isGone {
                    gone.insert(id)
                } else {
                    Log.fileProvider.info("\(id, privacy: .public) still exists (moved to another space): delete ignored")
                }
                if next < candidates.count { start() }
            }
        }
        return gone
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
        // Lost spaces (`space:<id>` no longer in the layout): forget their folders and pins.
        let lostSpaces = deleted.compactMap(SpaceLayout.spaceID(from:)).filter { layout.space(id: $0) == nil }
        if !lostSpaces.isEmpty {
            let removed = pinning.parentMap.removeDescendants(of: lostSpaces.map(SpaceLayout.rootId(ofSpaceID:)))
            pinning.ledger.remove(removed)
            if isWorkingSet {
                for space in lostSpaces {
                    do {
                        if try pinning.store.forgetSpace(space) {
                            Log.pinning.info("space \(space, privacy: .public) is gone: its pins were dropped")
                        }
                    } catch {
                        Log.pinning.error("dropping the pins of lost space \(space, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                    }
                }
            }
        }
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
            pinning.queue.roundStarted()
            if pinning.queue.takeCorruption() {
                // The lost queue may have held pin changes already marked applied: re-walk
                // every space with the current pins.
                for space in layout.spaces {
                    pinning.queue.enqueue(PinTask(kind: .walk, id: space.rootId, spaceId: space.id, announce: true))
                }
            }
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
    /// Announces before the ledger is saved: ids that could not be queued are forgotten by
    /// the ledger, so they are announced again later.
    static func finishPinning(_ pinning: PinningContext, announce: [String], workingSet: Bool) {
        if !announce.isEmpty, !pinning.announce(announce) {
            pinning.ledger.remove(announce)
        }
        pinning.flush()
        if !workingSet, !pinning.queue.isEmpty, pinning.queue.shouldRequestRound() {
            pinning.requestWorkingSetRound()
        }
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
