import CryptoKit
import Foundation
import os
import SyncletKit

/// Opened files in `Library/Caches` (spec §2.5): one entry per item, valid only for its
/// content version, LRU by access date with an upper limit.
///
/// Layout: `<directory>/<server>-<itemId>/<version>/<item name>` – the file keeps the item's
/// name so QuickLook picks the right type. The entry folder's modification date is its last
/// access. Another version of the item is a miss and replaces the old entry.
actor FileCache {
    static let shared = FileCache(directory: URL.cachesDirectory.appending(path: "files", directoryHint: .isDirectory))

    let directory: URL
    let limitBytes: Int64
    private var inFlight: [String: Task<URL, Error>] = [:]

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "filecache")

    init(directory: URL, limitBytes: Int64 = 1_000_000_000) {
        self.directory = directory
        self.limitBytes = limitBytes
    }

    /// The local copy of `item`'s current version, downloaded first when needed (`progress`
    /// follows the transfer).
    func localURL(for item: SyncItem, api: SyncAPIClient, progress: Progress) async throws -> URL {
        let entry = directory.appending(path: ThumbnailCache.key(for: item, api: api), directoryHint: .isDirectory)
        let version = Self.versionKey(for: item)
        let versionDirectory = entry.appending(path: version, directoryHint: .isDirectory)
        let destination = versionDirectory.appending(path: Self.fileName(for: item))

        if let hit = existingFile(in: versionDirectory, want: destination) {
            touch(entry)
            progress.totalUnitCount = 1
            progress.completedUnitCount = 1
            return hit
        }

        let flightKey = entry.path + "/" + version
        if let running = inFlight[flightKey] {
            return try await running.value
        }
        // Unstructured so that a second caller can join it; the first caller's cancellation
        // (download sheet closed) cancels the transfer.
        let task = Task { try await self.download(item: item, api: api, entry: entry,
                                                   versionDirectory: versionDirectory,
                                                   destination: destination, progress: progress) }
        inFlight[flightKey] = task
        defer { inFlight[flightKey] = nil }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// Removes every cached file (settings „Cache leeren“).
    func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: - Internals

    static func versionKey(for item: SyncItem) -> String {
        let raw = item.version.map { "v\($0)" } ?? item.contentEtag ?? item.etag
        return raw.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? String($0) : "_" }.joined()
    }

    /// The item name as a file name (no path separators, never empty or a dot name).
    static func fileName(for item: SyncItem) -> String {
        let name = item.name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\0", with: "")
        return name.isEmpty || name == "." || name == ".." ? "file" : name
    }

    /// The stored file of this version; renamed to the current item name if that changed.
    private func existingFile(in versionDirectory: URL, want destination: URL) -> URL? {
        let fm = FileManager.default
        if fm.fileExists(atPath: destination.path) { return destination }
        guard let files = try? fm.contentsOfDirectory(at: versionDirectory, includingPropertiesForKeys: nil),
              let file = files.first(where: { !$0.lastPathComponent.hasPrefix(".") }) else { return nil }
        do {
            try fm.moveItem(at: file, to: destination)
            return destination
        } catch {
            return nil
        }
    }

    private func download(item: SyncItem, api: SyncAPIClient, entry: URL, versionDirectory: URL,
                          destination: URL, progress: Progress) async throws -> URL {
        let fm = FileManager.default
        // Another version (or a broken entry) goes first.
        try? fm.removeItem(at: entry)
        try fm.createDirectory(at: versionDirectory, withIntermediateDirectories: true)
        let partial = versionDirectory.appending(path: ".download-\(UUID().uuidString)")
        do {
            _ = try await api.downloadContent(itemID: item.id, to: partial, progress: progress)
            try fm.moveItem(at: partial, to: destination)
        } catch {
            try? fm.removeItem(at: entry)
            throw error
        }
        touch(entry)
        evict(keeping: entry)
        return destination
    }

    private func touch(_ entry: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: entry.path)
    }

    /// Removes the least recently used entries while over the limit (never `keeping`).
    private func evict(keeping: URL) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return }
        var sized: [(url: URL, date: Date, size: Int64)] = entries.map { entry in
            let date = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return (entry, date, Self.size(of: entry))
        }
        var total = sized.reduce(0) { $0 + $1.size }
        guard total > limitBytes else { return }
        sized.sort { $0.date < $1.date }
        for entry in sized where entry.url.standardizedFileURL != keeping.standardizedFileURL {
            try? fm.removeItem(at: entry.url)
            total -= entry.size
            Self.log.debug("evicted \(entry.url.lastPathComponent, privacy: .public)")
            if total <= limitBytes { break }
        }
    }

    private static func size(of entry: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(at: entry, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        }
        return total
    }
}
