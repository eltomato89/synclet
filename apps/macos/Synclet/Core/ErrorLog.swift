import Foundation
import SyncletKit

/// One line of the error log ("Letzte Probleme" in the menu).
struct ErrorLogEntry: Codable, Equatable, Hashable, Identifiable, Sendable {
    var date: Date
    /// `StoredAccount.key` (`<serverId>:<userId>`).
    var accountKey: String
    var fileName: String
    /// User-facing text, localized (de/en) by the extension when it was written.
    var message: String
    /// `SyncProblem.Code` raw value: `too_large`, `insufficient_storage`, `invalid_name`,
    /// `permission`, `conflict_copy`.
    var code: String
    /// File Provider item to reveal in Finder (optional).
    var itemIdentifier: String?
    /// Extra text of the message (a conflict copy's name).
    var detail: String?

    var id: String { "\(date.timeIntervalSince1970)|\(accountKey)|\(code)|\(fileName)" }
    /// A conflict copy is information, not an error.
    var isInfo: Bool { code == "conflict_copy" }

    /// The message in the reader's language (the app's), rebuilt from `code`; the stored
    /// `message` (the writer's language) only for codes this build does not know.
    var localizedMessage: String {
        guard let known = SyncProblem.Code(rawValue: code) else { return message }
        return SyncProblem(code: known, fileName: fileName, itemIdentifier: itemIdentifier, detail: detail).message()
    }
}

/// The last ``capacity`` user-visible problems, shared by the File Provider extension
/// (writer) and the menu bar app (reader) as JSON lines in the app group:
/// `<container>/error-log.jsonl`.
///
/// Both targets compile this file. Appends take an exclusive `flock` on
/// `error-log.jsonl.lock` (several extension processes, one per domain, may write at once)
/// and replace the file atomically, so a reader never sees a partial line. Lines that do not
/// decode are skipped. An entry for the same account, file and code replaces the older one,
/// so the system's retries of a failing upload do not flood the list. After a change the
/// writer posts the Darwin notification ``notificationName``.
struct ErrorLog: Sendable {
    static let capacity = 20
    static let fileName = "error-log.jsonl"
    static let notificationName = "tech.jensk.synclet.errorLogChanged"

    let url: URL
    private var lockURL: URL { url.appendingPathExtension("lock") }

    /// `container`: root of the app group container (parent of `accounts/`).
    init(container: URL) {
        url = container.appending(path: Self.fileName, directoryHint: .notDirectory)
    }

    // MARK: - Reading

    /// Oldest first.
    func entries() -> [ErrorLogEntry] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return Self.decode(data)
    }

    static func decode(_ data: Data) -> [ErrorLogEntry] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return data.split(separator: UInt8(ascii: "\n")).compactMap { line in
            try? decoder.decode(ErrorLogEntry.self, from: Data(line))
        }
    }

    // MARK: - Writing

    /// Appends an entry (replacing one with the same account, file and code) and keeps the
    /// newest ``capacity``.
    func append(_ entry: ErrorLogEntry, post: Bool = true) {
        update(post: post) { entries in
            entries.removeAll { $0.accountKey == entry.accountKey && $0.fileName == entry.fileName && $0.code == entry.code }
            entries.append(entry)
        }
    }

    /// Removes the entries of an account (sign-out).
    func remove(accountKey: String, post: Bool = true) {
        update(post: post) { $0.removeAll { $0.accountKey == accountKey } }
    }

    func clear(post: Bool = true) {
        update(post: post) { $0.removeAll() }
    }

    private func update(post: Bool, _ change: (inout [ErrorLogEntry]) -> Void) {
        let changed = withLock { () -> Bool in
            var entries = self.entries()
            let before = entries
            change(&entries)
            if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
            guard entries != before else { return false }
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            var data = Data()
            for entry in entries {
                guard let line = try? encoder.encode(entry) else { continue }
                data.append(line)
                data.append(UInt8(ascii: "\n"))
            }
            do {
                try data.write(to: url, options: .atomic)
                return true
            } catch {
                return false
            }
        }
        if changed && post { Self.postNotification() }
    }

    /// Runs `body` under an exclusive `flock` (blocking) on the lock file. Without a lock
    /// file (directory missing) the body runs unlocked and its write fails the same way.
    private func withLock<T>(_ body: () -> T) -> T {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(lockURL.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard fd >= 0 else { return body() }
        defer { close(fd) }
        while flock(fd, LOCK_EX) != 0 && errno == EINTR {}
        defer { flock(fd, LOCK_UN) }
        return body()
    }

    static func postNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(notificationName as CFString), nil, nil, true
        )
    }
}
