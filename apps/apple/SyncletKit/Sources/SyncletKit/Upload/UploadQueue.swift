import Foundation

public enum UploadStatus: String, Codable, Sendable, Hashable { case waiting, uploading, done, failed }

public enum UploadFailure: String, Codable, Sendable, Hashable {
    case insufficientStorage, targetGone, signedOut, tooLarge, invalidName, network, sourceUnreadable, other
}

public struct UploadEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var accountKey: String
    public var parentId: String
    public var parentName: String
    public var name: String
    public var size: Int64
    public var status: UploadStatus
    public var failure: UploadFailure?
    public var failureMessage: String?
    public var attempts: Int
    public var nextAttemptAt: Date?
    public var tusURL: URL?
    public var tusOffset: Int64
    public var itemId: String?
    public var createdAt: Date
    public var finishedAt: Date?

    public init(id: String = UUID().uuidString, accountKey: String, parentId: String, parentName: String,
                name: String, size: Int64, status: UploadStatus = .waiting, failure: UploadFailure? = nil,
                failureMessage: String? = nil, attempts: Int = 0, nextAttemptAt: Date? = nil, tusURL: URL? = nil,
                tusOffset: Int64 = 0, itemId: String? = nil, createdAt: Date = Date(), finishedAt: Date? = nil) {
        self.id = id; self.accountKey = accountKey; self.parentId = parentId; self.parentName = parentName
        self.name = name; self.size = size; self.status = status; self.failure = failure
        self.failureMessage = failureMessage; self.attempts = attempts; self.nextAttemptAt = nextAttemptAt
        self.tusURL = tusURL; self.tusOffset = tusOffset; self.itemId = itemId
        self.createdAt = createdAt; self.finishedAt = finishedAt
    }
}

/// Persistent upload queue shared by the app and the Share extension:
///
/// ```
/// <dir>/queue.json    {"v":1,"entries":[…]}  atomic writes under flock(LOCK_EX) on queue.lock
/// <dir>/queue.lock
/// <dir>/files/<id>    private copy of the source
/// ```
///
/// Reads take `LOCK_SH`. A corrupt file or an unknown version is moved to
/// `queue.json.corrupt-<timestamp>` and the queue starts empty.
public final class UploadQueue: Sendable {
    public static let currentVersion = 1
    static let doneRetention: TimeInterval = 24 * 3600

    private let directory: URL
    private let now: @Sendable () -> Date

    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    public convenience init(appGroup: String) {
        let base: URL
        if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            base = container
        } else {
            Log.transfer.fault("app group \(appGroup, privacy: .public) unavailable; falling back to Application Support")
            base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "tech.jensk.synclet", directoryHint: .isDirectory)
        }
        self.init(directory: base.appending(path: "uploads", directoryHint: .isDirectory))
    }

    public var filesDirectory: URL { directory.appending(path: "files", directoryHint: .isDirectory) }

    public func fileURL(for id: String) -> URL {
        filesDirectory.appending(path: AccountStore.safeComponent(id), directoryHint: .notDirectory)
    }

    // MARK: API

    @discardableResult
    public func enqueue(source: URL, name: String, accountKey: String, parentId: String, parentName: String) throws -> UploadEntry {
        // The copy happens under the lock so a concurrent prune never sees it as an orphan.
        try locked(exclusive: true) {
            let id = UUID().uuidString
            let dest = fileURL(for: id)
            let fm = FileManager.default
            try fm.createDirectory(at: filesDirectory, withIntermediateDirectories: true)
            do {
                try fm.copyItem(at: source, to: dest)
                let size = (try fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? 0
                let entry = UploadEntry(id: id, accountKey: accountKey, parentId: parentId, parentName: parentName,
                                        name: name, size: size,
                                        createdAt: Date(timeIntervalSince1970: (now().timeIntervalSince1970 * 1000).rounded() / 1000))
                var entries = loadSettingAside()
                entries.append(entry)
                try write(entries)
                return entry
            } catch {
                try? fm.removeItem(at: dest)
                throw error
            }
        }
    }

    /// Newest first, after pruning.
    public func all() -> [UploadEntry] {
        let entries = (try? locked(exclusive: true) { () -> [UploadEntry] in
            var entries = loadSettingAside()
            pruneLocked(&entries)
            return entries
        }) ?? []
        return entries.reversed()
    }

    public func entry(id: String) -> UploadEntry? {
        readEntries().first { $0.id == id }
    }

    @discardableResult
    public func update(id: String, _ change: (inout UploadEntry) -> Void) -> UploadEntry? {
        try? locked(exclusive: true) { () -> UploadEntry? in
            var entries = loadSettingAside()
            guard let i = entries.firstIndex(where: { $0.id == id }) else { return nil }
            let before = entries[i]
            change(&entries[i])
            entries[i].id = id
            if entries[i] != before { try write(entries) }
            return entries[i]
        } ?? nil
    }

    public func runnable() -> [UploadEntry] {
        let t = now()
        let ready = readEntries().filter { $0.status == .waiting && ($0.nextAttemptAt.map { $0 <= t } ?? true) }
        return ready.enumerated()
            .sorted { ($0.element.createdAt, $0.offset) < ($1.element.createdAt, $1.offset) }
            .map(\.element)
    }

    public func retry(id: String) {
        update(id: id) { e in
            guard e.status == .failed else { return }
            e.status = .waiting; e.attempts = 0; e.failure = nil; e.failureMessage = nil; e.nextAttemptAt = nil
        }
    }

    public func remove(id: String) {
        removeWhere { $0.id == id }
    }

    public func removeAll(accountKey: String) {
        removeWhere { $0.accountKey == accountKey }
    }

    public func prune() {
        _ = try? locked(exclusive: true) {
            var entries = loadSettingAside()
            pruneLocked(&entries)
        }
    }

    // MARK: Internals

    private var queueURL: URL { directory.appending(path: "queue.json", directoryHint: .notDirectory) }

    private func removeWhere(_ match: (UploadEntry) -> Bool) {
        _ = try? locked(exclusive: true) {
            let entries = loadSettingAside()
            let (gone, kept) = (entries.filter(match), entries.filter { !match($0) })
            guard !gone.isEmpty else { return }
            try? write(kept)
            for e in gone { try? FileManager.default.removeItem(at: fileURL(for: e.id)) }
        }
    }

    /// Caller holds the exclusive lock. Persists when entries were dropped.
    private func pruneLocked(_ entries: inout [UploadEntry]) {
        let fm = FileManager.default
        let cutoff = now().addingTimeInterval(-Self.doneRetention)
        let before = entries.count
        entries.removeAll { $0.status == .done && ($0.finishedAt ?? $0.createdAt) < cutoff }
        if entries.count != before { try? write(entries) }
        let keep = Set(entries.filter { $0.status != .done }.map { AccountStore.safeComponent($0.id) })
        for name in (try? fm.contentsOfDirectory(atPath: filesDirectory.path)) ?? [] where !keep.contains(name) {
            try? fm.removeItem(at: filesDirectory.appending(path: name, directoryHint: .notDirectory))
        }
    }

    private enum Loaded { case entries([UploadEntry]), corrupt }

    private func load() -> Loaded {
        guard let data = try? Data(contentsOf: queueURL) else {
            return FileManager.default.fileExists(atPath: queueURL.path) ? .corrupt : .entries([])
        }
        guard let file = try? Self.decoder.decode(QueueFile.self, from: data), file.v == Self.currentVersion else { return .corrupt }
        return .entries(file.entries)
    }

    /// Caller holds the exclusive lock.
    private func loadSettingAside() -> [UploadEntry] {
        switch load() {
        case .entries(let e): return e
        case .corrupt:
            let stamp = ISO8601DateFormatter().string(from: now()).replacingOccurrences(of: ":", with: "-")
            let target = directory.appending(path: "queue.json.corrupt-\(stamp)-\(UUID().uuidString.prefix(8))")
            try? FileManager.default.moveItem(at: queueURL, to: target)
            Log.transfer.error("upload queue unreadable; set aside")
            return []
        }
    }

    private func readEntries() -> [UploadEntry] {
        let shared = try? locked(exclusive: false) { load() }
        switch shared {
        case .entries(let e): return e
        case .corrupt: return (try? locked(exclusive: true) { loadSettingAside() }) ?? []
        case nil: return []
        }
    }

    private func write(_ entries: [UploadEntry]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.encoder.encode(QueueFile(v: Self.currentVersion, entries: entries)).write(to: queueURL, options: .atomic)
    }

    private func locked<T>(exclusive: Bool, _ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fd = open(directory.appending(path: "queue.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        while flock(fd, exclusive ? LOCK_EX : LOCK_SH) != 0 {
            guard errno == EINTR else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }

    private struct QueueFile: Codable { var v: Int; var entries: [UploadEntry] }

    private static func formatter() -> ISO8601DateFormatter {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer(); try c.encode(formatter().string(from: date))
        }
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            if let date = formatter().date(from: s) ?? ISO8601DateFormatter().date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "bad date \(s)"))
        }
        return d
    }
}
