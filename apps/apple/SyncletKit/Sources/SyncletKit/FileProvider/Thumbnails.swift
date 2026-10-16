import CoreGraphics
import FileProvider
import Foundation
import Synchronization

/// The thumbnail sizes the server renders (SYNC_API.md §9.1).
public enum ThumbnailSize {
    public static let buckets = [256, 1024]

    /// The server size nearest to the longer edge of `requested` (a tie picks the larger,
    /// sharper one).
    public static func bucket(for requested: CGSize) -> Int {
        let edge = Double(max(requested.width, requested.height))
        var best = buckets[0]
        for size in buckets where abs(Double(size) - edge) <= abs(Double(best) - edge) {
            best = size
        }
        return best
    }
}

/// On-disk thumbnail cache: one file per item and size, `<directory>/<itemId>-<size>.webp`,
/// with the server's thumbnail ETag (`"<sha256>-<size>"`, SYNC_API.md §9.1) in the extended
/// attribute ``etagAttribute``. Least recently used files are evicted above ``maxBytes``.
///
/// The ETag is the validator: the fetcher revalidates with `If-None-Match`, so a new content
/// version replaces the file (no stale files for old versions) without an item lookup. A hit
/// refreshes the file's modification date (the LRU clock). Thread safe; several instances on
/// the same directory (one per domain) stay correct because the size is re-measured before
/// evicting.
///
/// Also keeps a short in-memory negative cache ("no thumbnail", 404/415/400) so Finder's
/// repeated requests for types without thumbnails do not each reach the server.
public final class ThumbnailCache: Sendable {
    public static let defaultMaxBytes: Int64 = 200 * 1024 * 1024
    /// How long a "no thumbnail" answer is remembered: `415`/`400` always, and a `404` once
    /// ``notRenderedBackoff`` is used up.
    public static let missingTTL: TimeInterval = 10 * 60
    /// `404` means "not rendered yet" for a new file (SYNC_API.md §9.1: poll with backoff):
    /// the n-th consecutive 404 of an item and size is remembered this long, then
    /// ``missingTTL``. A `200`/`304` resets the item.
    public static let notRenderedBackoff: [TimeInterval] = [2, 5, 15, 60, 5 * 60]
    static let etagAttribute = "tech.jensk.synclet.thumbnail-etag"

    public struct Entry: Sendable, Hashable {
        public var data: Data
        /// The server's thumbnail ETag (unquoted); `nil` when it was not stored.
        public var etag: String?
    }

    public let directory: URL
    public let maxBytes: Int64
    private let now: @Sendable () -> Date
    private let state = Mutex<Int64?>(nil) // approximate bytes on disk; nil = not measured yet
    private struct Missing { var expiry: Date; var strikes: Int }
    private let missing = Mutex<[String: Missing]>([:]) // "<id>-<size>" → negative entry

    public init(directory: URL, maxBytes: Int64 = ThumbnailCache.defaultMaxBytes,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.maxBytes = maxBytes
        self.now = now
    }

    /// `Library/Caches/thumbnails` of the running process (the extension's container).
    public static func defaultDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appending(path: "thumbnails", directoryHint: .isDirectory)
    }

    /// One cache per directory and process, shared by the extension instances.
    public static func shared(directory: URL) -> ThumbnailCache {
        registry.withLock { caches in
            if let cache = caches[directory.standardizedFileURL.path] { return cache }
            let cache = ThumbnailCache(directory: directory)
            caches[directory.standardizedFileURL.path] = cache
            return cache
        }
    }

    private static let registry = Mutex<[String: ThumbnailCache]>([:])

    /// Removes the caches of signed-out accounts below `base` (every subdirectory whose name
    /// is not in `keeping`) and loose files of the earlier, unscoped layout.
    public static func purge(base: URL, keeping key16s: Set<String>) {
        let fm = FileManager.default
        let entries = (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        for entry in entries where !key16s.contains(entry.lastPathComponent) {
            try? fm.removeItem(at: entry)
        }
        registry.withLock { caches in
            for path in caches.keys where URL(filePath: path).deletingLastPathComponent().standardizedFileURL.path
                == base.standardizedFileURL.path && !key16s.contains(URL(filePath: path).lastPathComponent) {
                caches[path] = nil
            }
        }
    }

    /// `<itemId>-<size>.webp` with every character outside `[A-Za-z0-9._-]` percent-encoded
    /// (no `/` or `:` from an id reaches the file system).
    public static func fileName(itemID: String, size: Int) -> String {
        "\(safe(itemID))-\(size).webp"
    }

    private static let allowed: CharacterSet = {
        var set = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        set.insert(charactersIn: "._-")
        return set
    }()

    private static func safe(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "_"
    }

    private func url(itemID: String, size: Int) -> URL {
        directory.appending(path: Self.fileName(itemID: itemID, size: size), directoryHint: .notDirectory)
    }

    // MARK: Files

    /// The cached thumbnail and its ETag, or `nil`. Does not count as a use (see ``touch``).
    public func entry(itemID: String, size: Int) -> Entry? {
        let file = url(itemID: itemID, size: size)
        guard let data = try? Data(contentsOf: file) else { return nil }
        return Entry(data: data, etag: Self.readETag(file))
    }

    /// Marks a cached thumbnail as recently used (LRU).
    public func touch(itemID: String, size: Int) {
        try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: url(itemID: itemID, size: size).path)
    }

    /// Writes (or replaces) a thumbnail with its ETag and evicts the least recently used
    /// ones above the limit.
    public func store(_ data: Data, etag: String?, itemID: String, size: Int) {
        let fm = FileManager.default
        let file = url(itemID: itemID, size: size)
        let previous = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            if let etag { Self.writeETag(etag, to: file) }
        } catch {
            Log.fileProvider.error("thumbnail cache write failed: \(String(describing: error), privacy: .public)")
            return
        }
        let needsEviction = state.withLock { known -> Bool in
            // First store: measure the directory (it already holds the new file).
            let total = known.map { $0 - previous + Int64(data.count) } ?? measure()
            known = total
            return total > maxBytes
        }
        if needsEviction { evict() }
    }

    /// Deletes a cached thumbnail (the server has none any more).
    public func remove(itemID: String, size: Int) {
        let file = url(itemID: itemID, size: size)
        let previous = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        guard (try? FileManager.default.removeItem(at: file)) != nil else { return }
        state.withLock { known in known = known.map { $0 - previous } }
    }

    /// Deletes the least recently used files until the cache fits into 90 % of the limit.
    func evict() {
        state.withLock { known in
            let fm = FileManager.default
            let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
            let files = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
            var entries = files.compactMap { file -> (url: URL, date: Date, size: Int64)? in
                guard let values = try? file.resourceValues(forKeys: Set(keys)) else { return nil }
                return (file, values.contentModificationDate ?? .distantPast, Int64(values.fileSize ?? 0))
            }
            var total = entries.reduce(0) { $0 + $1.size }
            let target = maxBytes - maxBytes / 10
            entries.sort { $0.date < $1.date }
            for entry in entries where total > target {
                try? fm.removeItem(at: entry.url)
                total -= entry.size
            }
            known = total
        }
    }

    private func measure() -> Int64 {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    private static func readETag(_ file: URL) -> String? {
        file.withUnsafeFileSystemRepresentation { path -> String? in
            guard let path else { return nil }
            let length = getxattr(path, etagAttribute, nil, 0, 0, 0)
            guard length > 0 else { return nil }
            var buffer = [UInt8](repeating: 0, count: length)
            guard getxattr(path, etagAttribute, &buffer, length, 0, 0) == length else { return nil }
            return String(decoding: buffer, as: UTF8.self)
        }
    }

    private static func writeETag(_ etag: String, to file: URL) {
        file.withUnsafeFileSystemRepresentation { path in
            guard let path else { return }
            let bytes = Array(etag.utf8)
            _ = setxattr(path, etagAttribute, bytes, bytes.count, 0, 0)
        }
    }

    // MARK: Negative cache

    /// Why the server has no thumbnail.
    public enum MissingReason: Sendable {
        /// `404`: maybe not rendered yet ⇒ escalating backoff.
        case notRendered
        /// `415`/`400`: never (unsupported type, folder) ⇒ ``missingTTL``.
        case unsupported
    }

    /// Whether the server recently said there is no thumbnail (in memory only). An expired
    /// entry keeps its strike count, so the next 404 escalates.
    public func isKnownMissing(itemID: String, size: Int) -> Bool {
        let key = "\(itemID)-\(size)", current = now()
        return missing.withLock { $0[key].map { $0.expiry > current } ?? false }
    }

    /// Remembers a "no thumbnail" answer; returns how long it is remembered.
    @discardableResult
    public func markMissing(itemID: String, size: Int, reason: MissingReason) -> TimeInterval {
        let key = "\(itemID)-\(size)", current = now()
        return missing.withLock { entries in
            if entries.count > 10_000 {
                entries = entries.filter { $0.value.expiry > current.addingTimeInterval(-Self.missingTTL) }
            }
            let strikes = (entries[key]?.strikes ?? 0) + 1
            let ttl: TimeInterval
            switch reason {
            case .notRendered:
                ttl = strikes <= Self.notRenderedBackoff.count ? Self.notRenderedBackoff[strikes - 1] : Self.missingTTL
            case .unsupported:
                ttl = Self.missingTTL
            }
            entries[key] = Missing(expiry: current.addingTimeInterval(ttl), strikes: strikes)
            return ttl
        }
    }

    /// The server delivered a thumbnail (`200`/`304`): forget earlier misses.
    public func clearMissing(itemID: String, size: Int) {
        _ = missing.withLock { $0.removeValue(forKey: "\(itemID)-\(size)") }
    }
}

/// Loads server thumbnails (`GET /items/:id/thumbnail`) through a ``ThumbnailCache``, by
/// item id alone (no item lookup).
public struct ThumbnailFetcher: Sendable {
    public let cache: ThumbnailCache

    public init(cache: ThumbnailCache) {
        self.cache = cache
    }

    /// The webp thumbnail of an item in the server size nearest to `requestedSize`.
    ///
    /// - A cached thumbnail is revalidated with `If-None-Match` (its ETag): `304` serves the
    ///   file, `200` replaces it.
    /// - `404` (not rendered yet, or never) ⇒ `nil`, the cached file is dropped, and the item
    ///   is not asked again for 2 s, 5 s, 15 s, 60 s, 5 min, then 10 min per further 404.
    /// - `415` (unsupported type) and `400` (a folder) ⇒ `nil`, not asked again for 10 min.
    /// - A `200`/`304` resets the backoff.
    /// - Network errors serve a cached thumbnail when there is one.
    public func thumbnail(itemID: String, requestedSize: CGSize, client: SyncAPIClient) async throws -> Data? {
        let size = ThumbnailSize.bucket(for: requestedSize)
        if cache.isKnownMissing(itemID: itemID, size: size) { return nil }
        let cached = cache.entry(itemID: itemID, size: size)
        do {
            switch try await client.thumbnailResult(itemID: itemID, size: size,
                                                    ifNoneMatch: cached?.data != nil ? cached?.etag : nil) {
            case .thumbnail(let thumbnail):
                cache.clearMissing(itemID: itemID, size: size)
                cache.store(thumbnail.data, etag: thumbnail.etag, itemID: itemID, size: size)
                return thumbnail.data
            case .notRendered:
                noThumbnail(itemID: itemID, size: size, reason: .notRendered)
                return nil
            case .unsupported:
                noThumbnail(itemID: itemID, size: size, reason: .unsupported)
                return nil
            }
        } catch SyncAPIError.notModified {
            cache.clearMissing(itemID: itemID, size: size)
            cache.touch(itemID: itemID, size: size)
            return cached?.data
        } catch SyncAPIError.notFound {
            noThumbnail(itemID: itemID, size: size, reason: .notRendered)
            return nil
        } catch SyncAPIError.invalidRequest, SyncAPIError.http(status: 400, _, _) {
            noThumbnail(itemID: itemID, size: size, reason: .unsupported)
            return nil
        } catch let error as SyncAPIError where error.isTransient && !error.isAuthenticationFailure {
            if let cached { return cached.data }
            throw error
        }
    }

    private func noThumbnail(itemID: String, size: Int, reason: ThumbnailCache.MissingReason) {
        cache.remove(itemID: itemID, size: size)
        cache.markMissing(itemID: itemID, size: size, reason: reason)
    }
}

// MARK: - NSFileProviderThumbnailing

extension SyncletReplicatedExtension: NSFileProviderThumbnailing {
    /// At most this many items are fetched at the same time.
    static let thumbnailConcurrency = 4

    /// The thumbnail cache of this domain (`Library/Caches/thumbnails/<key16>/`; tests: below
    /// the injected temp directory). Per account, so a sign-out can drop exactly its previews
    /// (``ThumbnailCache/purge(base:keeping:)``).
    var thumbnailFetcher: ThumbnailFetcher {
        let base = temporaryDirectoryOverride?.appending(path: "thumbnails", directoryHint: .isDirectory)
            ?? ThumbnailCache.defaultDirectory()
        return ThumbnailFetcher(cache: .shared(directory: base.appending(path: domain.identifier.rawValue,
                                                                           directoryHint: .isDirectory)))
    }

    /// Server thumbnails for Finder (spec §2.7), one `GET /thumbnail` per item (revalidated
    /// with `If-None-Match`, no item lookup). The root container and space folders get none
    /// without a request; folders (`400`) and files without a server thumbnail (`404`/`415`)
    /// get `nil` without an error. A missing sign-in fails the whole request; other failures
    /// are reported per item.
    open func fetchThumbnails(for itemIdentifiers: [NSFileProviderItemIdentifier], requestedSize size: CGSize,
                              perThumbnailCompletionHandler: @escaping (NSFileProviderItemIdentifier, Data?, Error?) -> Void,
                              completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: Int64(itemIdentifiers.count))
        let perItem = UncheckedBox(perThumbnailCompletionHandler)
        let done = UncheckedBox(completionHandler)
        let progressBox = UncheckedBox(progress)
        let lock = NSLock() // serializes the per-item callbacks and progress updates
        let task = Task { [self] in
            let context: Context
            do {
                context = try self.context()
            } catch {
                done.value(ErrorMapping.fileProviderError(error))
                return
            }
            let fetcher = thumbnailFetcher
            let work: @Sendable (NSFileProviderItemIdentifier) async -> Void = { identifier in
                let result = await Self.thumbnail(identifier, size: size, context: context, fetcher: fetcher)
                guard !Task.isCancelled else { return }
                lock.withLock {
                    perItem.value(identifier, result.data, result.error)
                    progressBox.value.completedUnitCount += 1
                }
            }
            await withTaskGroup(of: Void.self) { group in
                var pending = itemIdentifiers.makeIterator()
                for _ in 0..<Self.thumbnailConcurrency {
                    guard let identifier = pending.next() else { break }
                    group.addTask { await work(identifier) }
                }
                while await group.next() != nil {
                    if let identifier = pending.next() { group.addTask { await work(identifier) } }
                }
            }
            done.value(Task.isCancelled ? CocoaError(.userCancelled) : nil)
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    private static func thumbnail(_ identifier: NSFileProviderItemIdentifier, size: CGSize, context: Context,
                                  fetcher: ThumbnailFetcher) async -> (data: Data?, error: Error?) {
        let layout = context.layout
        guard !layout.isTopLevel(identifier), let id = layout.serverID(for: identifier) else { return (nil, nil) }
        do {
            return (try await fetcher.thumbnail(itemID: id, requestedSize: size, client: context.client), nil)
        } catch {
            return (nil, ErrorMapping.fileProviderError(error))
        }
    }
}
