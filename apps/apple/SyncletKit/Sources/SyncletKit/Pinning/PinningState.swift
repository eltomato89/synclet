import Foundation

/// An exclusive `flock` on a lock file, shared by app and extension (cross-process).
enum FileLock {
    static func withLock<T>(_ url: URL, _ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        while flock(fd, LOCK_EX) != 0 {
            guard errno == EINTR else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }
}

/// A `[String: Value]` kept in memory and persisted as JSON on ``flush()`` (atomic write,
/// only when changed). One instance per file and process (``shared(at:)``): the extension
/// rebuilds its context for every operation.
final class SharedJSONMap<Value: Codable & Sendable & Equatable>: @unchecked Sendable {
    let fileURL: URL?
    private let lock = NSLock()
    // Guarded by `lock`.
    private var storage: [String: Value]?
    private var dirty = false
    /// Identity of the directory the storage was loaded from (``DirectoryStamp``).
    private var stamp: DirectoryStamp?

    init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    static func shared(at url: URL) -> SharedJSONMap<Value> {
        sharedInstance(at: url) { SharedJSONMap<Value>(fileURL: url) }
    }

    /// Runs `body` on the loaded map; marks it dirty when `body` changed it.
    func mutate<T>(_ body: (inout [String: Value]) -> T) -> T {
        lock.withLock {
            var map = loaded()
            let before = map
            let result = body(&map)
            if map != before {
                storage = map
                dirty = true
            }
            return result
        }
    }

    func read<T>(_ body: ([String: Value]) -> T) -> T {
        lock.withLock { body(loaded()) }
    }

    /// Writes the map if it changed since the last write.
    func flush() {
        lock.withLock {
            guard dirty, let fileURL, let storage else { return }
            // The account directory is gone (signed out while an operation was in flight):
            // drop the state instead of recreating the directory.
            guard FileManager.default.fileExists(atPath: fileURL.deletingLastPathComponent().path) else {
                self.storage = nil
                dirty = false
                return
            }
            do {
                try JSONEncoder().encode(storage).write(to: fileURL, options: .atomic)
                dirty = false
            } catch {
                Log.pinning.error("\(fileURL.lastPathComponent, privacy: .public) not saved: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// Must be called with `lock` held. Reloads when the directory was removed or replaced
    /// meanwhile (sign-out and a new sign-in of the same account in a long-lived process).
    private func loaded() -> [String: Value] {
        let current = fileURL.flatMap { DirectoryStamp($0.deletingLastPathComponent()) }
        if let storage, current == stamp { return storage }
        if storage != nil { Log.pinning.info("account directory replaced: reloading \(self.fileURL?.lastPathComponent ?? "", privacy: .public)") }
        stamp = current
        dirty = false
        var result: [String: Value] = [:]
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([String: Value].self, from: data) {
            result = decoded
        }
        storage = result
        return result
    }
}

/// Inode and creation time of a directory: tells a directory apart from one removed and
/// created again at the same path. `nil` when it does not exist.
struct DirectoryStamp: Equatable, Sendable {
    let inode: UInt64
    let birthSeconds: Int
    let birthNanoseconds: Int

    init?(_ url: URL) {
        var info = stat()
        guard stat(url.path, &info) == 0 else { return nil }
        inode = UInt64(info.st_ino)
        birthSeconds = info.st_birthtimespec.tv_sec
        birthNanoseconds = info.st_birthtimespec.tv_nsec
    }
}

/// Moves an unreadable state file aside as `<name>.corrupt` (replacing an older one).
func quarantine(_ url: URL) {
    let target = url.appendingPathExtension("corrupt")
    try? FileManager.default.removeItem(at: target)
    do {
        try FileManager.default.moveItem(at: url, to: target)
    } catch {
        try? FileManager.default.removeItem(at: url)
    }
}

/// One state object per file and type in this process (generic types cannot hold static storage).
nonisolated(unsafe) private var registry: [String: AnyObject] = [:]
private let sharedRegistryLock = NSLock()

func sharedInstance<T: AnyObject>(at url: URL, make: () -> T) -> T {
    sharedRegistryLock.withLock {
        let key = "\(T.self)|\(url.path)"
        if let existing = registry[key] as? T { return existing }
        let instance = make()
        registry[key] = instance
        return instance
    }
}

/// Content versions of the files the extension reported as kept offline, so only new or
/// changed content is announced to the app (a rename or move announces nothing).
/// `accounts/<key16>/pinned-content.json`.
public final class PinnedContentLedger: Sendable {
    let map: SharedJSONMap<String>

    public init(fileURL: URL?) { map = SharedJSONMap(fileURL: fileURL) }
    private init(map: SharedJSONMap<String>) { self.map = map }

    public static func shared(at url: URL) -> PinnedContentLedger { PinnedContentLedger(map: .shared(at: url)) }

    /// Records the content version of a kept file; `true` if it is new or changed.
    @discardableResult
    public func update(id: String, version: String) -> Bool {
        map.mutate { entries in
            guard entries[id] != version else { return false }
            entries[id] = version
            return true
        }
    }

    /// Forgets files (deleted, or no longer kept offline).
    public func remove(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        map.mutate { entries in for id in ids { entries.removeValue(forKey: id) } }
    }

    public func version(of id: String) -> String? { map.read { $0[id] } }

    public func flush() { map.flush() }
}

/// Ids of new pinned content the app should download (`accounts/<key16>/pinned-downloads.json`),
/// written by the extension and drained by the app, both under a `flock`. Beyond
/// ``maxEntries`` the queue only remembers that it overflowed (the app then walks the pins).
public final class PinnedDownloadQueue: Sendable {
    public static let maxEntries = 10_000

    public struct Batch: Codable, Sendable, Equatable {
        public var ids: [String] = []
        public var overflow = false
        public init(ids: [String] = [], overflow: Bool = false) {
            self.ids = ids
            self.overflow = overflow
        }
    }

    public let fileURL: URL
    private var lockURL: URL { fileURL.appendingPathExtension("lock") }

    public init(fileURL: URL) { self.fileURL = fileURL }

    /// `accounts/<key16>/pinned-downloads.json`.
    public convenience init(accountDirectory: URL) {
        self.init(fileURL: accountDirectory.appending(path: "pinned-downloads.json", directoryHint: .notDirectory))
    }

    public func append(_ ids: [String]) throws {
        guard !ids.isEmpty else { return }
        try FileLock.withLock(lockURL) {
            var batch = read()
            var known = Set(batch.ids)
            for id in ids where known.insert(id).inserted { batch.ids.append(id) }
            if batch.ids.count > Self.maxEntries {
                batch.ids = []
                batch.overflow = true
            }
            try JSONEncoder().encode(batch).write(to: fileURL, options: .atomic)
        }
    }

    /// Takes everything queued so far.
    public func drain() throws -> Batch {
        try FileLock.withLock(lockURL) {
            let batch = read()
            if batch != Batch() { try? FileManager.default.removeItem(at: fileURL) }
            return batch
        }
    }

    /// A file that cannot be decoded is moved aside (`.corrupt`) and counts as an overflow,
    /// so the app walks the pins instead of losing the ids.
    private func read() -> Batch {
        guard let data = try? Data(contentsOf: fileURL) else { return Batch() }
        if let batch = try? JSONDecoder().decode(Batch.self, from: data) { return batch }
        Log.pinning.error("pinned-downloads.json unreadable: moved aside, falling back to a walk")
        quarantine(fileURL)
        return Batch(overflow: true)
    }
}
