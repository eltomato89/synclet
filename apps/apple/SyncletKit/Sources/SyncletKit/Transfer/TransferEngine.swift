import CryptoKit
import Foundation

/// Uploads file content (SYNC_API.md §6.3, §6.4, §7; design spec §2.6).
///
/// - New files up to `threshold` (32 MiB): `POST /items/upload` in one request.
/// - New files above: tus 1.0 in chunks of ``TusUploader/chunkSize`` (16 MiB), resumable
///   across calls and engine instances through the ``UploadStateStore``.
/// - Replacing content: always `PUT /items/:id/content` with `If-Match` (any size up to
///   `maxUploadBytes`). The tus endpoint of the contract only creates new files (§7 has no
///   replace metadata), so a replace via tus would publish a second file instead of a new
///   version; a `412` surfaces as ``SyncAPIError/conflict(current:)``.
///
/// Duplicates: an existing file of the same name with identical content (size + sha256)
/// is reused instead of uploading again. When a resumed upload is gone on the server
/// (`404`/`410`), the engine first looks for the published file (the final `PATCH` may
/// have succeeded while its response was lost) before starting over, so a lost response
/// never produces a `"<name> (2)"` copy.
///
/// `progress.totalUnitCount` is set to the file size; tus uploads update
/// `completedUnitCount` after every chunk.
public final class TransferEngine: Sendable {
    public static let defaultThreshold = 32 << 20
    /// Retries of a `PATCH` answered with `423` (upload being published).
    public static let busyRetries = 5
    public static let busyDelay: Duration = .seconds(2)

    public let api: SyncAPIClient
    public let tus: TusUploader
    public let stateStore: UploadStateStore
    public let threshold: Int
    private let sleep: @Sendable (Duration) async throws -> Void
    private let now: @Sendable () -> Date

    public init(api: SyncAPIClient, tus: TusUploader, stateDir: URL, threshold: Int = TransferEngine.defaultThreshold,
                now: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.api = api
        self.tus = tus
        self.stateStore = UploadStateStore(directory: stateDir, now: now)
        self.threshold = threshold
        self.sleep = sleep
        self.now = now
        // Drop state of uploads abandoned for more than 24 h (the server expired them too).
        stateStore.purgeExpired()
    }

    /// Convenience: tus with the default chunk size.
    public convenience init(api: SyncAPIClient, stateDir: URL) {
        self.init(api: api, tus: TusUploader(api: api), stateDir: stateDir)
    }

    // MARK: - Public

    /// Uploads `file` as a new file `name` into `parentId`. On a name collision the server
    /// picks a free name (see `name` of the result), unless the existing file has identical
    /// content, which is returned instead.
    ///
    /// - Parameters:
    ///   - resumeKey: identifies the upload across calls (``UploadStateStore/key(itemIdentifier:contentVersion:)``);
    ///     default: derived from the target.
    ///   - reuseIdentical: `false` ⇒ never reuse an existing file (conflict copies); a
    ///     collision always gets a free name.
    public func upload(file: URL, newIn parentId: String, name: String, modifiedAt: Date?,
                       progress: Progress? = nil, resumeKey: String? = nil,
                       reuseIdentical: Bool = true) async throws -> SyncItem {
        let info = try Self.fileInfo(file)
        progress?.totalUnitCount = info.size
        if info.size <= Int64(threshold) {
            if !reuseIdentical {
                return try await api.uploadNewFile(parentID: parentId, name: name, from: file, onConflict: .rename,
                                                   modifiedAt: modifiedAt, progress: progress)
            }
            return try await uploadSingle(file: file, parentId: parentId, name: name,
                                          modifiedAt: modifiedAt, progress: progress)
        }
        let key = resumeKey ?? UploadStateStore.key(itemIdentifier: "new:\(parentId)/\(name)", contentVersion: "")
        let target = TusUploadMetadata(name: name, parentId: parentId, onConflict: .rename, modifiedAt: modifiedAt)
        return try await uploadTus(file: file, info: info, target: target, key: key, reuseIdentical: reuseIdentical,
                                   progress: progress)
    }

    /// Replaces the content of `itemId`, based on `baseEtag` (`*` = any version).
    /// - Throws: ``SyncAPIError/conflict(current:)`` when the server has another version.
    public func replace(file: URL, itemId: String, baseEtag: String, modifiedAt: Date?,
                        progress: Progress? = nil) async throws -> SyncItem {
        let info = try Self.fileInfo(file)
        progress?.totalUnitCount = info.size
        return try await api.replaceContent(itemID: itemId, from: file, ifMatch: baseEtag,
                                            modifiedAt: modifiedAt, progress: progress)
    }

    // MARK: - Single request

    private func uploadSingle(file: URL, parentId: String, name: String, modifiedAt: Date?,
                              progress: Progress?) async throws -> SyncItem {
        do {
            return try await api.uploadNewFile(parentID: parentId, name: name, from: file, onConflict: .fail,
                                               modifiedAt: modifiedAt, progress: progress)
        } catch SyncAPIError.nameConflict(let existing?) where !existing.isFolder
                    && existing.sha256 != nil && existing.sha256 == (try? Self.sha256(of: file)) {
            return existing
        } catch SyncAPIError.nameConflict {
            return try await api.uploadNewFile(parentID: parentId, name: name, from: file, onConflict: .rename,
                                               modifiedAt: modifiedAt, progress: progress)
        }
    }

    // MARK: - tus

    private func uploadTus(file: URL, info: FileInfo, target: TusUploadMetadata, key: String, reuseIdentical: Bool,
                           progress: Progress?) async throws -> SyncItem {
        let localHash = LazyHash(file: file)
        var upload: (url: URL, offset: Int64)?
        var resumed = false

        // 1. Resume a stored upload when the local file and the target are unchanged.
        if let state = stateStore.load(key: key) {
            if state.fileSize == info.size, state.length == info.size, state.fileMtime == info.mtime,
               state.target == target {
                do {
                    upload = (state.uploadURL, try await tus.head(state.uploadURL).offset)
                    resumed = true
                    Log.transfer.info("resuming upload at \(upload?.offset ?? 0, privacy: .public)/\(info.size, privacy: .public)")
                } catch let error as SyncAPIError where Self.isUploadGone(error) {
                    stateStore.remove(key: key)
                    if let published = try await findIdentical(target: target, size: info.size, hash: localHash,
                                                               allowSuffixed: true) {
                        Log.transfer.info("upload gone on the server, found the published file")
                        progress?.completedUnitCount = info.size
                        return published
                    }
                    Log.transfer.info("upload gone on the server, starting over")
                }
            } else {
                Log.transfer.info("local file or target changed, discarding the stored upload")
                try? await tus.terminate(state.uploadURL)
                stateStore.remove(key: key)
            }
        }

        var restarts = 0
        while true {
            // 2. Start a new upload (reusing an identical existing file of the same name).
            if upload == nil {
                if reuseIdentical, let existing = try await findIdentical(target: target, size: info.size, hash: localHash,
                                                          allowSuffixed: false) {
                    progress?.completedUnitCount = info.size
                    return existing
                }
                switch try await tus.create(length: info.size, metadata: target) {
                case .completed(let item):
                    progress?.completedUnitCount = info.size
                    return item
                case .created(let url):
                    try stateStore.save(UploadState(uploadURL: url, length: info.size, fileSize: info.size,
                                                    fileMtime: info.mtime, target: target, createdAt: now()),
                                        key: key)
                    upload = (url, 0)
                }
            }
            guard let current = upload else { continue }

            // 3. Send the chunks.
            do {
                let item = try await sendChunks(file: file, info: info, url: current.url, offset: current.offset,
                                                key: key, target: target, hash: localHash, progress: progress)
                stateStore.remove(key: key)
                let verified = try await verify(item, file: file, info: info, target: target, resumed: resumed, hash: localHash)
                progress?.completedUnitCount = info.size
                return verified
            } catch let error as SyncAPIError where Self.isUploadGone(error) && restarts == 0 {
                // Expired (410) or unknown (404) while patching: start over once.
                restarts += 1
                stateStore.remove(key: key)
                upload = nil
                resumed = false
                Log.transfer.info("upload gone while patching, starting over")
            }
        }
    }

    /// PATCH loop from `offset` to the end. Returns the published item.
    private func sendChunks(file: URL, info: FileInfo, url: URL, offset start: Int64, key: String,
                            target: TusUploadMetadata, hash: LazyHash, progress: Progress?) async throws -> SyncItem {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var offset = start
        var busy = 0
        var mismatches = 0
        while true {
            try Task.checkCancellation()
            progress?.completedUnitCount = offset
            // The file must not change under a running upload (that would publish mixed content).
            let now = try Self.fileInfo(file)
            if now.size != info.size || now.mtime != info.mtime {
                try? await tus.terminate(url)
                stateStore.remove(key: key)
                throw CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: "The file changed during the upload."])
            }
            let count = Int(min(Int64(tus.chunkSize), info.size - offset))
            try handle.seek(toOffset: UInt64(offset))
            let chunk = count > 0 ? (try handle.read(upToCount: count) ?? Data()) : Data()
            guard chunk.count == count else { throw CocoaError(.fileReadUnknown) }

            do {
                switch try await tus.patch(url, offset: offset, chunk: chunk) {
                case .completed(let item):
                    return item
                case .offset(let next):
                    offset = next
                    busy = 0
                }
            } catch SyncAPIError.http(status: 423, _, _) where busy < Self.busyRetries {
                // Being published by a concurrent request: wait and check (HEAD is not blocked).
                busy += 1
                try await sleep(Self.busyDelay)
                do {
                    offset = try await tus.head(url).offset
                } catch let error as SyncAPIError where Self.isUploadGone(error) {
                    // The concurrent request published it and the server dropped the upload.
                    stateStore.remove(key: key)
                    if let published = try await findIdentical(target: target, size: info.size, hash: hash,
                                                               allowSuffixed: true) {
                        return published
                    }
                    throw error
                }
            } catch SyncAPIError.http(status: 409, code: nil, _) where mismatches < 3 {
                // Offset mismatch (plain-text tus error): re-sync with HEAD.
                mismatches += 1
                offset = try await tus.head(url).offset
            }
        }
    }

    // MARK: - Helpers

    static func isUploadGone(_ error: SyncAPIError) -> Bool {
        switch error {
        case .notFound: return true
        case .http(let status, _, _): return status == 410
        default: return false
        }
    }

    /// Guards against a resumed upload that spliced different bytes (a same-size rewrite
    /// that kept the mtime): the published size must match, and after a resume the sha256
    /// too. On a mismatch the local content is written again with `PUT` (`If-Match` = the
    /// version just published), so the server ends up with exactly the local bytes.
    private func verify(_ item: SyncItem, file: URL, info: FileInfo, target: TusUploadMetadata, resumed: Bool,
                        hash: LazyHash) async throws -> SyncItem {
        var mismatch = item.size != info.size
        if !mismatch, resumed, let serverHash = item.sha256 {
            mismatch = serverHash != (try await hash.value())
        }
        guard mismatch else { return item }
        Log.transfer.error("published upload \(item.id, privacy: .public) differs from the local file, rewriting it")
        return try await api.replaceContent(itemID: item.id, from: file, ifMatch: item.contentEtag ?? "*",
                                            modifiedAt: target.modifiedAt, progress: nil)
    }

    /// A file in `target.parentId` with the same size and sha256 whose name is `target.name`
    /// (same name key) or, with `allowSuffixed` (the "upload gone" paths: our own upload may
    /// have been published under a server-picked name), `"<base> (n).<ext>"`.
    ///
    /// On the "gone" paths a known `target.modifiedAt` must match too (the server stores the
    /// metadata value), so an unrelated identical copy is not taken for ours. Preference:
    /// the exact name; then suffixed names with `version == 1`, highest `n` first (the newest
    /// server-picked name).
    private func findIdentical(target: TusUploadMetadata, size: Int64, hash: LazyHash,
                               allowSuffixed: Bool) async throws -> SyncItem? {
        let wanted = Self.nameKey(target.name)
        let (base, ext) = Self.splitName(target.name)
        var exact: SyncItem?
        var suffixed: [(item: SyncItem, n: Int)] = []
        var pageToken: String?
        repeat {
            let page: SyncChildrenPage
            do {
                page = try await api.children(of: target.parentId, pageToken: pageToken)
            } catch SyncAPIError.notFound {
                return nil // parent gone: the create reports it
            }
            for item in page.items where !item.isFolder && item.size == size && item.sha256 != nil {
                let key = Self.nameKey(item.name)
                let n = allowSuffixed ? Self.suffixNumber(key, base: base, ext: ext) : nil
                guard key == wanted || n != nil else { continue }
                if allowSuffixed, let modifiedAt = target.modifiedAt {
                    guard let serverDate = item.modifiedDate, abs(serverDate.timeIntervalSince(modifiedAt)) < 2 else { continue }
                }
                guard item.sha256 == (try await hash.value()) else { continue }
                if key == wanted { exact = exact ?? item } else if let n { suffixed.append((item, n)) }
            }
            pageToken = page.nextPageToken
        } while pageToken != nil
        if let exact { return exact }
        return suffixed.sorted { a, b in
            let aFirst = a.item.version == 1, bFirst = b.item.version == 1
            if aFirst != bFirst { return aFirst }
            return a.n > b.n
        }.first?.item
    }

    /// `NFC(name).toLowerCase()` (§4.3).
    static func nameKey(_ name: String) -> String {
        name.precomposedStringWithCanonicalMapping.lowercased()
    }

    /// Split at the last dot that is not at position 0 (§4.3); name keys.
    static func splitName(_ name: String) -> (base: String, ext: String) {
        let key = nameKey(name)
        if let dot = key.lastIndex(of: "."), dot != key.startIndex {
            return (String(key[..<dot]), String(key[dot...]))
        }
        return (key, "")
    }

    /// `"<base> (n)<ext>"` with n ≥ 2.
    static func isSuffixed(_ key: String, base: String, ext: String) -> Bool {
        suffixNumber(key, base: base, ext: ext) != nil
    }

    /// `n` of `"<base> (n)<ext>"` (n ≥ 2), else `nil`.
    static func suffixNumber(_ key: String, base: String, ext: String) -> Int? {
        guard key.hasPrefix(base + " ("), key.hasSuffix(")" + ext),
              key.count >= base.count + ext.count + 3 else { return nil }
        let middle = key.dropFirst(base.count + 2).dropLast(ext.count + 1)
        guard let n = Int(middle), n >= 2 else { return nil }
        return n
    }

    struct FileInfo: Sendable {
        var size: Int64
        var mtime: Date
    }

    static func fileInfo(_ url: URL) throws -> FileInfo {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = attributes[.modificationDate] as? Date ?? .distantPast
        // Millisecond precision so the value survives the JSON round trip.
        return FileInfo(size: size, mtime: TusUploadMetadata.milliseconds(mtime))
    }

    /// SHA-256 (hex) of a file, read in blocks; cancellable, yields between blocks so a
    /// multi-GB file does not hog a cooperative thread.
    static func sha256Cancellable(of url: URL) async throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var blocks = 0
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
            blocks += 1
            if blocks % 16 == 0 {
                try Task.checkCancellation()
                await Task.yield()
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// SHA-256 (hex) of a file, read in blocks.
    public static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Computes the local file's sha256 only when a candidate needs comparing, at most once.
private final class LazyHash: @unchecked Sendable {
    private let file: URL
    private var cached: String?
    private let lock = NSLock()

    init(file: URL) { self.file = file }

    func value() async throws -> String {
        if let cached = lock.withLock({ cached }) { return cached }
        let hash = try await TransferEngine.sha256Cancellable(of: file)
        lock.withLock { cached = hash }
        return hash
    }
}
