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

/// On-disk thumbnail cache: `<directory>/<itemId>-<etag>-<size>.webp`, least recently used
/// files are evicted above ``maxBytes``.
///
/// The etag is the item's content etag, so a new content version never hits an old
/// thumbnail. A hit refreshes the file's modification date (the LRU clock). Thread safe;
/// several instances on the same directory (one per domain) stay correct because the size
/// is re-measured before evicting.
public final class ThumbnailCache: Sendable {
    public static let defaultMaxBytes: Int64 = 200 * 1024 * 1024

    public let directory: URL
    public let maxBytes: Int64
    private let state = Mutex<Int64?>(nil) // approximate bytes on disk; nil = not measured yet

    public init(directory: URL, maxBytes: Int64 = ThumbnailCache.defaultMaxBytes) {
        self.directory = directory
        self.maxBytes = maxBytes
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

    /// `<itemId>-<etag>-<size>.webp` with every character outside `[A-Za-z0-9._-]`
    /// percent-encoded (no `/` or `:` from an etag or id reaches the file system).
    public static func fileName(itemID: String, etag: String, size: Int) -> String {
        "\(safe(itemID))-\(safe(etag))-\(size).webp"
    }

    private static let allowed: CharacterSet = {
        var set = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        set.insert(charactersIn: "._-")
        return set
    }()

    private static func safe(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "_"
    }

    private func url(itemID: String, etag: String, size: Int) -> URL {
        directory.appending(path: Self.fileName(itemID: itemID, etag: etag, size: size), directoryHint: .notDirectory)
    }

    /// The cached bytes, or `nil`. A hit marks the file as recently used.
    public func data(itemID: String, etag: String, size: Int) -> Data? {
        let file = url(itemID: itemID, etag: etag, size: size)
        guard let data = try? Data(contentsOf: file) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return data
    }

    /// Writes a thumbnail and evicts the least recently used ones above the limit.
    public func store(_ data: Data, itemID: String, etag: String, size: Int) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url(itemID: itemID, etag: etag, size: size), options: .atomic)
        } catch {
            Log.fileProvider.error("thumbnail cache write failed: \(String(describing: error), privacy: .public)")
            return
        }
        let needsEviction = state.withLock { known -> Bool in
            // First store: measure the directory (it already holds the new file).
            let total = known.map { $0 + Int64(data.count) } ?? measure()
            known = total
            return total > maxBytes
        }
        if needsEviction { evict() }
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
}

/// Loads server thumbnails (`GET /items/:id/thumbnail`) through a ``ThumbnailCache``.
public struct ThumbnailFetcher: Sendable {
    /// File types the server renders thumbnails for (SYNC_API.md §9.1).
    public static let thumbnailExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "tif", "tiff", "bmp", "svg",
        "pdf",
        "mp4", "m4v", "mov", "webm", "mkv",
    ]

    public let cache: ThumbnailCache

    public init(cache: ThumbnailCache) {
        self.cache = cache
    }

    /// Whether asking the server can yield a thumbnail: files of a type from §9.1, or any
    /// file the server already reports a thumbnail for.
    public static func mayHaveThumbnail(_ item: SyncItem) -> Bool {
        guard item.type == .file, !item.isFolder else { return false }
        if item.preview?.thumbnail == true { return true }
        let ext = (item.name as NSString).pathExtension.lowercased()
        return thumbnailExtensions.contains(ext)
    }

    /// The webp thumbnail of `item` in the server size nearest to `requestedSize`; `nil` for
    /// folders, roots, types without thumbnails and when the server has none (404/415).
    public func thumbnail(for item: SyncItem, requestedSize: CGSize, client: SyncAPIClient) async throws -> Data? {
        guard Self.mayHaveThumbnail(item) else { return nil }
        let size = ThumbnailSize.bucket(for: requestedSize)
        let etag = item.contentEtag ?? item.sha256 ?? item.etag
        if let cached = cache.data(itemID: item.id, etag: etag, size: size) { return cached }
        guard let thumbnail = try await client.thumbnail(itemID: item.id, size: size) else { return nil }
        cache.store(thumbnail.data, itemID: item.id, etag: etag, size: size)
        return thumbnail.data
    }
}

// MARK: - NSFileProviderThumbnailing

extension SyncletReplicatedExtension: NSFileProviderThumbnailing {
    /// At most this many items are fetched at the same time.
    static let thumbnailConcurrency = 4

    /// The thumbnail cache of this process (`Library/Caches/thumbnails`; tests: below the
    /// injected temp directory).
    var thumbnailFetcher: ThumbnailFetcher {
        let directory = temporaryDirectoryOverride?.appending(path: "thumbnails", directoryHint: .isDirectory)
            ?? ThumbnailCache.defaultDirectory()
        return ThumbnailFetcher(cache: .shared(directory: directory))
    }

    /// Server thumbnails for Finder (spec §2.7). Folders, the root container and space
    /// folders get none (`nil`, no error); so do files without a server thumbnail. A missing
    /// sign-in fails the whole request; other failures are reported per item.
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
            let item = try await context.client.item(id: id)
            return (try await fetcher.thumbnail(for: item, requestedSize: size, client: context.client), nil)
        } catch SyncAPIError.notFound {
            return (nil, nil)
        } catch {
            return (nil, ErrorMapping.fileProviderError(error))
        }
    }
}
