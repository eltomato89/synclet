import Foundation
import SyncletKit
import XCTest
@testable import Synclet

final class FileCacheTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-filecache-\(UUID().uuidString)")
        MockURLProtocol.reset { request in
            // /api/sync/v1/items/<id>/content → "<id>:v<n>" padded to 6 bytes
            let parts = request.path.split(separator: "/")
            guard parts.count == 6, parts[5] == "content" else { return Items.error(404, "not_found") }
            return .data(200, Data("\(parts[4])12345".prefix(6).utf8), headers: ["ETag": "\"v1\""])
        }
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var contentGETs: Int {
        MockURLProtocol.requests.filter { $0.path.hasSuffix("/content") }.count
    }

    private func client() -> SyncAPIClient {
        SyncAPIClient(baseURL: FakeFolderServer.base, token: "syd_test", session: MockURLProtocol.session())
    }

    func testFileCacheHitMissOnVersionChangeAndLRU() async throws {
        let cache = FileCache(directory: directory, limitBytes: 10)
        let api = client()
        let v1 = Items.file("Bericht.pdf", id: "a", version: 1)

        let first = try await cache.localURL(for: v1, api: api, progress: Progress())
        XCTAssertEqual(first.lastPathComponent, "Bericht.pdf", "stored under the item name for QuickLook")
        XCTAssertEqual(try Data(contentsOf: first).count, 6)
        let second = try await cache.localURL(for: v1, api: api, progress: Progress())
        XCTAssertEqual(second, first)
        XCTAssertEqual(contentGETs, 1, "same version: a hit")

        var v2 = v1
        v2.version = 2
        v2.contentEtag = "v2"
        let third = try await cache.localURL(for: v2, api: api, progress: Progress())
        XCTAssertEqual(contentGETs, 2, "another version: a miss")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "the old version is evicted")
        XCTAssertTrue(FileManager.default.fileExists(atPath: third.path))

        // 6 + 6 bytes > 10: the least recently used file goes.
        let b = Items.file("b.txt", id: "b")
        let fileB = try await cache.localURL(for: b, api: api, progress: Progress())
        XCTAssertEqual(contentGETs, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: third.path), "oldest evicted")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileB.path))
    }

    func testLRUKeepsRecentlyUsed() async throws {
        let cache = FileCache(directory: directory, limitBytes: 13)
        let api = client()
        let a = Items.file("a.txt", id: "a"), b = Items.file("b.txt", id: "b"), c = Items.file("c.txt", id: "c")
        let urlA = try await cache.localURL(for: a, api: api, progress: Progress())
        let urlB = try await cache.localURL(for: b, api: api, progress: Progress())
        _ = try await cache.localURL(for: a, api: api, progress: Progress()) // a is now the most recent
        let urlC = try await cache.localURL(for: c, api: api, progress: Progress())
        XCTAssertTrue(FileManager.default.fileExists(atPath: urlA.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: urlB.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: urlC.path))
        XCTAssertEqual(contentGETs, 3)
    }

    func testRenamedItemKeepsContentUnderNewName() async throws {
        let cache = FileCache(directory: directory)
        let api = client()
        var item = Items.file("old.txt", id: "a")
        _ = try await cache.localURL(for: item, api: api, progress: Progress())
        item.name = "new.txt"
        let url = try await cache.localURL(for: item, api: api, progress: Progress())
        XCTAssertEqual(url.lastPathComponent, "new.txt")
        XCTAssertEqual(contentGETs, 1)
    }

    func testClearRemovesEverything() async throws {
        let cache = FileCache(directory: directory)
        let api = client()
        let url = try await cache.localURL(for: Items.file("a.txt", id: "a"), api: api, progress: Progress())
        await cache.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        _ = try await cache.localURL(for: Items.file("a.txt", id: "a"), api: api, progress: Progress())
        XCTAssertEqual(contentGETs, 2)
    }

    func testFailedDownloadThrowsAndCachesNothing() async throws {
        MockURLProtocol.reset { _ in Items.error(404, "not_found") }
        let cache = FileCache(directory: directory)
        do {
            _ = try await cache.localURL(for: Items.file("a.txt", id: "a"), api: client(), progress: Progress())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? SyncAPIError, .notFound)
        }
    }
}
