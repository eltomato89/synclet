import Foundation

/// The extension's map `folderId → parentId`, used to find an item's ancestor directly below
/// its space root (the "first-level ancestor" that pins are keyed by).
///
/// - Only folders are recorded: a file's parent comes with the file itself, and files are
///   never parents. That keeps the map small.
/// - Updated on every enumeration page and change batch (upserts record, deletions forget).
/// - Persisted as JSON (`accounts/<key16>/parent-map.json`, one per account: the space of an
///   item from the change feed is only known after resolving it). Writes are atomic.
/// - Unknown parents are fetched (`GET /items/:id`) and cached; at most ``maxHops`` levels.
public final class ParentMap: @unchecked Sendable {
    public static let maxHops = 64

    public let fileURL: URL?
    private let lock = NSLock()
    // Guarded by `lock`.
    private var parents: [String: String]?

    /// - Parameter fileURL: where the map is persisted; `nil` keeps it in memory.
    public init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    nonisolated(unsafe) private static var instances: [URL: ParentMap] = [:]
    private static let instancesLock = NSLock()

    /// One instance per file in this process (contexts are rebuilt for every operation).
    public static func shared(at url: URL) -> ParentMap {
        instancesLock.withLock {
            if let existing = instances[url] { return existing }
            let map = ParentMap(fileURL: url)
            instances[url] = map
            return map
        }
    }

    /// Loads lazily; must be called with `lock` held.
    private func loaded() -> [String: String] {
        if let parents { return parents }
        var result: [String: String] = [:]
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
            result = decoded
        }
        parents = result
        return result
    }

    private func persist(_ map: [String: String]) {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(map).write(to: fileURL, options: .atomic)
        } catch {
            Log.pinning.error("parent map not saved: \(String(describing: error), privacy: .public)")
        }
    }

    public func parent(of id: String) -> String? {
        lock.withLock { loaded()[id] }
    }

    /// Records the parents of the folders among `items` (files are skipped).
    public func record(_ items: [SyncItem]) {
        lock.withLock {
            var map = loaded()
            var changed = false
            for item in items where item.isFolder {
                guard let parent = item.parentId, map[item.id] != parent else { continue }
                map[item.id] = parent
                changed = true
            }
            guard changed else { return }
            parents = map
            persist(map)
        }
    }

    /// Forgets deleted folders.
    public func remove(_ ids: [String]) {
        lock.withLock {
            var map = loaded()
            var changed = false
            for id in ids where map.removeValue(forKey: id) != nil { changed = true }
            guard changed else { return }
            parents = map
            persist(map)
        }
    }

    /// The ancestor directly below a space root of the item `itemId` whose parent is
    /// `parentId` (the item itself when `parentId` is a root), plus that root.
    ///
    /// - Parameters:
    ///   - rootIds: the space roots (``SpaceLayout/rootIds``).
    ///   - fetch: loads an unknown folder (`nil` ⇒ gone); its parent is cached.
    /// - Returns: `nil` when the chain is broken, too deep or cyclic.
    public func firstLevelAncestor(itemId: String, parentId: String?, rootIds: Set<String>,
                                   fetch: (String) async throws -> SyncItem?) async throws -> (rootId: String, firstLevel: String)? {
        var child = itemId
        var parent = parentId
        var seen: Set<String> = [itemId]
        var hops = 0
        while let current = parent {
            if rootIds.contains(current) { return (current, child) }
            guard hops < Self.maxHops, seen.insert(current).inserted else { return nil }
            hops += 1
            var next = self.parent(of: current)
            if next == nil {
                guard let fetched = try await fetch(current) else { return nil }
                record([fetched])
                next = fetched.parentId
            }
            child = current
            parent = next
        }
        return nil
    }
}
