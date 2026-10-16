import Foundation
import Synchronization

/// Drives the ``UploadQueue`` with a background `URLSession` (SYNC_API.md §6.4, §7):
/// up to ``UploadRequestBuilder/threshold`` one `POST /items/upload?onConflict=rename`,
/// above that tus with ``UploadRequestBuilder/chunkSize`` chunks.
///
/// - Every request is an upload task from a file (single: the queue's copy; tus `PATCH`:
///   a chunk file `<queue>/chunks/<id>-<offset>`) or a download task (tus `POST` create and
///   `HEAD`, which have no body). Deliberately not data tasks (as first planned): background
///   sessions only run upload and download tasks while the app is suspended. The task's `taskDescription` holds ``TaskTag`` JSON, so
///   completions delivered after a relaunch are routed to their entry and step.
/// - At most ``maxConcurrent`` entries per process are in flight. An entry is claimed
///   (`waiting` → `uploading`) under the queue's file lock, so the app and the Share
///   extension never start the same entry twice.
/// - The device token is read from the ``CredentialStore`` for every request.
/// - A claim records `owner` (this session's identifier) and `leaseUntil` (now + 10 min,
///   renewed on progress at most every 30 s and on every handled completion). After a
///   launch only abandoned `uploading` entries go back to `waiting`: our own without a live
///   task, or any whose lease expired – never one the other process is still running.
public final class BackgroundUploader: NSObject, Sendable {
    /// In-flight entries per process.
    public static let maxConcurrent = 2
    /// Attempts until an entry fails with ``UploadFailure/network``.
    public static let maxAttempts = 10
    /// Upper bound of the retry delay (seconds).
    public static let maxBackoff: TimeInterval = 300
    /// How long a claim (`owner` + `leaseUntil`) holds without being renewed.
    public static let leaseDuration: TimeInterval = 10 * 60
    /// Minimum spacing of lease renewals on progress.
    public static let leaseRenewalInterval: TimeInterval = 30

    /// `taskDescription` of every task: which entry and which step it belongs to.
    struct TaskTag: Codable, Hashable {
        var entryId: String
        var step: UploadStep

        var encoded: String? {
            (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) }
        }

        init(entryId: String, step: UploadStep) {
            self.entryId = entryId
            self.step = step
        }

        init?(_ text: String?) {
            guard let text, let tag = try? JSONDecoder().decode(TaskTag.self, from: Data(text.utf8)) else { return nil }
            self = tag
        }
    }

    private struct State {
        /// Entries holding one of the ``maxConcurrent`` slots.
        var inFlight: Set<String> = []
        /// Current task per entry (for cancel and for dropping stale completions).
        var tasks: [String: URLSessionTask] = [:]
        /// Response bodies per task identifier.
        var bodies: [Int: Data] = [:]
        /// Entries cancelled while in flight; their completions are dropped.
        var cancelled: Set<String> = []
        /// Last lease write per entry (throttles renewals on progress).
        var leaseRenewedAt: [String: Date] = [:]
        var recovered = false
        var backgroundCompletion: (@Sendable () -> Void)?
        /// `urlSessionDidFinishEvents` fired before a completion handler was handed over.
        var eventsFinished = false
        var session: URLSession?
    }

    public let identifier: String
    private let queue: UploadQueue
    private let accounts: AccountStore
    private let credentials: CredentialStore
    private let now: @Sendable () -> Date
    private let onChange: @Sendable (UploadEntry) -> Void
    private let onProgress: @Sendable (_ entryId: String, _ bytesSent: Int64) -> Void
    private let state = Mutex(State())

    /// - Parameters:
    ///   - identifier: `tech.jensk.synclet.upload.app` (app) or `tech.jensk.synclet.upload.share` (extension).
    ///   - appGroup: `sharedContainerIdentifier` of the background session.
    ///   - sessionConfiguration: replaces the background configuration (tests: `.ephemeral` + a `URLProtocol`).
    ///   - onProgress: bytes of the entry's file sent so far (tus: offset of the chunk + its sent bytes);
    ///     called on the session's delegate queue, often.
    public init(identifier: String, queue: UploadQueue, appGroup: String?, accounts: AccountStore, credentials: CredentialStore,
                sessionConfiguration: URLSessionConfiguration? = nil,
                now: @escaping @Sendable () -> Date = { Date() },
                onChange: @escaping @Sendable (UploadEntry) -> Void = { _ in },
                onProgress: @escaping @Sendable (_ entryId: String, _ bytesSent: Int64) -> Void = { _, _ in }) {
        self.identifier = identifier
        self.queue = queue
        self.accounts = accounts
        self.credentials = credentials
        self.now = now
        self.onChange = onChange
        self.onProgress = onProgress
        super.init()
        let configuration = sessionConfiguration ?? {
            let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
            configuration.sharedContainerIdentifier = appGroup
            configuration.sessionSendsLaunchEvents = true
            configuration.isDiscretionary = false
            return configuration
        }()
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.name = "tech.jensk.synclet.upload.delegate"
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        state.withLock { $0.session = session }
    }

    private var session: URLSession {
        state.withLock { $0.session! }
    }

    /// Cancels all tasks and breaks the session's strong reference to its delegate (tests).
    func invalidate() {
        session.invalidateAndCancel()
    }

    // MARK: - API

    /// Starts runnable entries (max ``maxConcurrent`` per process) that are not already in
    /// flight in this session. The first call after a launch first returns `uploading`
    /// entries without a live task to `waiting`.
    public func pump() async {
        await recoverIfNeeded()
        let candidates = queue.runnable()
        let picked: [UploadEntry] = state.withLock { s in
            var picked: [UploadEntry] = []
            for entry in candidates where s.inFlight.count < Self.maxConcurrent && !s.inFlight.contains(entry.id) {
                s.inFlight.insert(entry.id)
                picked.append(entry)
            }
            return picked
        }
        for entry in picked { begin(entry) }
    }

    /// Cancels the in-flight task (if any) and removes the entry (and its copy).
    public func cancel(id: String) async {
        let task = state.withLock { s -> URLSessionTask? in
            if s.inFlight.contains(id) { s.cancelled.insert(id) }
            return s.tasks[id]
        }
        task?.cancel()
        // Tasks of an earlier launch this process has not seen yet.
        for task in await session.allTasks where TaskTag(task.taskDescription)?.entryId == id { task.cancel() }
        queue.remove(id: id)
        removeChunks(of: id)
        Log.upload.info("upload cancelled")
    }

    /// From `application(_:handleEventsForBackgroundURLSession:completionHandler:)`; called
    /// once the session has delivered all pending events.
    ///
    /// The session may deliver its events (and `urlSessionDidFinishEvents`) before the app
    /// delegate hands the handler over; then it is called right away instead of being lost.
    public func handleBackgroundEvents(completion: @escaping @Sendable () -> Void) {
        let callNow = state.withLock { s -> Bool in
            if s.eventsFinished {
                s.eventsFinished = false
                return true
            }
            s.backgroundCompletion = completion
            return false
        }
        if callNow { DispatchQueue.main.async { completion() } }
    }

    // MARK: - Starting

    private func recoverIfNeeded() async {
        let first = state.withLock { s -> Bool in
            defer { s.recovered = true }
            return !s.recovered
        }
        guard first else { return }
        var live: [String: URLSessionTask] = [:]
        for task in await session.allTasks where task.state == .running || task.state == .suspended {
            if let tag = TaskTag(task.taskDescription) { live[tag.entryId] = task }
        }
        state.withLock { s in
            for (id, task) in live {
                s.inFlight.insert(id)
                s.tasks[id] = s.tasks[id] ?? task
            }
        }
        let at = now()
        for entry in queue.all() where entry.status == .uploading {
            guard !state.withLock({ $0.inFlight.contains(entry.id) }) else { continue }
            var reset = false
            let updated = queue.update(id: entry.id) { e in
                guard e.status == .uploading, self.isAbandoned(e, at: at) else { return }
                e.status = .waiting
                e.nextAttemptAt = nil
                e.owner = nil
                e.leaseUntil = nil
                reset = true
            }
            if reset, let updated {
                Log.upload.info("upload without a live task or lease after launch; back to waiting")
                onChange(updated)
            }
        }
    }

    /// `uploading` and claimed by this uploader.
    private func isOwned(_ entry: UploadEntry?) -> Bool {
        entry?.status == .uploading && entry?.owner == identifier
    }

    /// An `uploading` entry nobody runs any more: ours without a live task in this session
    /// (the caller checked that), or one whose lease ran out (its process died). An entry of
    /// another process (the Share extension) with a valid lease is left alone.
    private func isAbandoned(_ entry: UploadEntry, at date: Date) -> Bool {
        if entry.owner == identifier { return true }
        guard let lease = entry.leaseUntil else { return true }
        return lease < date
    }

    /// Claims a picked entry (`waiting` → `uploading`) and starts its first step.
    private func begin(_ candidate: UploadEntry) {
        var claimed = false
        let at = now()
        let entry = queue.update(id: candidate.id) { e in
            guard e.status == .waiting else { return }
            e.status = .uploading
            e.failure = nil
            e.failureMessage = nil
            e.owner = identifier
            e.leaseUntil = at.addingTimeInterval(Self.leaseDuration)
            claimed = true
        }
        if claimed { state.withLock { $0.leaseRenewedAt[candidate.id] = at } }
        guard claimed, let entry else {
            release(candidate.id)
            return
        }
        onChange(entry)
        let step: UploadStep
        if entry.tusURL != nil {
            step = .tusHead
        } else {
            step = UploadRequestBuilder.plan(size: entry.size) == .tus ? .tusCreate : .single
        }
        start(entry, step)
    }

    /// Creates and resumes the task of `step` (or applies the result that makes it unnecessary).
    private func start(_ entry: UploadEntry, _ step: UploadStep) {
        guard let account = accounts.account(key: entry.accountKey) else {
            return apply(.fail(.signedOut, message: nil), entryId: entry.id, step: step)
        }
        let token: String
        switch credentials.lookupToken(for: entry.accountKey) {
        case .found(let value): token = value
        case .notFound: return apply(.fail(.signedOut, message: nil), entryId: entry.id, step: step)
        case .failed(let status):
            Log.upload.error("keychain read failed (\(status)); retrying later")
            return apply(.retry, entryId: entry.id, step: step)
        }
        let api = SyncAPIClient(baseURL: account.serverURL, token: token)
        let fm = FileManager.default
        let task: URLSessionTask
        var chunk: URL?
        do {
            switch step {
            case .single:
                let copy = queue.fileURL(for: entry.id)
                guard fm.fileExists(atPath: copy.path) else {
                    return apply(.fail(.sourceUnreadable, message: nil), entryId: entry.id, step: step)
                }
                task = session.uploadTask(with: try UploadRequestBuilder.singleUpload(api: api, entry: entry, token: token),
                                          fromFile: copy)
            case .tusCreate:
                task = session.downloadTask(with: try UploadRequestBuilder.tusCreate(api: api, entry: entry, token: token))
            case .tusHead:
                // A stored URL must not carry the token to another host.
                guard let url = entry.tusURL, UploadRequestBuilder.isSameOrigin(url, account.serverURL) else {
                    return apply(.restartTus, entryId: entry.id, step: step)
                }
                task = session.downloadTask(with: UploadRequestBuilder.tusHead(url: url, token: token))
            case .tusPatch(let offset, let length):
                guard let url = entry.tusURL, UploadRequestBuilder.isSameOrigin(url, account.serverURL) else {
                    return apply(.restartTus, entryId: entry.id, step: step)
                }
                guard let file = writeChunk(of: entry.id, offset: offset, length: length) else {
                    return apply(.fail(.sourceUnreadable, message: nil), entryId: entry.id, step: step)
                }
                chunk = file
                task = session.uploadTask(with: UploadRequestBuilder.tusPatch(url: url, offset: offset, token: token),
                                          fromFile: file)
            }
        } catch {
            return apply(.fail(.other, message: String(describing: error)), entryId: entry.id, step: step)
        }
        task.taskDescription = TaskTag(entryId: entry.id, step: step).encoded
        let proceed = state.withLock { s -> Bool in
            guard !s.cancelled.contains(entry.id) else { return false }
            s.inFlight.insert(entry.id)
            s.tasks[entry.id] = task
            return true
        }
        guard proceed else {
            task.cancel()
            if let chunk { try? fm.removeItem(at: chunk) }
            release(entry.id)
            return
        }
        task.resume()
    }

    // MARK: - Completion

    private func complete(_ task: URLSessionTask, error: Error?) {
        let body = state.withLock { $0.bodies.removeValue(forKey: task.taskIdentifier) } ?? Data()
        guard let tag = TaskTag(task.taskDescription) else {
            Log.upload.error("finished task without a tag")
            return
        }
        if case .tusPatch(let offset, _) = tag.step {
            try? FileManager.default.removeItem(at: chunkURL(of: tag.entryId, offset: offset))
        }
        // Another task of this entry is current (a stale event of an earlier launch): drop it.
        let current = state.withLock { s -> Bool in
            if let known = s.tasks[tag.entryId], known !== task { return false }
            s.tasks.removeValue(forKey: tag.entryId)
            s.inFlight.insert(tag.entryId)
            return true
        }
        guard current else { return }

        let result: UploadStepResult
        if let error {
            if (error as? URLError)?.code == .cancelled {
                if state.withLock({ $0.cancelled.contains(tag.entryId) }) {
                    release(tag.entryId)
                    pumpLater()
                    return
                }
                // Cancelled by the system (session invalidated): try again later without counting.
                var changed = false
                let identifier = identifier
                let updated = queue.update(id: tag.entryId) { e in
                    guard e.status == .uploading, e.owner == identifier else { return }
                    e.status = .waiting; e.owner = nil; e.leaseUntil = nil
                    changed = true
                }
                release(tag.entryId)
                if changed, let updated { onChange(updated) }
                return
            }
            Log.upload.info("upload request failed: \(error.localizedDescription, privacy: .public)")
            result = .retry
        } else if let http = task.response as? HTTPURLResponse {
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String { headers[key] = "\(value)" }
            }
            result = UploadRequestBuilder.interpret(status: http.statusCode, headers: headers, body: body,
                                                    for: tag.step, requestURL: task.originalRequest?.url)
            if case .tusPatch(_, 0) = tag.step, case .tusOffset = result {
                // An empty PATCH (publish retry) that did not publish: back off instead of looping.
                return apply(.retry, entryId: tag.entryId, step: tag.step)
            }
        } else {
            result = .retry
        }
        // Only the current owner drives an entry. A completion for an entry that went back to
        // `waiting` (relaunch recovery ran first) or was taken over by another process after
        // our lease expired is only recorded when it published the file; otherwise it is
        // dropped and the owner (or the next attempt) carries on.
        if case .finished = result {} else if !isOwned(queue.entry(id: tag.entryId)) {
            Log.upload.info("dropping a completion for an entry this uploader no longer owns")
            release(tag.entryId)
            pumpLater()
            return
        }
        apply(result, entryId: tag.entryId, step: tag.step)
    }

    /// Records `result` and either starts the entry's next step or frees its slot.
    private func apply(_ result: UploadStepResult, entryId: String, step: UploadStep) {
        if state.withLock({ $0.cancelled.contains(entryId) }) {
            release(entryId)
            pumpLater()
            return
        }
        var next: UploadStep?
        // Set by every non-final update closure that found the entry still ours; a closure that
        // finds another owner changes nothing (never take an entry over from here).
        var mine = false
        let at = now()
        let lease = at.addingTimeInterval(Self.leaseDuration)
        let identifier = identifier
        let updated: UploadEntry?
        switch result {
        case .finished(let itemId, let name):
            updated = queue.update(id: entryId) { e in
                e.status = .done
                e.itemId = itemId
                if !name.isEmpty { e.name = name }
                e.finishedAt = now()
                e.failure = nil
                e.failureMessage = nil
                e.nextAttemptAt = nil
                e.tusURL = nil
                e.tusOffset = e.size
                e.owner = nil
                e.leaseUntil = nil
            }
            try? FileManager.default.removeItem(at: queue.fileURL(for: entryId))
            removeChunks(of: entryId)
            Log.upload.info("upload finished")
        case .tusCreated(let url):
            updated = queue.update(id: entryId) { e in
                guard e.status == .uploading, e.owner == identifier else { return }
                mine = true
                e.tusURL = url
                e.tusOffset = 0
                e.leaseUntil = lease
            }
            if let updated { next = Self.patch(from: 0, size: updated.size) }
        case .tusOffset(let offset):
            updated = queue.update(id: entryId) { e in
                guard e.status == .uploading, e.owner == identifier else { return }
                mine = true
                if offset <= e.size {
                    e.tusOffset = offset
                    e.leaseUntil = lease
                } else {
                    e.status = .failed
                    e.failure = .other
                    e.failureMessage = "tus: offset beyond the file"
                    e.tusURL = nil
                    e.tusOffset = 0
                    e.owner = nil
                    e.leaseUntil = nil
                }
            }
            if let updated, updated.status == .uploading { next = Self.patch(from: offset, size: updated.size) }
        case .restartTus:
            updated = queue.update(id: entryId) { e in
                guard e.status == .uploading, e.owner == identifier else { return }
                mine = true
                e.tusURL = nil
                e.tusOffset = 0
                e.leaseUntil = lease
            }
            next = .tusCreate
        case .retry:
            updated = queue.update(id: entryId) { e in
                guard e.status == .uploading, e.owner == identifier else { return }
                mine = true
                // Delay 2 s · 2^n, n = retries before this one (2, 4, 8 … 300 s).
                let delay = Self.backoff(retriesBefore: e.attempts)
                e.attempts += 1
                e.owner = nil
                e.leaseUntil = nil
                if e.attempts >= Self.maxAttempts {
                    e.status = .failed
                    e.failure = .network
                    e.nextAttemptAt = nil
                } else {
                    e.status = .waiting
                    e.nextAttemptAt = at.addingTimeInterval(delay)
                }
            }
        case .fail(let failure, let message):
            updated = queue.update(id: entryId) { e in
                guard e.status == .uploading, e.owner == identifier else { return }
                mine = true
                e.status = .failed
                e.failure = failure
                e.failureMessage = message
                e.nextAttemptAt = nil
                e.owner = nil
                e.leaseUntil = nil
            }
            Log.upload.error("upload failed: \(failure.rawValue, privacy: .public)")
        }
        if case .finished = result { mine = true }
        guard let updated, mine else {
            // Removed meanwhile (cancel, sign-out, the other process), or no longer ours.
            release(entryId)
            pumpLater()
            return
        }
        if updated.status == .uploading { state.withLock { $0.leaseRenewedAt[entryId] = at } }
        onChange(updated)
        if let next, updated.status == .uploading {
            start(updated, next)
        } else {
            release(entryId)
            pumpLater()
        }
    }

    /// `min(2 s · 2^n, 300 s)`, `n` = retries already done before this one.
    static func backoff(retriesBefore n: Int) -> TimeInterval {
        min(2 * pow(2, Double(n)), maxBackoff)
    }

    /// Extends the claim while bytes flow, at most every ``leaseRenewalInterval``.
    private func renewLease(of entryId: String) {
        let at = now()
        let due = state.withLock { s -> Bool in
            guard s.inFlight.contains(entryId), !s.cancelled.contains(entryId) else { return false }
            if let last = s.leaseRenewedAt[entryId], at.timeIntervalSince(last) < Self.leaseRenewalInterval { return false }
            s.leaseRenewedAt[entryId] = at
            return true
        }
        guard due else { return }
        let identifier = identifier
        queue.update(id: entryId) { e in
            guard e.status == .uploading, e.owner == identifier else { return }
            e.leaseUntil = at.addingTimeInterval(Self.leaseDuration)
        }
    }

    private static func patch(from offset: Int64, size: Int64) -> UploadStep {
        .tusPatch(offset: offset, length: max(0, min(UploadRequestBuilder.chunkSize, size - offset)))
    }

    private func release(_ entryId: String) {
        state.withLock { s in
            s.inFlight.remove(entryId)
            s.tasks.removeValue(forKey: entryId)
            s.cancelled.remove(entryId)
            s.leaseRenewedAt.removeValue(forKey: entryId)
        }
    }

    private func pumpLater() {
        Task { await self.pump() }
    }

    // MARK: - Chunk files

    private var chunksDirectory: URL {
        queue.filesDirectory.deletingLastPathComponent().appending(path: "chunks", directoryHint: .isDirectory)
    }

    private func chunkURL(of entryId: String, offset: Int64) -> URL {
        chunksDirectory.appending(path: "\(AccountStore.safeComponent(entryId))-\(offset)", directoryHint: .notDirectory)
    }

    /// Bytes `[offset, offset + length)` of the copy, in their own file (upload tasks need a file).
    private func writeChunk(of entryId: String, offset: Int64, length: Int64) -> URL? {
        let fm = FileManager.default
        let target = chunkURL(of: entryId, offset: offset)
        do {
            try fm.createDirectory(at: chunksDirectory, withIntermediateDirectories: true)
            let handle = try FileHandle(forReadingFrom: queue.fileURL(for: entryId))
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            let data = length > 0 ? (try handle.read(upToCount: Int(length)) ?? Data()) : Data()
            guard data.count == length else {
                Log.upload.error("copy shorter than expected")
                return nil
            }
            try data.write(to: target, options: .atomic)
            return target
        } catch {
            Log.upload.error("chunk not written: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func removeChunks(of entryId: String) {
        let fm = FileManager.default
        let prefix = AccountStore.safeComponent(entryId) + "-"
        for name in (try? fm.contentsOfDirectory(atPath: chunksDirectory.path)) ?? [] where name.hasPrefix(prefix) {
            try? fm.removeItem(at: chunksDirectory.appending(path: name, directoryHint: .notDirectory))
        }
    }
}

// MARK: - URLSession delegate

extension BackgroundUploader: URLSessionDataDelegate, URLSessionDownloadDelegate {
    /// Background upload tasks deliver their response body here.
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { $0.bodies[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    /// tus create and `HEAD` run as download tasks; their (small) body is read before the file goes away.
    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let data = (try? Data(contentsOf: location)) ?? Data()
        state.withLock { $0.bodies[downloadTask.taskIdentifier] = data }
    }

    /// Progress renews the entry's lease (throttled) and is reported through `onProgress`.
    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                           totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let tag = TaskTag(task.taskDescription) else { return }
        renewLease(of: tag.entryId)
        switch tag.step {
        case .single: onProgress(tag.entryId, totalBytesSent)
        case .tusPatch(let offset, _): onProgress(tag.entryId, offset + totalBytesSent)
        case .tusCreate, .tusHead: break
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        complete(task, error: error)
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = state.withLock { s -> (@Sendable () -> Void)? in
            guard let completion = s.backgroundCompletion else {
                s.eventsFinished = true
                return nil
            }
            s.backgroundCompletion = nil
            return completion
        }
        if let completion { DispatchQueue.main.async { completion() } }
    }
}
