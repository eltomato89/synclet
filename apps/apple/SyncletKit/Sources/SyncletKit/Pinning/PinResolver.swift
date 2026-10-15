import FileProvider
import Foundation

/// Pinning state the extension needs for one account.
public struct PinningContext: Sendable {
    public var store: PinStore
    public var parentMap: ParentMap
    /// Called when items under a pin were (re-)reported, so the app can make sure they get
    /// downloaded (the fallback if the system does not act on the policy by itself).
    public var notifyPinnedContent: @Sendable () -> Void

    public init(store: PinStore, parentMap: ParentMap, notifyPinnedContent: @escaping @Sendable () -> Void = {}) {
        self.store = store
        self.parentMap = parentMap
        self.notifyPinnedContent = notifyPinnedContent
    }

    /// Production wiring for the account directory `accounts/<key16>/`: pins from the app
    /// group, the shared parent map in `parent-map.json`, and the Darwin notification
    /// `tech.jensk.synclet.pinnedContentChanged.<key16>`.
    public static func account(directory: URL) -> PinningContext {
        let store = PinStore(stateDir: directory)
        let name = PinStore.pinnedContentNotificationName(key16: store.key16)
        return PinningContext(store: store,
                              parentMap: .shared(at: directory.appending(path: "parent-map.json", directoryHint: .notDirectory)),
                              notifyPinnedContent: { PinStore.postDarwinNotification(name) })
    }

    /// A resolver with a fresh snapshot of the pins.
    func resolver(layout: SpaceLayout, client: SyncAPIClient) -> PinResolver {
        PinResolver(layout: layout, pins: store.allPins(spaces: layout.spaces.map(\.id)), map: parentMap, client: client)
    }
}

/// Computes the content policy of server items (via ``PinPolicy``) for one snapshot of pins.
struct PinResolver: Sendable {
    let layout: SpaceLayout
    let pins: [String: PinSet]
    let map: ParentMap
    let client: SyncAPIClient

    /// Something is pinned in any space (otherwise every item is `.inherited` and no
    /// ancestor needs resolving).
    var hasPins: Bool { pins.values.contains { !$0.isEmpty } }

    func pins(space: String) -> PinSet { pins[space] ?? PinSet() }

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

    /// Policy of an item, from its first-level ancestor (resolved through the parent map).
    func policy(for item: SyncItem) async throws -> NSFileProviderContentPolicy {
        if let space = layout.space(forRootId: item.id) { return spacePolicy(space) }
        guard hasPins else { return .inherited }
        return try await policy(itemId: item.id, parentId: item.parentId, item: item)
    }

    /// Policy of `item` as if its parent were `parentId` (also used for the old place of a
    /// moved folder).
    func policy(itemId: String, parentId: String?, item: SyncItem) async throws -> NSFileProviderContentPolicy {
        guard hasPins,
              let found = try await map.firstLevelAncestor(itemId: itemId, parentId: parentId, rootIds: layout.rootIds,
                                                           fetch: fetch),
              let space = layout.space(forRootId: found.rootId) else { return .inherited }
        return PinPolicy.contentPolicy(for: item, firstLevelAncestor: found.firstLevel, space: space.id,
                                       pins: pins(space: space.id))
    }

    /// Records the folders and maps the items with their policy.
    func items(_ syncItems: [SyncItem]) async throws -> [FileProviderItem] {
        map.record(syncItems)
        var result: [FileProviderItem] = []
        result.reserveCapacity(syncItems.count)
        for item in syncItems {
            try Task.checkCancellation()
            result.append(FileProviderItem(item, layout: layout).withContentPolicy(try await policy(for: item)))
        }
        return result
    }

    func item(_ syncItem: SyncItem) async throws -> FileProviderItem {
        try await items([syncItem])[0]
    }

    // MARK: - Re-reporting

    /// Reports everything below `folderId` (not the folder itself). Below a first-level
    /// folder every item shares that folder's policy (`policy`); with `policy == nil`
    /// (`folderId` is a space root) each first-level child decides for its own subtree.
    func walk(from folderId: String, policy: NSFileProviderContentPolicy?, pins spacePins: PinSet,
              report: ([FileProviderItem]) -> Void) async throws {
        var queue: [(id: String, policy: NSFileProviderContentPolicy?)] = [(folderId, policy)]
        while let (id, inherited) = queue.popLast() {
            var token: String?
            repeat {
                try Task.checkCancellation()
                let page: SyncChildrenPage
                do {
                    page = try await client.children(of: id, pageToken: token, limit: FileProviderEnumerator.maxPageSize)
                } catch SyncAPIError.notFound {
                    break   // gone meanwhile; its deletion arrives through the change feed
                }
                map.record(page.items)
                var batch: [FileProviderItem] = []
                for child in page.items {
                    let childPolicy = inherited
                        ?? (PinPolicy.isPinned(firstLevelAncestor: child.id, pins: spacePins) ? PinPolicy.keepDownloaded : .inherited)
                    batch.append(FileProviderItem(child, layout: layout).withContentPolicy(childPolicy))
                    if child.isFolder { queue.append((child.id, childPolicy)) }
                }
                if !batch.isEmpty { report(batch) }
                token = page.nextPageToken
            } while token != nil
        }
    }

    /// Re-reports the items whose policy changed because the pins changed since the
    /// extension last applied them (``PinStore/appliedPins(space:)``), then records the
    /// pins as applied. Unpinning only reports `.inherited`; nothing is evicted.
    /// - Parameter gone: ids known to be deleted (no lookup needed).
    func reapplyChangedPins(store: PinStore, gone: Set<String>, report: ([FileProviderItem]) -> Void) async throws {
        for space in layout.spaces {
            let current = pins(space: space.id)
            let applied = store.appliedPins(space: space.id)
            guard current != applied else { continue }
            Log.pinning.info("re-reporting pinned items of space \(space.id, privacy: .public)")
            if current.wholeSpace != applied.wholeSpace {
                let spaceItem = FileProviderItem(space: space, displayName: SpaceLayout.displayName(for: space))
                report([spaceItem.withContentPolicy(spacePolicy(space))])
                try await walk(from: space.rootId, policy: current.wholeSpace ? PinPolicy.keepDownloaded : nil,
                               pins: current, report: report)
            } else if !current.wholeSpace {
                for id in current.folders.symmetricDifference(applied.folders).sorted() where !gone.contains(id) {
                    guard let folder = try await fetch(id) else { continue }
                    let folderPolicy = try await policy(for: folder)
                    report([FileProviderItem(folder, layout: layout).withContentPolicy(folderPolicy)])
                    if folder.isFolder {
                        try await walk(from: folder.id, policy: folderPolicy, pins: current, report: report)
                    }
                }
            }
            try store.setAppliedPins(current, space: space.id)
        }
    }
}
