import XCTest
@testable import SyncletKit

/// Drives the uploader through an ephemeral session with ``MockURLProtocol`` (background
/// sessions do not run under `swift test`; the real background behaviour is the live test).
final class BackgroundUploaderTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var t = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date { lock.withLock { t } }
        func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
    }

    private final class Changes: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [UploadEntry] = []
        func add(_ e: UploadEntry) { lock.withLock { list.append(e) } }
        var all: [UploadEntry] { lock.withLock { list } }
    }

    private let accountKey = "srv1:u1"
    private var dir: URL!
    private var queue: UploadQueue!
    private var credentials: CredentialStore!
    private var clock: Clock!
    private var changes: Changes!
    private var uploader: BackgroundUploader!

    override func setUpWithError() throws {
        dir = Fixtures.tempDirectory()
        clock = Clock()
        changes = Changes()
        let clock = clock!
        queue = UploadQueue(directory: dir.appending(path: "uploads"), now: { clock.now })
        let accounts = AccountStore(directory: dir)
        try accounts.upsert(StoredAccount(key: accountKey, serverURL: Fixtures.server, userId: "u1", username: "jens",
                                          displayName: "Jens", spaces: [Fixtures.personal]))
        self.accounts = accounts
        credentials = CredentialStore(storage: InMemorySecureStorage())
        try credentials.save(token: "syd_t", for: accountKey)
        uploader = makeUploader(MockURLProtocol.self)
    }

    private var accounts: AccountStore!

    private func makeUploader(_ protocolClass: AnyClass) -> BackgroundUploader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        let changes = changes!, clock = clock!
        return BackgroundUploader(identifier: "tech.jensk.synclet.upload.test", queue: queue, appGroup: nil,
                                  accounts: accounts, credentials: credentials,
                                  sessionConfiguration: configuration, now: { clock.now },
                                  onChange: { changes.add($0) })
    }

    /// Switches to ``HoldingURLProtocol`` (requests stay open until released).
    private func useHoldingProtocol() {
        uploader.invalidate()
        HoldingURLProtocol.reset()
        uploader = makeUploader(HoldingURLProtocol.self)
    }

    override func tearDown() {
        uploader?.invalidate()
        uploader = nil
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    // MARK: Helpers

    private func enqueueSmall(_ text: String = "hello", name: String = "a.txt") throws -> UploadEntry {
        try queue.enqueue(source: Fixtures.tempFile(text), name: name, accountKey: accountKey, parentId: "d_1", parentName: "Docs")
    }

    private func enqueueSparse(size: Int64) throws -> UploadEntry {
        let source = FileManager.default.temporaryDirectory.appending(path: "synclet-test-\(UUID().uuidString)")
        XCTAssertTrue(FileManager.default.createFile(atPath: source.path, contents: nil))
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: UInt64(size))
        try handle.close()
        defer { try? FileManager.default.removeItem(at: source) }
        return try queue.enqueue(source: source, name: "Film.mov", accountKey: accountKey, parentId: "d_1", parentName: "Docs")
    }

    private func waitUntil(_ what: String = "condition", timeout: TimeInterval = 10,
                           file: StaticString = #filePath, line: UInt = #line,
                           _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("timed out waiting for \(what)", file: file, line: line); return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func status(_ id: String) -> UploadStatus? { queue.entry(id: id)?.status }

    private var chunksDirectory: URL { dir.appending(path: "uploads").appending(path: "chunks") }

    private func chunkFiles() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: chunksDirectory.path)) ?? []
    }

    /// tus server: create → `Location` `/api/sync/v1/uploads/<id>`; PATCH answers
    /// `Upload-Offset = offset + body length`, the completing one `200` + item JSON.
    private func tusHandler(size: Int64, uploadId: String = "abc", headOffset: Int64? = nil,
                            headStatus: Int = 200) -> (RecordedRequest) throws -> MockResponse {
        { request in
            switch request.method {
            case "POST":
                return .empty(201, headers: ["Location": "/api/sync/v1/uploads/\(uploadId)", "Tus-Resumable": "1.0.0"])
            case "HEAD":
                guard headStatus == 200, let headOffset else { return .data(headStatus, Data("gone".utf8)) }
                return .empty(200, headers: ["Upload-Offset": String(headOffset), "Upload-Length": String(size)])
            case "PATCH":
                let offset = Int64(request.header("Upload-Offset") ?? "") ?? -1
                let newOffset = offset + Int64(request.body.count)
                if newOffset == size {
                    return .json(200, Fixtures.itemJSON(id: "f_big", parentId: "d_1", name: "Film (2).mov"),
                                 headers: ["X-Synclet-Item": "f_big"])
                }
                return .empty(204, headers: ["Upload-Offset": String(newOffset)])
            default:
                return .error(400, "invalid_request")
            }
        }
    }

    // MARK: Tests

    func testSmallFileSingleUploadMarksDoneAndDeletesCopy() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1", parentId: "d_1", name: "a (2).txt")) }
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("done") { status(entry.id) == .done }

        let done = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertEqual(done.itemId, "f_1")
        XCTAssertEqual(done.name, "a (2).txt")
        XCTAssertEqual(done.finishedAt, clock.now)
        XCTAssertNil(done.failure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path))

        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.method, "POST")
        XCTAssertEqual(requests.first?.path, "/api/sync/v1/items/upload")
        XCTAssertEqual(requests.first?.query, ["parentId": "d_1", "name": "a.txt", "onConflict": "rename"])
        XCTAssertEqual(requests.first?.header("Authorization"), "Bearer syd_t")
        XCTAssertEqual(requests.first?.bodyString, "hello")

        await waitUntil("done reported") { changes.all.contains { $0.id == entry.id && $0.status == .done } }
        XCTAssertTrue(changes.all.contains { $0.id == entry.id && $0.status == .uploading })
    }

    func testLargeFileUsesTusInChunks() async throws {
        let size: Int64 = 40 << 20
        MockURLProtocol.reset(tusHandler(size: size))
        let entry = try enqueueSparse(size: size)
        await uploader.pump()
        await waitUntil("done", timeout: 30) { status(entry.id) == .done }

        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "PATCH", "PATCH", "PATCH"])
        let create = requests[0]
        XCTAssertEqual(create.path, "/api/sync/v1/uploads")
        XCTAssertEqual(create.header("Upload-Length"), String(size))
        XCTAssertEqual(FakeTusServer.decodeMetadata(create.header("Upload-Metadata") ?? ""),
                       ["name": "Film.mov", "parentId": "d_1", "onConflict": "rename"])
        let patches = requests.dropFirst()
        XCTAssertEqual(patches.map { $0.header("Upload-Offset") }, ["0", String(16 << 20), String(32 << 20)])
        XCTAssertEqual(patches.map(\.body.count), [16 << 20, 16 << 20, 8 << 20])
        XCTAssertTrue(patches.allSatisfy { $0.request.url?.absoluteString == "https://synclet.example.test/api/sync/v1/uploads/abc" })
        XCTAssertTrue(patches.allSatisfy { $0.header("Authorization") == "Bearer syd_t" })

        let done = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertEqual(done.itemId, "f_big")
        XCTAssertEqual(done.name, "Film (2).mov")
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path))
        await waitUntil("chunks cleaned") { chunkFiles().isEmpty }
    }

    func testResumeUsesHeadOffset() async throws {
        let size: Int64 = 40 << 20
        MockURLProtocol.reset(tusHandler(size: size, headOffset: 16 << 20))
        let entry = try enqueueSparse(size: size)
        // Left over by a previous process: uploading, but no live task in this session.
        queue.update(id: entry.id) { e in
            e.status = .uploading
            e.tusURL = URL(string: "https://synclet.example.test/api/sync/v1/uploads/abc")
            e.tusOffset = 0
        }
        await uploader.pump()
        await waitUntil("done", timeout: 30) { status(entry.id) == .done }

        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["HEAD", "PATCH", "PATCH"])
        XCTAssertEqual(requests[0].header("Tus-Resumable"), "1.0.0")
        XCTAssertEqual(requests.dropFirst().map { $0.header("Upload-Offset") }, [String(16 << 20), String(32 << 20)])
    }

    func testExpiredTusURLRestarts() async throws {
        let size: Int64 = 40 << 20
        MockURLProtocol.reset(tusHandler(size: size, uploadId: "new", headStatus: 404))
        let entry = try enqueueSparse(size: size)
        queue.update(id: entry.id) { e in
            e.status = .uploading
            e.tusURL = URL(string: "https://synclet.example.test/api/sync/v1/uploads/old")
            e.tusOffset = 16 << 20
        }
        await uploader.pump()
        await waitUntil("done", timeout: 30) { status(entry.id) == .done }

        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["HEAD", "POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(requests[0].path, "/api/sync/v1/uploads/old")
        XCTAssertEqual(requests[2].path, "/api/sync/v1/uploads/new")
        XCTAssertEqual(requests[2].header("Upload-Offset"), "0")
    }

    func testNetworkErrorsBackOffThenFail() async throws {
        MockURLProtocol.reset { _ in .error(503, "unavailable") }
        let entry = try enqueueSmall()
        for attempt in 1...10 {
            await uploader.pump()
            await waitUntil("attempt \(attempt)") {
                guard let e = queue.entry(id: entry.id) else { return false }
                return e.attempts == attempt && e.status != .uploading
            }
            let e = try XCTUnwrap(queue.entry(id: entry.id))
            if attempt < 10 {
                XCTAssertEqual(e.status, .waiting)
                // 2 s · 2^n, n = retries before this one: 2, 4, 8 … capped at 300.
                let delay = min(2 * pow(2, Double(attempt - 1)), 300)
                XCTAssertNil(e.owner); XCTAssertNil(e.leaseUntil)
                XCTAssertEqual(e.nextAttemptAt, clock.now.addingTimeInterval(delay), "attempt \(attempt)")
                // Not runnable before its time.
                await uploader.pump()
                XCTAssertEqual(MockURLProtocol.requests.count, attempt)
                clock.advance(delay)
            } else {
                XCTAssertEqual(e.status, .failed)
                XCTAssertEqual(e.failure, .network)
                XCTAssertNil(e.nextAttemptAt)
            }
        }
        XCTAssertEqual(MockURLProtocol.requests.count, 10)
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path))
    }

    func testInsufficientStorageFailsImmediately() async throws {
        MockURLProtocol.reset { _ in .error(507, "insufficient_storage") }
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("failed") { status(entry.id) == .failed }
        let e = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertEqual(e.failure, .insufficientStorage)
        XCTAssertEqual(e.failureMessage, "insufficient_storage")
        XCTAssertEqual(e.attempts, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path), "copy kept for retry")
    }

    func testMissingTokenFailsSignedOut() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        credentials.delete(for: accountKey)
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("failed") { status(entry.id) == .failed }
        XCTAssertEqual(queue.entry(id: entry.id)?.failure, .signedOut)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testCancelRemovesEntry() async throws {
        useHoldingProtocol()
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("request sent") { HoldingURLProtocol.count == 1 }
        XCTAssertEqual(status(entry.id), .uploading)

        await uploader.cancel(id: entry.id)
        XCTAssertNil(queue.entry(id: entry.id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path))
        HoldingURLProtocol.releaseAll()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(queue.entry(id: entry.id), "a late completion must not resurrect the entry")
        XCTAssertFalse(changes.all.contains { $0.id == entry.id && $0.status != .uploading })
    }

    func testAtMostTwoConcurrentUploads() async throws {
        useHoldingProtocol()
        let entries = try (1...3).map { try enqueueSmall(name: "f\($0).txt") }
        await uploader.pump()
        await uploader.pump()
        await waitUntil("two in flight") { HoldingURLProtocol.count == 2 }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(HoldingURLProtocol.count, 2)
        XCTAssertEqual(entries.compactMap { status($0.id) }.filter { $0 == .uploading }.count, 2)
        await waitUntil("all done") {
            HoldingURLProtocol.releaseAll()
            return entries.allSatisfy { status($0.id) == .done }
        }
        XCTAssertEqual(HoldingURLProtocol.count, 3)
    }

    func testBackoffSequence() {
        XCTAssertEqual((0..<10).map { BackgroundUploader.backoff(retriesBefore: $0) },
                       [2, 4, 8, 16, 32, 64, 128, 256, 300, 300])
    }

    func testClaimSetsOwnerAndLeaseAndDoneClearsThem() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("done") { status(entry.id) == .done }
        let claim = try XCTUnwrap(changes.all.first { $0.id == entry.id && $0.status == .uploading })
        XCTAssertEqual(claim.owner, "tech.jensk.synclet.upload.test")
        XCTAssertEqual(claim.leaseUntil, clock.now.addingTimeInterval(600))
        let done = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertNil(done.owner)
        XCTAssertNil(done.leaseUntil)
    }

    private func markUploading(_ id: String, owner: String?, leaseUntil: Date?) {
        queue.update(id: id) { e in e.status = .uploading; e.owner = owner; e.leaseUntil = leaseUntil }
    }

    func testRecoveryLeavesEntryOfOtherProcessWithValidLease() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        let entry = try enqueueSmall()
        markUploading(entry.id, owner: "tech.jensk.synclet.upload.share", leaseUntil: clock.now.addingTimeInterval(300))
        await uploader.pump()
        try await Task.sleep(for: .milliseconds(200))
        let e = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertEqual(e.status, .uploading)
        XCTAssertEqual(e.owner, "tech.jensk.synclet.upload.share")
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testRecoveryTakesOverEntryWithExpiredLease() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        let entry = try enqueueSmall()
        markUploading(entry.id, owner: "tech.jensk.synclet.upload.share", leaseUntil: clock.now.addingTimeInterval(-1))
        await uploader.pump()
        await waitUntil("done") { status(entry.id) == .done }
        XCTAssertTrue(changes.all.contains { $0.id == entry.id && $0.status == .waiting && $0.owner == nil })
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
    }

    func testRecoveryTakesOverEntryWithoutLease() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        let entry = try enqueueSmall()
        markUploading(entry.id, owner: nil, leaseUntil: nil)
        await uploader.pump()
        await waitUntil("done") { status(entry.id) == .done }
    }

    func testRecoveryResetsOwnEntryWithoutLiveTask() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_1")) }
        let entry = try enqueueSmall()
        // Ours (same session identifier), lease still valid, but no task survived.
        markUploading(entry.id, owner: "tech.jensk.synclet.upload.test", leaseUntil: clock.now.addingTimeInterval(300))
        await uploader.pump()
        await waitUntil("done") { status(entry.id) == .done }
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
    }

    /// Lease takeover: while our PATCH is in flight another process takes the entry over
    /// (our lease expired). Our late `204` must neither re-take the entry nor send more requests.
    func testLateCompletionAfterTakeoverIsDropped() async throws {
        useHoldingProtocol()
        let size: Int64 = 40 << 20
        HoldingURLProtocol.respond { request in
            switch request.httpMethod {
            case "POST": return .empty(201, headers: ["Location": "/api/sync/v1/uploads/abc"])
            default: return .empty(204, headers: ["Upload-Offset": String(16 << 20)])
            }
        }
        let entry = try enqueueSparse(size: size)
        await uploader.pump()
        await waitUntil("create sent") { HoldingURLProtocol.count == 1 }
        HoldingURLProtocol.releaseAll()
        await waitUntil("first PATCH sent") { HoldingURLProtocol.count == 2 }

        let other = "tech.jensk.synclet.upload.share"
        let otherLease = clock.now.addingTimeInterval(600)
        queue.update(id: entry.id) { e in e.owner = other; e.leaseUntil = otherLease; e.tusOffset = 1234 }
        HoldingURLProtocol.releaseAll()
        try await Task.sleep(for: .milliseconds(300))

        let e = try XCTUnwrap(queue.entry(id: entry.id))
        XCTAssertEqual(e.status, .uploading)
        XCTAssertEqual(e.owner, other)
        XCTAssertEqual(e.leaseUntil, otherLease)
        XCTAssertEqual(e.tusOffset, 1234, "the other owner's progress is left alone")
        XCTAssertEqual(HoldingURLProtocol.count, 2, "no further request")
        XCTAssertTrue(chunkFiles().isEmpty)
    }

    /// The old owner's completion that published the file still records `done`.
    func testLateFinishedCompletionAfterTakeoverStillMarksDone() async throws {
        useHoldingProtocol()
        let entry = try enqueueSmall()
        await uploader.pump()
        await waitUntil("upload sent") { HoldingURLProtocol.count == 1 }
        queue.update(id: entry.id) { e in e.owner = "tech.jensk.synclet.upload.share"; e.leaseUntil = clock.now.addingTimeInterval(600) }
        HoldingURLProtocol.releaseAll()
        await waitUntil("done") { status(entry.id) == .done }
        XCTAssertNil(queue.entry(id: entry.id)?.owner)
    }

    func testBackgroundEventsCompletionWhenHandedOverFirst() async {
        let called = expectation(description: "completion")
        uploader.handleBackgroundEvents { called.fulfill() }
        uploader.urlSessionDidFinishEvents(forBackgroundURLSession: URLSession.shared)
        await fulfillment(of: [called], timeout: 5)
    }

    func testBackgroundEventsCompletionWhenEventsFinishedFirst() async {
        uploader.urlSessionDidFinishEvents(forBackgroundURLSession: URLSession.shared)
        let called = expectation(description: "completion")
        uploader.handleBackgroundEvents { called.fulfill() }
        await fulfillment(of: [called], timeout: 5)
        // Consumed: the next handler waits for the next delivery again.
        let second = expectation(description: "second completion")
        second.isInverted = true
        uploader.handleBackgroundEvents { second.fulfill() }
        await fulfillment(of: [second], timeout: 0.3)
    }

    func testTaskDescriptionRoutesCompletion() throws {
        let tag = BackgroundUploader.TaskTag(entryId: "e1", step: .tusPatch(offset: 16 << 20, length: 8 << 20))
        let text = try XCTUnwrap(tag.encoded)
        XCTAssertEqual(BackgroundUploader.TaskTag(text), tag)
        XCTAssertNil(BackgroundUploader.TaskTag("garbage"))
        XCTAssertNil(BackgroundUploader.TaskTag(nil))
    }
}

/// `URLProtocol` that keeps every request open until ``releaseAll()`` answers it with
/// `201` + item JSON (answers from another thread, never blocking the loading thread).
final class HoldingURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var held: [HoldingURLProtocol] = []
    nonisolated(unsafe) private static var started = 0
    nonisolated(unsafe) private static var responder: (@Sendable (URLRequest) -> MockResponse)?
    private var stopped = false

    static func reset() { lock.withLock { held = []; started = 0; responder = nil } }

    /// Answers released requests with `respond` instead of `201` + item JSON.
    static func respond(_ respond: @escaping @Sendable (URLRequest) -> MockResponse) {
        lock.withLock { responder = respond }
    }
    /// Requests started so far.
    static var count: Int { lock.withLock { started } }

    static func releaseAll() {
        let pending = lock.withLock { () -> [HoldingURLProtocol] in defer { held = [] }; return held }
        for p in pending { p.answer() }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock { Self.held.append(self); Self.started += 1 }
    }

    override func stopLoading() { Self.lock.withLock { stopped = true } }

    private func answer() {
        guard !Self.lock.withLock({ stopped }) else { return }
        let mock = Self.lock.withLock { Self.responder }?(request)
            ?? .json(201, Fixtures.itemJSON(id: "f_\(UUID().uuidString.prefix(6))"))
        let response = HTTPURLResponse(url: request.url!, statusCode: mock.status, httpVersion: "HTTP/1.1",
                                       headerFields: mock.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !mock.body.isEmpty { client?.urlProtocol(self, didLoad: mock.body) }
        client?.urlProtocolDidFinishLoading(self)
    }
}
