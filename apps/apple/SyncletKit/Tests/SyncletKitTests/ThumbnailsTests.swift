import FileProvider
import XCTest
@testable import SyncletKit

final class ThumbnailsTests: XCTestCase {
    var tempDir: URL!

    override func setUp() {
        tempDir = Fixtures.tempDirectory()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
    }

    private let small = CGSize(width: 128, height: 128)

    /// Thumbnail server: `body` with ETag `"<etag>-<size>"`; `304` when `If-None-Match` matches.
    private func thumbnailServer(body: Data = Data("WEBP".utf8), etag: String = "sha1") {
        MockURLProtocol.reset { request in
            guard request.path.hasSuffix("/thumbnail") else {
                XCTFail("unexpected request \(request.path)")
                return .empty(500)
            }
            let tag = "\"\(etag)-\(request.query["size"] ?? "")\""
            if request.header("If-None-Match") == tag { return .empty(304, headers: ["ETag": tag]) }
            return .data(200, body, headers: ["Content-Type": "image/webp", "ETag": tag])
        }
    }

    // MARK: Size bucketing (SYNC_API.md §9.1: 256 | 1024)

    func testSizeBucketPicksTheNearestServerSize() {
        let table: [(CGSize, Int)] = [
            (CGSize(width: 16, height: 16), 256),
            (CGSize(width: 256, height: 256), 256),
            (CGSize(width: 300, height: 120), 256),
            (CGSize(width: 512, height: 512), 256),
            (CGSize(width: 639, height: 100), 256),
            (CGSize(width: 640, height: 640), 1024),   // tie → the larger (sharper) size
            (CGSize(width: 100, height: 700), 1024),   // the longer edge counts
            (CGSize(width: 1024, height: 1024), 1024),
            (CGSize(width: 4096, height: 4096), 1024),
            (CGSize(width: 0, height: 0), 256),
        ]
        for (size, expected) in table {
            XCTAssertEqual(ThumbnailSize.bucket(for: size), expected, "\(size)")
        }
    }

    // MARK: Fetcher

    func testFetchRequestsTheBucketWithoutAnItemLookupAndStoresTheETag() async throws {
        thumbnailServer()
        let cache = ThumbnailCache(directory: tempDir)
        let fetcher = ThumbnailFetcher(cache: cache)
        let data = try await fetcher.thumbnail(itemID: "f_1", requestedSize: CGSize(width: 900, height: 900), client: Fixtures.client())
        XCTAssertEqual(data, Data("WEBP".utf8))
        XCTAssertEqual(MockURLProtocol.requests.map(\.path), ["/api/sync/v1/items/f_1/thumbnail"], "no GET /items/:id")
        XCTAssertEqual(MockURLProtocol.requests.first?.query["size"], "1024")
        XCTAssertNil(MockURLProtocol.requests.first?.header("If-None-Match"))
        // URLCache must not answer for us (it would hide a 304 behind the cached 200).
        XCTAssertEqual(MockURLProtocol.requests.first?.request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDir.appending(path: "f_1-1024.webp").path))
        XCTAssertEqual(cache.entry(itemID: "f_1", size: 1024)?.etag, "sha1-1024")
    }

    func testCacheHitRevalidatesAnd304ServesTheCachedFile() async throws {
        thumbnailServer(body: Data("FIRST".utf8))
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
        _ = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        thumbnailServer(body: Data("WOULD-BE-SENT".utf8))
        let again = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertEqual(again, Data("FIRST".utf8))
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
        XCTAssertEqual(request.path, "/api/sync/v1/items/f_1/thumbnail", "a cache hit makes no item GET")
        XCTAssertEqual(request.header("If-None-Match"), "\"sha1-256\"")
    }

    func testNewVersionReplacesTheCachedFile() async throws {
        thumbnailServer(body: Data("OLD".utf8), etag: "sha1")
        let cache = ThumbnailCache(directory: tempDir)
        let fetcher = ThumbnailFetcher(cache: cache)
        _ = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        thumbnailServer(body: Data("NEW".utf8), etag: "sha2")
        let data = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertEqual(data, Data("NEW".utf8))
        XCTAssertEqual(cache.entry(itemID: "f_1", size: 256), ThumbnailCache.Entry(data: Data("NEW".utf8), etag: "sha2-256"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tempDir.path), ["f_1-256.webp"], "no stale file")
    }

    func testUnsupportedTypesAndFoldersAreRememberedForTenMinutes() async throws {
        for (status, code) in [(415, "invalid_request"), (400, "invalid_request")] {
            let clock = TestClock()
            let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir, now: clock.now))
            MockURLProtocol.reset { _ in .error(status, code) }
            let first = try await fetcher.thumbnail(itemID: "x_\(status)", requestedSize: small, client: Fixtures.client())
            XCTAssertNil(first, "\(status)")
            // Within 10 minutes: no request.
            clock.advance(9 * 60)
            MockURLProtocol.reset { request in
                XCTFail("negative cache missed: \(request.path)")
                return .empty(500)
            }
            let second = try await fetcher.thumbnail(itemID: "x_\(status)", requestedSize: small, client: Fixtures.client())
            XCTAssertNil(second)
            XCTAssertTrue(MockURLProtocol.requests.isEmpty)
            // After 10 minutes: asked again.
            clock.advance(2 * 60)
            thumbnailServer()
            let third = try await fetcher.thumbnail(itemID: "x_\(status)", requestedSize: small, client: Fixtures.client())
            XCTAssertEqual(third, Data("WEBP".utf8))
        }
    }

    /// §9.1: a 404 means "not rendered yet" ⇒ poll with backoff 2 s, 5 s, 15 s, 60 s, 5 min, then 10 min.
    func testNotRenderedBacksOffStepByStep() async throws {
        let clock = TestClock()
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir, now: clock.now))
        let expected: [TimeInterval] = [2, 5, 15, 60, 300, 600, 600]
        var requests = 0
        for ttl in expected {
            MockURLProtocol.reset { _ in .error(404, "not_found") }
            let result1 = try await fetcher.thumbnail(itemID: "f_new", requestedSize: small, client: Fixtures.client())
            XCTAssertNil(result1)
            requests += MockURLProtocol.requests.count
            XCTAssertEqual(MockURLProtocol.requests.count, 1, "asks once when the backoff has passed (\(ttl) s step)")
            // Just before the step ends: still suppressed.
            clock.advance(ttl - 0.5)
            MockURLProtocol.reset { request in
                XCTFail("asked too early in the \(ttl) s step: \(request.path)")
                return .empty(500)
            }
            let result2 = try await fetcher.thumbnail(itemID: "f_new", requestedSize: small, client: Fixtures.client())
            XCTAssertNil(result2)
            clock.advance(0.5)
        }
        XCTAssertEqual(requests, expected.count)
        // Another size is independent.
        XCTAssertEqual(ThumbnailCache(directory: tempDir, now: clock.now).markMissing(itemID: "f_new", size: 1024, reason: .notRendered), 2)
    }

    func testThumbnailResetsTheBackoff() async throws {
        let clock = TestClock()
        let cache = ThumbnailCache(directory: tempDir, now: clock.now)
        let fetcher = ThumbnailFetcher(cache: cache)
        // Three 404s: the next one would wait 60 s.
        for ttl: TimeInterval in [2, 5, 15] {
            MockURLProtocol.reset { _ in .error(404, "not_found") }
            _ = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
            clock.advance(ttl)
        }
        // 200 resets: a later 404 (thumbnail gone with a new version) starts at 2 s again.
        thumbnailServer()
        let result3 = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertNotNil(result3)
        MockURLProtocol.reset { _ in .error(404, "not_found") }
        let result4 = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertNil(result4)
        clock.advance(2)
        XCTAssertFalse(cache.isKnownMissing(itemID: "f_1", size: 256), "back at the 2 s step")

        // 304 resets too.
        XCTAssertEqual(cache.markMissing(itemID: "f_2", size: 256, reason: .notRendered), 2)
        XCTAssertEqual(cache.markMissing(itemID: "f_2", size: 256, reason: .notRendered), 5)
        cache.store(Data("OLD".utf8), etag: "sha1-256", itemID: "f_2", size: 256)
        clock.advance(5)
        thumbnailServer(etag: "sha1")
        let result5 = try await fetcher.thumbnail(itemID: "f_2", requestedSize: small, client: Fixtures.client())
        XCTAssertEqual(result5, Data("OLD".utf8))
        XCTAssertEqual(MockURLProtocol.requests.first?.header("If-None-Match"), "\"sha1-256\"")
        XCTAssertEqual(cache.markMissing(itemID: "f_2", size: 256, reason: .notRendered), 2, "reset by the 304")
    }

    func testThumbnailGoneOnTheServerDropsTheCachedFile() async throws {
        thumbnailServer()
        let cache = ThumbnailCache(directory: tempDir)
        let fetcher = ThumbnailFetcher(cache: cache)
        _ = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        MockURLProtocol.reset { _ in .error(404, "not_found") }
        let data = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertNil(data)
        XCTAssertNil(cache.entry(itemID: "f_1", size: 256))
    }

    func testNetworkErrorServesTheCachedThumbnail() async throws {
        thumbnailServer()
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
        _ = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        MockURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        let cached = try await fetcher.thumbnail(itemID: "f_1", requestedSize: small, client: Fixtures.client())
        XCTAssertEqual(cached, Data("WEBP".utf8))
        do {
            _ = try await fetcher.thumbnail(itemID: "f_other", requestedSize: small, client: Fixtures.client())
            XCTFail("error expected without a cached thumbnail")
        } catch {}
    }

    // MARK: Cache

    func testCacheFileNameIsSafe() {
        XCTAssertEqual(ThumbnailCache.fileName(itemID: "f_1", size: 256), "f_1-256.webp")
        let odd = ThumbnailCache.fileName(itemID: "a/b:c", size: 1024)
        XCTAssertFalse(odd.contains("/"))
        XCTAssertFalse(odd.contains(":"))
        XCTAssertTrue(odd.hasSuffix("-1024.webp"))
    }

    func testCacheEvictsLeastRecentlyUsedAboveTheLimit() throws {
        let cache = ThumbnailCache(directory: tempDir, maxBytes: 3000)
        let blob = Data(repeating: 7, count: 1000)
        for name in ["a", "b", "c"] { cache.store(blob, etag: "e", itemID: name, size: 256) }
        // Make "a" the oldest, then use it ⇒ "b" becomes the least recently used.
        let fm = FileManager.default
        for (index, name) in ["a", "b", "c"].enumerated() {
            try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(index - 100))],
                                 ofItemAtPath: tempDir.appending(path: "\(name)-256.webp").path)
        }
        cache.touch(itemID: "a", size: 256)
        cache.store(blob, etag: "e", itemID: "d", size: 256)
        let names = Set(try fm.contentsOfDirectory(atPath: tempDir.path))
        XCTAssertFalse(names.contains("b-256.webp"), "\(names)")
        XCTAssertTrue(names.contains("a-256.webp"))
        XCTAssertTrue(names.contains("d-256.webp"))
        let total = names.compactMap { (try? fm.attributesOfItem(atPath: tempDir.appending(path: $0).path)[.size]) as? Int }.reduce(0, +)
        XCTAssertLessThanOrEqual(total, 3000)
    }

    func testReplacingAFileDoesNotInflateTheSizeEstimate() {
        let cache = ThumbnailCache(directory: tempDir, maxBytes: 3000)
        let blob = Data(repeating: 1, count: 1000)
        cache.store(blob, etag: "1", itemID: "a", size: 256)
        cache.store(blob, etag: "1", itemID: "b", size: 256)
        // Replacing "a" five times must not evict "b" (the old estimate would reach 7000).
        for round in 2...6 { cache.store(blob, etag: "\(round)", itemID: "a", size: 256) }
        XCTAssertNotNil(cache.entry(itemID: "b", size: 256))
        XCTAssertEqual(cache.entry(itemID: "a", size: 256)?.etag, "6")
    }

    func testConcurrentStoresKeepEveryFileReadable() {
        let cache = ThumbnailCache(directory: tempDir)
        DispatchQueue.concurrentPerform(iterations: 40) { index in
            cache.store(Data(repeating: UInt8(index), count: 2000), etag: "e\(index % 4)", itemID: "f_\(index % 4)", size: 256)
        }
        for index in 0..<4 {
            let entry = cache.entry(itemID: "f_\(index)", size: 256)
            XCTAssertEqual(entry?.data.count, 2000)
            XCTAssertEqual(entry?.etag, "e\(index)")
            XCTAssertEqual(Set(entry?.data ?? Data()).count, 1, "never a mix of two writes")
        }
    }

    func testDefaultCacheLimitIs200MB() {
        XCTAssertEqual(ThumbnailCache.defaultMaxBytes, 200 * 1024 * 1024)
        XCTAssertEqual(ThumbnailCache.missingTTL, 600)
        XCTAssertTrue(ThumbnailCache.defaultDirectory().path.hasSuffix("Caches/thumbnails"))
    }

    /// M10: caches are per account; the purge drops signed-out accounts and the old flat layout.
    func testPurgeKeepsOnlyTheCachesOfExistingAccounts() throws {
        let base = tempDir.appending(path: "purge", directoryHint: .isDirectory)
        let kept = ThumbnailCache.shared(directory: base.appending(path: "aaaaaaaaaaaaaaaa"))
        let gone = ThumbnailCache.shared(directory: base.appending(path: "bbbbbbbbbbbbbbbb"))
        kept.store(Data("A".utf8), etag: nil, itemID: "f_1", size: 256)
        gone.store(Data("B".utf8), etag: nil, itemID: "f_1", size: 256)
        try Data("old".utf8).write(to: base.appending(path: "f_9-256.webp"))

        ThumbnailCache.purge(base: base, keeping: ["aaaaaaaaaaaaaaaa"])

        let left = try FileManager.default.contentsOfDirectory(atPath: base.path)
        XCTAssertEqual(left, ["aaaaaaaaaaaaaaaa"])
        XCTAssertEqual(kept.entry(itemID: "f_1", size: 256)?.data, Data("A".utf8))
        XCTAssertNil(ThumbnailCache.shared(directory: base.appending(path: "bbbbbbbbbbbbbbbb")).entry(itemID: "f_1", size: 256))
    }

    // MARK: Extension (NSFileProviderThumbnailing)

    private func makeExtension() -> SyncletReplicatedExtension {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "Synclet – jens@test")
        let context = SyncletReplicatedExtension.Context(client: Fixtures.client(), deviceName: "Mac", layout: Fixtures.layout)
        return SyncletReplicatedExtension(domain: domain, temporaryDirectory: tempDir) { context }
    }

    func testFetchThumbnailsReportsEachItemWithoutItemLookups() async throws {
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/f_png/thumbnail": return .data(200, Data("PNG".utf8), headers: ["ETag": "\"x-256\""])
            case "/api/sync/v1/items/f_pdf/thumbnail", "/api/sync/v1/items/f_gone/thumbnail": return .error(404, "not_found")
            case "/api/sync/v1/items/d_1/thumbnail": return .error(400, "invalid_request")
            default:
                XCTFail("unexpected request \(request.path)")
                return .empty(500)
            }
        }
        let ext = makeExtension()
        let ids = ["f_png", "f_pdf", "d_1", "f_gone", "space:personal", NSFileProviderItemIdentifier.rootContainer.rawValue]
            .map { NSFileProviderItemIdentifier($0) }
        let byID = try await fetch(ext, ids)
        XCTAssertEqual(byID.count, ids.count)
        XCTAssertEqual(byID["f_png"]?.data, Data("PNG".utf8))
        for id in ["f_pdf", "d_1", "f_gone", "space:personal", NSFileProviderItemIdentifier.rootContainer.rawValue] {
            XCTAssertNil(byID[id]?.data, id)
            XCTAssertNil(byID[id]?.error, id)
        }
        // Only thumbnail requests; nothing for the virtual top level.
        let paths = MockURLProtocol.requests.map(\.path)
        XCTAssertEqual(paths.count, 4)
        XCTAssertTrue(paths.allSatisfy { $0.hasSuffix("/thumbnail") }, "\(paths)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDir.appending(path: "thumbnails/0123456789abcdef/f_png-256.webp").path))

        // Second round: the png revalidates (304), the others are remembered as missing.
        MockURLProtocol.reset { request in
            request.path == "/api/sync/v1/items/f_png/thumbnail" && request.header("If-None-Match") == "\"x-256\""
                ? .empty(304) : .empty(500)
        }
        let again = try await fetch(ext, ids)
        XCTAssertEqual(again["f_png"]?.data, Data("PNG".utf8))
        XCTAssertEqual(MockURLProtocol.requests.map(\.path), ["/api/sync/v1/items/f_png/thumbnail"])
    }

    func testCancellingTheProgressStopsCallbacksAndReportsUserCancelled() async {
        MockURLProtocol.reset { _ in
            Thread.sleep(forTimeInterval: 0.5)
            return .data(200, Data("LATE".utf8), headers: ["ETag": "\"x-256\""])
        }
        let ext = makeExtension()
        let results = ResultsBox()
        let error: Error? = await withCheckedContinuation { continuation in
            let progress = ext.fetchThumbnails(for: ["f_1", "f_2"].map { NSFileProviderItemIdentifier($0) },
                                               requestedSize: CGSize(width: 64, height: 64),
                                               perThumbnailCompletionHandler: { id, data, error in results.add(id.rawValue, data, error) },
                                               completionHandler: { continuation.resume(returning: $0) })
            progress.cancel()
        }
        XCTAssertEqual((error as? CocoaError)?.code, .userCancelled)
        XCTAssertTrue(results.all.isEmpty)
        // Let the stub's delayed loads finish so they are not recorded by the next test.
        try? await Task.sleep(for: .seconds(1.2))
        XCTAssertTrue(results.all.isEmpty, "no callback after cancelling")
    }

    private func fetch(_ ext: SyncletReplicatedExtension, _ ids: [NSFileProviderItemIdentifier]) async throws -> [String: (data: Data?, error: Error?)] {
        let results = ResultsBox()
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.fetchThumbnails(for: ids, requestedSize: CGSize(width: 256, height: 256),
                                    perThumbnailCompletionHandler: { id, data, error in results.add(id.rawValue, data, error) },
                                    completionHandler: { continuation.resume(returning: $0) })
        }
        if let error { throw error }
        return results.all
    }

    func testFetchThumbnailsWithoutCredentialsFailsGlobally() async {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "x")
        let ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: tempDir) { nil }
        let results = ResultsBox()
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.fetchThumbnails(for: [NSFileProviderItemIdentifier("f_1")], requestedSize: CGSize(width: 64, height: 64),
                                    perThumbnailCompletionHandler: { id, data, error in results.add(id.rawValue, data, error) },
                                    completionHandler: { continuation.resume(returning: $0) })
        }
        XCTAssertEqual((error as NSError?)?.code, NSFileProviderError.notAuthenticated.rawValue)
        XCTAssertTrue(results.all.isEmpty)
    }
}

/// Collects the per-thumbnail callbacks (called from several tasks).
final class ResultsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: (data: Data?, error: Error?)] = [:]
    func add(_ id: String, _ data: Data?, _ error: Error?) { lock.withLock { values[id] = (data, error) } }
    var all: [String: (data: Data?, error: Error?)] { lock.withLock { values } }
}

/// A settable clock for the negative cache.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_791_000_000)
    var now: @Sendable () -> Date { { [self] in lock.withLock { current } } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}
