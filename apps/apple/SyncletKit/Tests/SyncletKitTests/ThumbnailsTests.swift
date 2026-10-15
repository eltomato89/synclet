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

    private func image(id: String = "f_1", name: String = "Foto.png", contentEtag: String = "c1", type: String = "file") -> SyncItem {
        Fixtures.item(id: id, type: type, name: name, contentEtag: contentEtag, etag: "m-" + contentEtag)
    }

    private func thumbnailServer(body: Data = Data("WEBP".utf8)) {
        MockURLProtocol.reset { request in
            guard request.path.hasSuffix("/thumbnail") else { return .empty(500) }
            return .data(200, body, headers: ["Content-Type": "image/webp", "ETag": "\"sha-\(request.query["size"] ?? "")\""])
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

    func testFetchRequestsTheBucketAndCachesByEtag() async throws {
        thumbnailServer()
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
        let data = try await fetcher.thumbnail(for: image(), requestedSize: CGSize(width: 900, height: 900), client: Fixtures.client())
        XCTAssertEqual(data, Data("WEBP".utf8))
        XCTAssertEqual(MockURLProtocol.requests.map(\.path), ["/api/sync/v1/items/f_1/thumbnail"])
        XCTAssertEqual(MockURLProtocol.requests.first?.query["size"], "1024")
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDir.appending(path: "f_1-c1-1024.webp").path))

        // Same content etag ⇒ served from the cache, no request.
        MockURLProtocol.reset { request in
            XCTFail("unexpected request \(request.path)")
            return .empty(500)
        }
        let again = try await fetcher.thumbnail(for: image(), requestedSize: CGSize(width: 1024, height: 1024), client: Fixtures.client())
        XCTAssertEqual(again, Data("WEBP".utf8))
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testNewContentEtagMissesTheCache() async throws {
        thumbnailServer(body: Data("OLD".utf8))
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
        _ = try await fetcher.thumbnail(for: image(contentEtag: "c1"), requestedSize: CGSize(width: 128, height: 128), client: Fixtures.client())
        thumbnailServer(body: Data("NEW".utf8))
        let data = try await fetcher.thumbnail(for: image(contentEtag: "c2"), requestedSize: CGSize(width: 128, height: 128), client: Fixtures.client())
        XCTAssertEqual(data, Data("NEW".utf8))
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
        XCTAssertEqual(MockURLProtocol.requests.first?.query["size"], "256")
    }

    func testMissingThumbnailIsNilWithoutError() async throws {
        for status in [404, 415] {
            MockURLProtocol.reset { _ in .error(status, status == 404 ? "not_found" : "invalid_request") }
            let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
            let data = try await fetcher.thumbnail(for: image(), requestedSize: CGSize(width: 256, height: 256), client: Fixtures.client())
            XCTAssertNil(data, "\(status)")
        }
        let files = try FileManager.default.contentsOfDirectory(atPath: tempDir.path)
        XCTAssertEqual(files, [], "nothing cached for a missing thumbnail")
    }

    func testFoldersAndTypesWithoutThumbnailsSendNoRequest() async throws {
        MockURLProtocol.reset { request in
            XCTFail("unexpected request \(request.path)")
            return .empty(500)
        }
        let fetcher = ThumbnailFetcher(cache: ThumbnailCache(directory: tempDir))
        let folder = Fixtures.item(id: "d_1", type: "folder", name: "Fotos")
        let root = Fixtures.item(id: "root", parentId: nil, type: "folder", name: "")
        let text = image(name: "Notizen.txt")
        for item in [folder, root, text] {
            let data = try await fetcher.thumbnail(for: item, requestedSize: CGSize(width: 256, height: 256), client: Fixtures.client())
            XCTAssertNil(data, item.name)
        }
    }

    func testThumbnailableTypesFollowTheContract() {
        for name in ["a.JPG", "b.jpeg", "c.png", "d.gif", "e.webp", "f.avif", "g.heic", "h.heif", "i.tif", "j.tiff",
                     "k.bmp", "l.svg", "m.pdf", "n.mp4", "o.m4v", "p.mov", "q.webm", "r.mkv"] {
            XCTAssertTrue(ThumbnailFetcher.mayHaveThumbnail(image(name: name)), name)
        }
        for name in ["a.txt", "b.docx", "noextension", "c.zip"] {
            XCTAssertFalse(ThumbnailFetcher.mayHaveThumbnail(image(name: name)), name)
        }
    }

    // MARK: Cache

    func testCacheFileNameIsSafe() {
        XCTAssertEqual(ThumbnailCache.fileName(itemID: "f_1", etag: "c1", size: 256), "f_1-c1-256.webp")
        let odd = ThumbnailCache.fileName(itemID: "a/b", etag: "\"x:y\"", size: 1024)
        XCTAssertFalse(odd.contains("/"))
        XCTAssertFalse(odd.contains(":"))
        XCTAssertTrue(odd.hasSuffix("-1024.webp"))
    }

    func testCacheEvictsLeastRecentlyUsedAboveTheLimit() throws {
        let cache = ThumbnailCache(directory: tempDir, maxBytes: 3000)
        let blob = Data(repeating: 7, count: 1000)
        cache.store(blob, itemID: "a", etag: "1", size: 256)
        cache.store(blob, itemID: "b", etag: "1", size: 256)
        cache.store(blob, itemID: "c", etag: "1", size: 256)
        // Make "a" the oldest, then use it ⇒ "b" becomes the least recently used.
        let fm = FileManager.default
        for (index, name) in ["a", "b", "c"].enumerated() {
            try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(index - 100))],
                                 ofItemAtPath: tempDir.appending(path: "\(name)-1-256.webp").path)
        }
        XCTAssertNotNil(cache.data(itemID: "a", etag: "1", size: 256))
        cache.store(blob, itemID: "d", etag: "1", size: 256)
        let names = Set(try fm.contentsOfDirectory(atPath: tempDir.path))
        XCTAssertFalse(names.contains("b-1-256.webp"), "\(names)")
        XCTAssertTrue(names.contains("a-1-256.webp"))
        XCTAssertTrue(names.contains("d-1-256.webp"))
        let total = names.compactMap { (try? fm.attributesOfItem(atPath: tempDir.appending(path: $0).path)[.size]) as? Int }.reduce(0, +)
        XCTAssertLessThanOrEqual(total, 3000)
    }

    func testDefaultCacheLimitIs200MB() {
        XCTAssertEqual(ThumbnailCache.defaultMaxBytes, 200 * 1024 * 1024)
        XCTAssertTrue(ThumbnailCache.defaultDirectory().path.hasSuffix("Caches/thumbnails"))
    }

    // MARK: Extension (NSFileProviderThumbnailing)

    private func makeExtension() -> SyncletReplicatedExtension {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "Synclet – jens@test")
        let context = SyncletReplicatedExtension.Context(client: Fixtures.client(), deviceName: "Mac", layout: Fixtures.layout)
        return SyncletReplicatedExtension(domain: domain, temporaryDirectory: tempDir) { context }
    }

    func testFetchThumbnailsReportsEachItem() async throws {
        let png = Fixtures.itemJSON(id: "f_png", name: "Foto.png", contentEtag: "p1")
        let pdf = Fixtures.itemJSON(id: "f_pdf", name: "Plan.pdf", contentEtag: "q1")
        let folder = Fixtures.folderJSON(id: "d_1", name: "Fotos")
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/f_png": return .json(200, png)
            case "/api/sync/v1/items/f_pdf": return .json(200, pdf)
            case "/api/sync/v1/items/d_1": return .json(200, folder)
            case "/api/sync/v1/items/f_png/thumbnail": return .data(200, Data("PNG".utf8), headers: ["ETag": "\"x-256\""])
            case "/api/sync/v1/items/f_pdf/thumbnail": return .error(404, "not_found")
            case "/api/sync/v1/items/f_gone": return .error(404, "not_found")
            default: return .empty(500)
            }
        }
        let ext = makeExtension()
        let ids = ["f_png", "f_pdf", "d_1", "f_gone", "space:personal", NSFileProviderItemIdentifier.rootContainer.rawValue]
            .map { NSFileProviderItemIdentifier($0) }
        let results = ResultsBox()
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.fetchThumbnails(for: ids, requestedSize: CGSize(width: 256, height: 256),
                                    perThumbnailCompletionHandler: { id, data, error in results.add(id.rawValue, data, error) },
                                    completionHandler: { continuation.resume(returning: $0) })
        }
        XCTAssertNil(error)
        let byID = results.all
        XCTAssertEqual(byID.count, ids.count)
        XCTAssertEqual(byID["f_png"]?.data, Data("PNG".utf8))
        for id in ["f_pdf", "d_1", "f_gone", "space:personal", NSFileProviderItemIdentifier.rootContainer.rawValue] {
            XCTAssertNil(byID[id]?.data, id)
            XCTAssertNil(byID[id]?.error, id)
        }
        // Folders and the virtual top level never ask for a thumbnail.
        let paths = MockURLProtocol.requests.map(\.path)
        XCTAssertFalse(paths.contains("/api/sync/v1/items/d_1/thumbnail"))
        XCTAssertFalse(paths.contains { $0.contains("space") || $0.contains("root") })
        // Cached in the extension's thumbnail directory.
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDir.appending(path: "thumbnails/f_png-p1-256.webp").path))
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
