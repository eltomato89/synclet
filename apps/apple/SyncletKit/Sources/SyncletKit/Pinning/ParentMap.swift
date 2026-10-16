import Foundation

/// The extension's map `folderId → parentId`, used to find an item's ancestor directly below
/// its space root (the "first-level ancestor" that pins are keyed by).
///
/// - Only folders are recorded: a file's parent comes with the file itself, and files are
///   never parents. That keeps the map small.
/// - Each folder also remembers whether it was last reported kept offline, so a folder whose
///   policy flips (moved into or out of a pin, by whichever path noticed it first) gets its
///   subtree re-reported.
/// - Updated on every enumeration page and change batch (upserts record, deletions forget the
///   folder and every recorded descendant).
/// - Persisted as JSON (`accounts/<key16>/parent-map.json`, one per account: the space of an
///   item from the change feed is only known after resolving it) on ``flush()``, which the
///   extension calls once per enumeration call, not per page, and only when it changed.
/// - Kept only while something is pinned, and bounded (``maxEntries``).
/// - Unknown parents are fetched (`GET /items/:id`) and cached; at most ``maxHops`` levels.
public final class ParentMap: Sendable {
    public static let maxHops = 64
    /// Bound of the map (a cache: unknown parents are fetched again). Beyond it the map
    /// starts over, so a huge tree never makes every flush a multi-MB rewrite.
    public static let maxEntries = 50_000

    struct Entry: Codable, Sendable, Equatable {
        /// Parent id.
        var p: String
        /// Last reported "kept offline" state; `nil` = never reported with a policy.
        var k: Bool?
    }

    let map: SharedJSONMap<Entry>

    /// - Parameter fileURL: where the map is persisted; `nil` keeps it in memory.
    public init(fileURL: URL?) {
        map = SharedJSONMap(fileURL: fileURL)
    }

    private init(map: SharedJSONMap<Entry>) { self.map = map }

    public var fileURL: URL? { map.fileURL }

    /// One instance per file in this process.
    public static func shared(at url: URL) -> ParentMap { ParentMap(map: .shared(at: url)) }

    public func parent(of id: String) -> String? { map.read { $0[id]?.p } }

    /// Records the parents of the folders among `items` (files are skipped).
    public func record(_ items: [SyncItem]) {
        let folders = items.filter(\.isFolder)
        guard !folders.isEmpty else { return }
        map.mutate { entries in
            if entries.count + folders.count > Self.maxEntries {
                Log.pinning.info("parent map above \(Self.maxEntries, privacy: .public) folders: starting over")
                entries.removeAll()
            }
            for item in folders {
                guard let parent = item.parentId else { continue }
                entries[item.id, default: Entry(p: parent)].p = parent
            }
        }
    }

    /// Forgets everything (no pins left: nothing needs resolving).
    public func removeAll() {
        map.mutate { entries in if !entries.isEmpty { entries.removeAll() } }
    }

    public var count: Int { map.read(\.count) }

    /// Remembers that `id` was reported kept (`true`) or not; returns `true` when this flips
    /// a previously reported state (its descendants then need re-reporting). A folder without
    /// a recorded state (new, or forgotten when the map was cleared) never counts as a flip.
    @discardableResult
    public func notePolicy(_ id: String, kept: Bool) -> Bool {
        map.mutate { entries in
            guard var entry = entries[id] else { return false }
            let flipped = entry.k.map { $0 != kept } ?? false
            entry.k = kept
            entries[id] = entry
            return flipped
        }
    }

    /// Forgets deleted folders and every recorded descendant.
    public func remove(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        map.mutate { entries in
            var gone = Set(ids.filter { entries[$0] != nil })
            guard !gone.isEmpty else { return }
            var children: [String: [String]] = [:]
            for (id, entry) in entries { children[entry.p, default: []].append(id) }
            var queue = Array(gone)
            while let id = queue.popLast() {
                for child in children[id] ?? [] where gone.insert(child).inserted { queue.append(child) }
            }
            for id in gone { entries.removeValue(forKey: id) }
        }
    }

    /// Forgets every recorded folder below `parents` (e.g. the root of a lost space, which
    /// is never recorded itself); returns the ids removed.
    @discardableResult
    public func removeDescendants(of parents: [String]) -> [String] {
        let parents = Set(parents)
        guard !parents.isEmpty else { return [] }
        let top = map.read { entries in entries.compactMap { parents.contains($0.value.p) ? $0.key : nil } }
        guard !top.isEmpty else { return [] }
        let before = Set(map.read { Array($0.keys) })
        remove(top)
        let after = Set(map.read { Array($0.keys) })
        return Array(before.subtracting(after))
    }

    /// Persists pending changes.
    public func flush() { map.flush() }

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
