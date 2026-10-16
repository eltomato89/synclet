import CryptoKit
import Foundation
import os
import SyncletKit
import UIKit

/// Server thumbnails on disk (spec §2.5): bytes plus `ETag` per item, revalidated with
/// `If-None-Match` at most once per item and app session (one instance per process), LRU by
/// access date with an upper limit.
///
/// Files: `<directory>/<server>-<itemId>.thumb` and `….etag`; the `.thumb` file's
/// modification date is its last access.
actor ThumbnailCache {
    static let shared = ThumbnailCache(directory: URL.cachesDirectory.appending(path: "thumbnails", directoryHint: .isDirectory))

    /// Size requested from the server (256 or 1024).
    static let size = 256
    /// Retry delay after "no thumbnail (yet)" (`404`/`415`) within a session.
    static let missingRetry: TimeInterval = 60

    let directory: URL
    let limitBytes: Int
    /// Item states (`key` + `contentEtag`) already checked with the server in this session.
    private var validated: Set<String> = []
    /// Items without a thumbnail, with the time of the answer.
    private var missing: [String: Date] = [:]
    private var inFlight: [String: Task<Data?, Never>] = [:]
    private let memory = NSCache<NSString, UIImage>()

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "thumbnails")

    init(directory: URL, limitBytes: Int = 200_000_000) {
        self.directory = directory
        self.limitBytes = limitBytes
        memory.countLimit = 300
    }

    /// The thumbnail of `item`; `nil` for items without one (`preview.thumbnail != true`) or
    /// when the server has none and nothing is stored.
    func image(for item: SyncItem, api: SyncAPIClient) async -> UIImage? {
        guard !item.isFolder, item.preview?.thumbnail == true else { return nil }
        let key = Self.key(for: item, api: api)
        let state = key + "|" + (item.contentEtag ?? item.etag)
        if validated.contains(state) {
            if let image = memory.object(forKey: state as NSString) {
                touch(key)
                return image
            }
            if let data = stored(key) {
                touch(key)
                return remember(data, as: state)
            }
        }
        if let since = missing[state], Date().timeIntervalSince(since) < Self.missingRetry { return nil }

        let task: Task<Data?, Never>
        if let running = inFlight[state] {
            task = running
        } else {
            task = Task { await self.fetch(item: item, key: key, state: state, api: api) }
            inFlight[state] = task
        }
        let data = await task.value
        inFlight[state] = nil
        return data.flatMap { remember($0, as: state) }
    }

    /// Removes every stored thumbnail (settings „Cache leeren“).
    func clear() {
        memory.removeAllObjects()
        validated.removeAll()
        missing.removeAll()
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: - Network

    private func fetch(item: SyncItem, key: String, state: String, api: SyncAPIClient) async -> Data? {
        let storedData = stored(key)
        let etag = storedData == nil ? nil : storedETag(key)
        do {
            if let thumbnail = try await api.thumbnail(itemID: item.id, size: Self.size, ifNoneMatch: etag) {
                write(thumbnail, key: key)
                validated.insert(state)
                missing[state] = nil
                return thumbnail.data
            }
            missing[state] = Date()
            return storedData
        } catch SyncAPIError.notModified {
            validated.insert(state)
            touch(key)
            return storedData
        } catch {
            Self.log.debug("thumbnail \(item.id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            if storedData != nil { touch(key) }
            return storedData
        }
    }

    private func remember(_ data: Data, as state: String) -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: state as NSString)
        return image
    }

    // MARK: - Disk

    /// Server-scoped item key (ids of two servers may collide).
    static func key(for item: SyncItem, api: SyncAPIClient) -> String {
        let server = SHA256.hash(data: Data(api.baseURL.absoluteString.utf8)).prefix(6)
            .map { String(format: "%02x", $0) }.joined()
        let id = item.id.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? String($0) : "_" }.joined()
        return "\(server)-\(id)"
    }

    private func dataURL(_ key: String) -> URL { directory.appending(path: key + ".thumb") }
    private func etagURL(_ key: String) -> URL { directory.appending(path: key + ".etag") }

    private func stored(_ key: String) -> Data? {
        try? Data(contentsOf: dataURL(key))
    }

    private func storedETag(_ key: String) -> String? {
        (try? String(contentsOf: etagURL(key), encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
    }

    private func write(_ thumbnail: SyncThumbnail, key: String) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            try thumbnail.data.write(to: dataURL(key), options: .atomic)
            if let etag = thumbnail.etag {
                try Data(etag.utf8).write(to: etagURL(key), options: .atomic)
            } else {
                try? fm.removeItem(at: etagURL(key))
            }
            touch(key)
            evict(keeping: key)
        } catch {
            Self.log.error("storing thumbnail failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func touch(_ key: String) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dataURL(key).path)
    }

    /// Removes the least recently used thumbnails while over the limit (never `keeping`).
    private func evict(keeping: String) {
        let fm = FileManager.default
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .totalFileAllocatedSizeKey, .fileSizeKey]
        guard let files = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) else { return }
        var entries: [(key: String, date: Date, size: Int)] = []
        var total = 0
        for file in files where file.pathExtension == "thumb" {
            let values = try? file.resourceValues(forKeys: keys)
            let size = values?.fileSize ?? 0
            total += size
            entries.append((file.deletingPathExtension().lastPathComponent, values?.contentModificationDate ?? .distantPast, size))
        }
        guard total > limitBytes else { return }
        for entry in entries.sorted(by: { $0.date < $1.date }) where entry.key != keeping {
            try? fm.removeItem(at: dataURL(entry.key))
            try? fm.removeItem(at: etagURL(entry.key))
            total -= entry.size
            if total <= limitBytes { break }
        }
    }
}
