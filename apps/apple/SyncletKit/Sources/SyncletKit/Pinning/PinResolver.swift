import FileProvider
import Foundation

/// Pinning state the extension needs for one account.
public struct PinningContext: Sendable {
    public var store: PinStore
    public var parentMap: ParentMap
    /// Content versions of reported kept files (announce only new content).
    public var ledger: PinnedContentLedger
    /// Persistent, bounded re-report work (drained by the working set).
    public var queue: PinWorkQueue
    /// Receives ids of files newly reported as kept offline (new or changed content), so the
    /// app can request exactly those downloads.
    public var announce: @Sendable ([String]) -> Void
    /// Asks the system for a working-set round (work was queued outside the working set).
    public var requestWorkingSetRound: @Sendable () -> Void

    public init(store: PinStore, parentMap: ParentMap, ledger: PinnedContentLedger = PinnedContentLedger(fileURL: nil),
                queue: PinWorkQueue = PinWorkQueue(fileURL: nil),
                announce: @escaping @Sendable ([String]) -> Void = { _ in },
                requestWorkingSetRound: @escaping @Sendable () -> Void = {}) {
        self.store = store
        self.parentMap = parentMap
        self.ledger = ledger
        self.queue = queue
        self.announce = announce
        self.requestWorkingSetRound = requestWorkingSetRound
    }

    /// Production wiring for the account directory `accounts/<key16>/` (key16 = domain id):
    /// pins from the app group; `parent-map.json`, `pinned-content.json`, `pin-queue.json`;
    /// announcements into ``PinnedDownloadQueue`` plus the Darwin notification
    /// `tech.jensk.synclet.pinnedContentChanged.<key16>`.
    public static func account(directory: URL) -> PinningContext {
        let store = PinStore(stateDir: directory)
        let key16 = store.key16
        let name = PinStore.pinnedContentNotificationName(key16: key16)
        let downloads = PinnedDownloadQueue(accountDirectory: directory)
        func file(_ name: String) -> URL { directory.appending(path: name, directoryHint: .notDirectory) }
        return PinningContext(
            store: store,
            parentMap: .shared(at: file("parent-map.json")),
            ledger: .shared(at: file("pinned-content.json")),
            queue: .shared(at: file("pin-queue.json")),
            announce: { ids in
                do {
                    try downloads.append(ids)
                } catch {
                    Log.pinning.error("pinned downloads not queued: \(String(describing: error), privacy: .public)")
                }
                PinStore.postDarwinNotification(name)
            },
            requestWorkingSetRound: {
                let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(key16), displayName: "")
                NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
            })
    }

    /// Persists the map, ledger and queue.
    public func flush() {
        parentMap.flush()
        ledger.flush()
        queue.flush()
    }

    /// A resolver with a fresh snapshot of the pins.
    func resolver(layout: SpaceLayout, client: SyncAPIClient) -> PinResolver {
        PinResolver(layout: layout, pins: store.allPins(spaces: layout.spaces.map(\.id)), client: client, pinning: self)
    }
}

/// Computes the content policy of server items (via ``PinPolicy``) for one snapshot of pins
/// and drives the re-report work queue.
///
/// Resolution never stalls sync: a failed ancestor lookup reports `.inherited`, is logged and
/// queued for a retry; walk errors leave the work in the persistent queue for the next round.
struct PinResolver: Sendable {
    let layout: SpaceLayout
    let pins: [String: PinSet]
    let client: SyncAPIClient
    let pinning: PinningContext

    private var map: ParentMap { pinning.parentMap }
    private var queue: PinWorkQueue { pinning.queue }

    /// Something is pinned in any space (otherwise every item is `.inherited` and no
    /// ancestor needs resolving).
    var hasPins: Bool { pins.values.contains { !$0.isEmpty } }

    func pins(space: String?) -> PinSet { space.flatMap { pins[$0] } ?? PinSet() }

    /// `GET /items/:id`; `nil` when gone.
    func fetch(_ id: String) async throws -> SyncItem? {
        do {
            return try await client.item(id: id)
        } catch SyncAPIError.notFound {
            return nil
        }
    }

    func spacePolicy(_ space: SyncSpace) -> NSFileProviderContentPolicy {
        PinPolicy.contentPolicy(forSpace: space.id, pins: pins(space: space.id))
    }

    /// Space and first-level ancestor of an item (`nil`: chain broken, too deep, or gone).
    func placement(of item: SyncItem) async throws -> (spaceId: String, firstLevel: String)? {
        guard let found = try await map.firstLevelAncestor(itemId: item.id, parentId: item.parentId,
                                                          rootIds: layout.rootIds, fetch: fetch),
              let space = layout.space(forRootId: found.rootId) else { return nil }
        return (space.id, found.firstLevel)
    }

    private func policy(firstLevel: String?, space: String?) -> NSFileProviderContentPolicy {
        PinPolicy.isPinned(firstLevelAncestor: firstLevel, pins: pins(space: space)) ? PinPolicy.keepDownloaded : .inherited
    }

    private static func isKept(_ policy: NSFileProviderContentPolicy) -> Bool {
        PinPolicy.keepDownloaded != .inherited && policy == PinPolicy.keepDownloaded
    }

    /// Bookkeeping after reporting `item` with `policy`: a folder whose kept state flipped
    /// queues a walk of its subtree (unless `walking`: the walk covers it already); a kept
    /// file with new content is returned for announcing.
    private func note(_ item: SyncItem, policy: NSFileProviderContentPolicy, spaceId: String?, firstLevel: String?,
                      walking: Bool, announce: Bool) -> String? {
        let kept = Self.isKept(policy)
        if item.isFolder {
            if map.notePolicy(item.id, kept: kept), !walking {
                Log.pinning.info("folder \(item.id, privacy: .public) moved across a pin: re-reporting its subtree")
                queue.enqueue(PinTask(kind: .walk, id: item.id, spaceId: spaceId, firstLevel: firstLevel, announce: true))
            }
            return nil
        }
        if kept {
            let isNew = pinning.ledger.update(id: item.id, version: item.contentEtag ?? item.etag)
            return isNew && announce ? item.id : nil
        }
        pinning.ledger.remove([item.id])
        return nil
    }

    /// Records the folders and maps the items with their policy. Returns the ids of kept
    /// files with new content. Only cancellation is thrown.
    func items(_ syncItems: [SyncItem], announce: Bool = true) async throws -> (items: [FileProviderItem], announce: [String]) {
        map.record(syncItems)
        var result: [FileProviderItem] = []
        var fresh: [String] = []
        result.reserveCapacity(syncItems.count)
        for item in syncItems {
            try Task.checkCancellation()
            if let space = layout.space(forRootId: item.id) {
                result.append(FileProviderItem(item, layout: layout).withContentPolicy(spacePolicy(space)))
                continue
            }
            var placement: (spaceId: String, firstLevel: String)?
            if hasPins {
                do {
                    placement = try await self.placement(of: item)
                } catch {
                    if error is CancellationError { throw error }
                    // Never stall sync: report the default, retry the lookup later.
                    Log.pinning.error("ancestor of \(item.id, privacy: .public) unknown: \(String(describing: error), privacy: .public)")
                    queue.enqueue(PinTask(kind: .item, id: item.id, announce: announce))
                    result.append(FileProviderItem(item, layout: layout))
                    continue
                }
            }
            let policy = policy(firstLevel: placement?.firstLevel, space: placement?.spaceId)
            result.append(FileProviderItem(item, layout: layout).withContentPolicy(policy))
            if let id = note(item, policy: policy, spaceId: placement?.spaceId, firstLevel: placement?.firstLevel,
                             walking: false, announce: announce) {
                fresh.append(id)
            }
        }
        return (result, fresh)
    }

    // MARK: - Re-reporting

    /// Queues the re-report of everything whose policy changed because the pins changed since
    /// the extension last applied them (``PinStore/appliedPins(space:)``) and records them as
    /// applied (the work itself is persisted in the queue). A whole-space change reports the
    /// space folder right away. Unpinning only reports `.inherited`; nothing is evicted.
    /// - Parameter gone: ids known to be deleted (no lookup needed).
    func enqueueChangedPins(gone: Set<String>, report: ([FileProviderItem]) -> Void) {
        let store = pinning.store
        for space in layout.spaces {
            let current = pins(space: space.id)
            let applied = store.appliedPins(space: space.id)
            guard current != applied else { continue }
            Log.pinning.info("pins of space \(space.id, privacy: .public) changed: queuing re-report")
            if current.wholeSpace != applied.wholeSpace {
                let spaceItem = FileProviderItem(space: space, displayName: SpaceLayout.displayName(for: space))
                report([spaceItem.withContentPolicy(spacePolicy(space))])
                queue.enqueue(PinTask(kind: .walk, id: space.rootId, spaceId: space.id, announce: false))
            } else if !current.wholeSpace {
                for id in current.folders.symmetricDifference(applied.folders).sorted() where !gone.contains(id) {
                    queue.enqueue(PinTask(kind: .item, id: id, announce: false, walkAfter: true))
                }
            }
            do {
                try store.setAppliedPins(current, space: space.id)
            } catch {
                Log.pinning.error("applied pins not saved: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// Works off the queue until about `budget` items were reported. Errors are logged and
    /// leave the head task for the next round (sync goes on). Policies are evaluated with the
    /// current pins, so stale tasks are harmless.
    /// - Returns: `more` = stopped by the budget with work left (⇒ `moreComing`), and the ids
    ///   of kept files with new content.
    func drain(budget: Int, report: ([FileProviderItem]) -> Void) async -> (more: Bool, announce: [String]) {
        var reported = 0
        var fresh: [String] = []
        while reported < budget, let task = queue.head() {
            do {
                switch task.kind {
                case .walk:
                    let page: SyncChildrenPage
                    do {
                        page = try await client.children(of: task.id, pageToken: task.pageToken,
                                                         limit: min(max(budget - reported, 1), FileProviderEnumerator.maxPageSize))
                    } catch SyncAPIError.notFound {
                        queue.popHead()   // gone meanwhile; its deletion arrives through the change feed
                        continue
                    }
                    map.record(page.items)
                    let isRoot = layout.rootIds.contains(task.id)
                    var batch: [FileProviderItem] = []
                    for child in page.items {
                        let firstLevel = task.firstLevel ?? (isRoot ? child.id : nil)
                        let policy = policy(firstLevel: firstLevel, space: task.spaceId)
                        batch.append(FileProviderItem(child, layout: layout).withContentPolicy(policy))
                        if let id = note(child, policy: policy, spaceId: task.spaceId, firstLevel: firstLevel,
                                         walking: true, announce: task.announce) {
                            fresh.append(id)
                        }
                        if child.isFolder {
                            queue.enqueue(PinTask(kind: .walk, id: child.id, spaceId: task.spaceId, firstLevel: firstLevel,
                                                  announce: task.announce))
                        }
                    }
                    if !batch.isEmpty { report(batch) }
                    reported += batch.count
                    if let next = page.nextPageToken {
                        var resumed = task
                        resumed.pageToken = next
                        queue.replaceHead(resumed)
                    } else {
                        queue.popHead()
                    }
                case .item:
                    guard let item = try await fetch(task.id) else {
                        queue.popHead()
                        continue
                    }
                    map.record([item])
                    let placement = try await placement(of: item)
                    let policy: NSFileProviderContentPolicy = layout.space(forRootId: item.id).map(spacePolicy)
                        ?? policy(firstLevel: placement?.firstLevel, space: placement?.spaceId)
                    report([FileProviderItem(item, layout: layout).withContentPolicy(policy)])
                    reported += 1
                    if let id = note(item, policy: policy, spaceId: placement?.spaceId, firstLevel: placement?.firstLevel,
                                     walking: task.walkAfter, announce: task.announce) {
                        fresh.append(id)
                    }
                    queue.popHead()
                    if task.walkAfter, item.isFolder {
                        queue.enqueue(PinTask(kind: .walk, id: item.id, spaceId: placement?.spaceId,
                                              firstLevel: placement?.firstLevel, announce: task.announce))
                    }
                }
            } catch {
                if !(error is CancellationError) {
                    Log.pinning.error("pin re-report paused: \(String(describing: error), privacy: .public)")
                }
                return (false, fresh)
            }
        }
        return (!queue.isEmpty, fresh)
    }
}

/// One unit of re-report work.
public struct PinTask: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// Report the children of `id` (page by page), queue sub-folders.
        case walk
        /// Look up `id`, report it with its policy (and walk it when `walkAfter`).
        case item
    }

    public var kind: Kind
    public var id: String
    /// Space of the walked subtree (`nil`: unknown ⇒ nothing pinned).
    public var spaceId: String?
    /// First-level ancestor shared by the subtree; `nil` below a space root (each child decides).
    public var firstLevel: String?
    /// Resume point of a walk.
    public var pageToken: String?
    /// Announce kept files with new content to the app (not for pin toggles: the app walks then).
    public var announce: Bool
    public var walkAfter: Bool

    public init(kind: Kind, id: String, spaceId: String? = nil, firstLevel: String? = nil, pageToken: String? = nil,
                announce: Bool, walkAfter: Bool = false) {
        self.kind = kind
        self.id = id
        self.spaceId = spaceId
        self.firstLevel = firstLevel
        self.pageToken = pageToken
        self.announce = announce
        self.walkAfter = walkAfter
    }
}

/// FIFO of ``PinTask``s, persisted (`accounts/<key16>/pin-queue.json`) on ``flush()`` so a
/// re-report survives errors and extension restarts and resumes where it stopped.
public final class PinWorkQueue: @unchecked Sendable {
    public let fileURL: URL?
    private let lock = NSLock()
    // Guarded by `lock`.
    private var storage: [PinTask]?
    private var dirty = false

    public init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    public static func shared(at url: URL) -> PinWorkQueue {
        sharedInstance(at: url) { PinWorkQueue(fileURL: url) }
    }

    private func loaded() -> [PinTask] {
        if let storage { return storage }
        var result: [PinTask] = []
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([PinTask].self, from: data) {
            result = decoded
        }
        storage = result
        return result
    }

    private func change(_ body: (inout [PinTask]) -> Void) {
        lock.withLock {
            var tasks = loaded()
            body(&tasks)
            storage = tasks
            dirty = true
        }
    }

    public var tasks: [PinTask] { lock.withLock { loaded() } }
    public var isEmpty: Bool { tasks.isEmpty }

    /// Appends unless the same task is already waiting; `true` when added.
    @discardableResult
    public func enqueue(_ task: PinTask) -> Bool {
        var added = false
        change { tasks in
            guard !tasks.contains(task) else { return }
            tasks.append(task)
            added = true
        }
        return added
    }

    public func head() -> PinTask? { tasks.first }

    public func replaceHead(_ task: PinTask) {
        change { tasks in if !tasks.isEmpty { tasks[0] = task } }
    }

    public func popHead() {
        change { tasks in if !tasks.isEmpty { tasks.removeFirst() } }
    }

    public func flush() {
        lock.withLock {
            guard dirty, let fileURL, let storage else { return }
            do {
                try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONEncoder().encode(storage).write(to: fileURL, options: .atomic)
                dirty = false
            } catch {
                Log.pinning.error("pin queue not saved: \(String(describing: error), privacy: .public)")
            }
        }
    }
}
