import CryptoKit
import Foundation

/// Uploads file content (SYNC_API.md §6.3, §6.4, §7; design spec §2.6).
///
/// - Up to `threshold` (32 MiB): one request – `POST /items/upload` for new files,
///   `PUT /items/:id/content` with `If-Match` for replacements.
/// - Above: tus 1.0 in chunks of ``TusUploader/chunkSize`` (16 MiB), resumable across
///   calls and engine instances through the ``UploadStateStore``. Replacements send
///   `itemId` + `ifMatch` (§7); `ifMatch: *` is not supported by tus, so such a replace
///   stays on `PUT`.
/// - A stale base etag (`412`, at creation or at completion of a tus replace, or on `PUT`)
///   surfaces as ``SyncAPIError/conflict(current:)``; the replace is never retried blindly.
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
    ///   - nameMayChange: the name is derived from something volatile (a conflict copy's name
    ///     contains the minute): a stored upload with the same key and parent resumes even
    ///     when `name` differs, and keeps the name of its first attempt.
    public func upload(file: URL, newIn parentId: String, name: String, modifiedAt: Date?,
                       progress: Progress? = nil, resumeKey: String? = nil,
                       reuseIdentical: Bool = true, nameMayChange: Bool = false) async throws -> SyncItem {
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
                                   nameMayChange: nameMayChange, progress: progress)
    }

    /// Replaces the content of `itemId`, based on `baseEtag` (`*` = any version; only via `PUT`).
    ///
    /// - Parameter resumeKey: identifies a tus replace across calls; default: item id + base etag.
    /// - Throws: ``SyncAPIError/conflict(current:)`` when the server has another version.
    public func replace(file: URL, itemId: String, baseEtag: String, modifiedAt: Date?,
                        progress: Progress? = nil, resumeKey: String? = nil) async throws -> SyncItem {
        let info = try Self.fileInfo(file)
        progress?.totalUnitCount = info.size
        let etag = SyncAPIClient.unquoted(baseEtag)
        guard info.size > Int64(threshold), Self.isVersionEtag(etag) else {
            return try await api.replaceContent(itemID: itemId, from: file, ifMatch: baseEtag,
                                                modifiedAt: modifiedAt, progress: progress)
        }
        let key = resumeKey ?? UploadStateStore.key(itemIdentifier: "replace:\(itemId)", contentVersion: etag)
        let target = TusUploadMetadata.replace(itemId: itemId, ifMatch: etag, modifiedAt: modifiedAt)
        return try await uploadTus(file: file, info: info, target: target, key: key, reuseIdentical: false,
                                   nameMayChange: false, progress: progress)
    }

    /// `v<n>` – the only etag form tus accepts for `ifMatch` (§7): `v` and ASCII digits only.
    static func isVersionEtag(_ etag: String) -> Bool {
        etag.count > 1 && etag.hasPrefix("v") && etag.dropFirst().allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// The tus upload itself is gone on the server (`404`/`410` of a tus request). Kept apart
    /// from ``SyncAPIError/notFound`` so that, for a replace, "not found" can only mean
    /// "the item was deleted" (from `GET /items/:id`) – never a lost staged upload.
    private struct UploadGone: Error {
        let underlying: SyncAPIError
    }

    /// The server lost the staged upload again: retry later (`serverUnreachable`).
    static let uploadLostError = SyncAPIError.transport(
        .resourceUnavailable, message: "The server lost the upload. It will be retried.")

    /// Runs a tus request inside the PATCH loop, turning upload-gone errors into ``UploadGone``.
    private func tusCall<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch let error as SyncAPIError where Self.isUploadGone(error) {
            throw UploadGone(underlying: error)
        }
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

    /// Result of the PATCH loop.
    private struct Completion {
        var item: SyncItem
        /// The item is the completion's own JSON body (its etag is our published version).
        var fromResponse: Bool
        /// Found after the upload was gone and already matched by size + sha256.
        var matched: Bool
    }

    private func uploadTus(file: URL, info: FileInfo, target requested: TusUploadMetadata, key: String,
                           reuseIdentical: Bool, nameMayChange: Bool, progress: Progress?) async throws -> SyncItem {
        let localHash = LazyHash(file: file)
        var target = requested
        var upload: (url: URL, offset: Int64)?
        var resumed = false

        // 1. Resume a stored upload when the local file and the target are unchanged.
        if let state = stateStore.load(key: key) {
            if state.fileSize == info.size, state.length == info.size, state.fileMtime == info.mtime,
               Self.sameTarget(state.target, requested, nameMayChange: nameMayChange) {
                // The server publishes with the stored metadata (N2: the first attempt's name).
                target = state.target
                do {
                    upload = (state.uploadURL, try await tus.head(state.uploadURL).offset)
                    resumed = true
                    Log.transfer.info("resuming upload at \(upload?.offset ?? 0, privacy: .public)/\(info.size, privacy: .public)")
                } catch let error as SyncAPIError where Self.isUploadGone(error) {
                    if let published = try await resolveGone(key: key, target: target, size: info.size, hash: localHash) {
                        Log.transfer.info("upload gone on the server, found the published content")
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
            // 2. Start a new upload (a new file may reuse an identical existing file of the same name).
            if upload == nil {
                if reuseIdentical, case .create(let name, let parentId, _) = target.target,
                   let existing = try await findIdentical(name: name, parentId: parentId, modifiedAt: target.modifiedAt,
                                                          size: info.size, hash: localHash, allowSuffixed: false) {
                    progress?.completedUnitCount = info.size
                    return existing
                }
                // A stale base etag of a replace ⇒ 412 here, before any byte is sent.
                let created: TusCreateResult
                do {
                    created = try await tus.create(length: info.size, metadata: target)
                } catch SyncAPIError.notFound {
                    // Replace: "unknown item" from tus is confirmed with GET /items/:id, which
                    // alone may report the item as deleted (`.notFound` ⇒ re-create path).
                    guard case .replace(let itemId, _) = target.target else { throw SyncAPIError.notFound }
                    _ = try await api.item(id: itemId)
                    throw Self.uploadLostError
                }
                switch created {
                case .completed(let item):
                    progress?.completedUnitCount = info.size
                    return item
                case .created(let url):
                    try stateStore.save(UploadState(uploadURL: url, length: info.size, fileSize: info.size,
                                                    fileMtime: info.mtime, target: target, baseEtag: target.ifMatch,
                                                    createdAt: now()),
                                        key: key)
                    upload = (url, 0)
                }
            }
            guard let current = upload else { continue }

            // 3. Send the chunks.
            do {
                let completion = try await sendChunks(file: file, info: info, url: current.url, offset: current.offset,
                                                      key: key, target: target, hash: localHash, progress: progress)
                stateStore.remove(key: key)
                let item = completion.matched ? completion.item
                    : try await verify(completion.item, fromResponse: completion.fromResponse, file: file, info: info,
                                       target: target, resumed: resumed, hash: localHash)
                progress?.completedUnitCount = info.size
                return item
            } catch SyncAPIError.conflict(let current) {
                // 412 at completion of a replace: the server dropped the upload and left the
                // file untouched – the caller takes the conflict path. Never replace again here.
                stateStore.remove(key: key)
                throw SyncAPIError.conflict(current: current)
            } catch let gone as UploadGone {
                // Expired (410) or unknown (404) while patching: start over once (a replace
                // first checks what the server has now).
                if case .replace = target.target {
                    if let published = try await resolveGone(key: key, target: target, size: info.size, hash: localHash) {
                        progress?.completedUnitCount = info.size
                        return published
                    }
                } else {
                    stateStore.remove(key: key)
                }
                guard restarts == 0 else {
                    // Lost a second time. A new file reports the tus error; a replace never
                    // lets it escape as `.notFound` (that would fork the file through the
                    // re-create path) – the system retries later instead.
                    if case .replace = target.target { throw Self.uploadLostError }
                    throw gone.underlying
                }
                restarts += 1
                upload = nil
                resumed = false
                Log.transfer.info("upload gone while patching, starting over")
            }
        }
    }

    /// Stored and requested targets describe the same upload. With `nameMayChange` a new
    /// file's name may differ (same parent, policy and mtime).
    static func sameTarget(_ stored: TusUploadMetadata, _ requested: TusUploadMetadata, nameMayChange: Bool) -> Bool {
        if stored == requested { return true }
        guard nameMayChange, stored.modifiedAt == requested.modifiedAt,
              case .create(_, let storedParent, let storedPolicy) = stored.target,
              case .create(_, let parent, let policy) = requested.target else { return false }
        return storedParent == parent && storedPolicy == policy
    }

    /// PATCH loop from `offset` to the end. Returns the published item.
    private func sendChunks(file: URL, info: FileInfo, url: URL, offset start: Int64, key: String,
                            target: TusUploadMetadata, hash: LazyHash, progress: Progress?) async throws -> Completion {
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
                switch try await tusCall({ try await tus.patch(url, offset: offset, chunk: chunk) }) {
                case .completed(let item, let fromResponse):
                    return Completion(item: item, fromResponse: fromResponse, matched: false)
                case .offset(let next):
                    offset = next
                    busy = 0
                }
            } catch SyncAPIError.http(status: 423, _, _) where busy < Self.busyRetries {
                // Being published by a concurrent request: wait and check (HEAD is not blocked).
                busy += 1
                try await sleep(Self.busyDelay)
                do {
                    offset = try await tusCall { try await tus.head(url).offset }
                } catch let gone as UploadGone {
                    // The concurrent request published it and the server dropped the upload.
                    if let published = try await resolveGone(key: key, target: target, size: info.size, hash: hash) {
                        return Completion(item: published, fromResponse: false, matched: true)
                    }
                    throw gone
                }
            } catch SyncAPIError.http(status: 409, code: nil, _) where mismatches < 3 {
                // Offset mismatch (plain-text tus error): re-sync with HEAD.
                mismatches += 1
                offset = try await tusCall { try await tus.head(url).offset }
            }
        }
    }

    /// ``publishedAfterGone(target:size:hash:)`` and the stored state: the state is dropped
    /// once the case is resolved (found, conflict, start over, item deleted). A transient
    /// answer (our version may be published but is not hashed yet) keeps it, so the next
    /// attempt checks again instead of starting a fresh replace that would only hit `412`.
    private func resolveGone(key: String, target: TusUploadMetadata, size: Int64, hash: LazyHash) async throws -> SyncItem? {
        do {
            let published = try await publishedAfterGone(target: target, size: size, hash: hash)
            stateStore.remove(key: key)
            return published
        } catch let error as SyncAPIError where error == Self.uploadLostError {
            throw error
        } catch {
            stateStore.remove(key: key)
            throw error
        }
    }

    /// The upload is gone on the server (`404`/`410`): was it published before (lost final
    /// response)?
    /// - New file: an identical file under the name or a server-picked `(n)` name.
    /// - Replace: the item now has our content ⇒ that item. It moved past the base version
    ///   with other content ⇒ ``SyncAPIError/conflict(current:)``. Still at the base
    ///   version ⇒ `nil` (start over). The item is gone ⇒ `.notFound` (re-create path).
    ///   The server has no sha256 for a newer version ⇒ unknown, transient (retry later
    ///   rather than a needless conflict copy).
    private func publishedAfterGone(target: TusUploadMetadata, size: Int64, hash: LazyHash) async throws -> SyncItem? {
        switch target.target {
        case .create(let name, let parentId, _):
            return try await findIdentical(name: name, parentId: parentId, modifiedAt: target.modifiedAt,
                                           size: size, hash: hash, allowSuffixed: true)
        case .replace(let itemId, let ifMatch):
            let item = try await api.item(id: itemId)
            if !item.isFolder, item.size == size, let serverHash = item.sha256, serverHash == (try await hash.value()) {
                return item
            }
            if item.contentEtag != ifMatch {
                if item.sha256 == nil, let base = Int(ifMatch.dropFirst()), item.version == base + 1 {
                    throw Self.uploadLostError // maybe ours, not hashed yet: check again later
                }
                throw SyncAPIError.conflict(current: item)
            }
            return nil
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
    /// too. On a mismatch the local content is written again with `PUT`, conditional on the
    /// etag of **our own** published version (from the completion body). Without such a
    /// trusted etag (the item came from a `GET` fallback, or has no `contentEtag`) nothing
    /// is rewritten – never `If-Match: *` – and a transient error lets the system retry.
    private func verify(_ item: SyncItem, fromResponse: Bool, file: URL, info: FileInfo, target: TusUploadMetadata,
                        resumed: Bool, hash: LazyHash) async throws -> SyncItem {
        var mismatch = item.size != info.size
        if !mismatch, resumed, let serverHash = item.sha256 {
            mismatch = serverHash != (try await hash.value())
        }
        guard mismatch else { return item }
        guard fromResponse, let ownEtag = item.contentEtag else {
            Log.transfer.error("published upload \(item.id, privacy: .public) differs from the local file; no trusted etag to rewrite it")
            throw SyncAPIError.transport(.cannotDecodeContentData,
                                         message: "The uploaded content could not be verified. It will be uploaded again.")
        }
        Log.transfer.error("published upload \(item.id, privacy: .public) differs from the local file, rewriting it")
        return try await api.replaceContent(itemID: item.id, from: file, ifMatch: ownEtag,
                                            modifiedAt: target.modifiedAt, progress: nil)
    }

    /// A file in `parentId` with the same size and sha256 whose name is `name`
    /// (same name key) or, with `allowSuffixed` (the "upload gone" paths: our own upload may
    /// have been published under a server-picked name), `"<base> (n).<ext>"`.
    ///
    /// On the "gone" paths a known `target.modifiedAt` must match too (the server stores the
    /// metadata value), so an unrelated identical copy is not taken for ours. Preference:
    /// the exact name; then suffixed names with `version == 1`, highest `n` first (the newest
    /// server-picked name).
    private func findIdentical(name: String, parentId: String, modifiedAt targetModifiedAt: Date?, size: Int64,
                               hash: LazyHash, allowSuffixed: Bool) async throws -> SyncItem? {
        let wanted = Self.nameKey(name)
        let (base, ext) = Self.splitName(name)
        var exact: SyncItem?
        var suffixed: [(item: SyncItem, n: Int)] = []
        var pageToken: String?
        repeat {
            let page: SyncChildrenPage
            do {
                page = try await api.children(of: parentId, pageToken: pageToken)
            } catch SyncAPIError.notFound {
                return nil // parent gone: the create reports it
            }
            for item in page.items where !item.isFolder && item.size == size && item.sha256 != nil {
                let key = Self.nameKey(item.name)
                let n = allowSuffixed ? Self.suffixNumber(key, base: base, ext: ext) : nil
                guard key == wanted || n != nil else { continue }
                if allowSuffixed, let modifiedAt = targetModifiedAt {
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
