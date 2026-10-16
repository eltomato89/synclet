import Foundation
import SyncletKit
import UIKit
import XCTest
@testable import Synclet

final class ThumbnailCacheTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-thumbs-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    static let png: Data = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { context in
        UIColor.red.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }

    private func client() -> SyncAPIClient {
        SyncAPIClient(baseURL: FakeFolderServer.base, token: "syd_test", session: MockURLProtocol.session())
    }

    private var thumbnailRequests: [RecordedRequest] {
        MockURLProtocol.requests.filter { $0.path.hasSuffix("/thumbnail") }
    }

    /// 200 with an ETag, or 304 when `If-None-Match` matches.
    private func serveThumbnails() {
        MockURLProtocol.reset { request in
            if request.request.value(forHTTPHeaderField: "If-None-Match") == "\"t1\"" { return .empty(304) }
            return .data(200, Self.png, contentType: "image/webp", headers: ["ETag": "\"t1\""])
        }
    }

    func testThumbnailCacheRevalidatesOncePerSession() async {
        serveThumbnails()
        let item = Items.file("photo.jpg", thumbnail: true)
        let api = client()

        let cache = ThumbnailCache(directory: directory)
        let first = await cache.image(for: item, api: api)
        XCTAssertNotNil(first)
        XCTAssertEqual(thumbnailRequests.count, 1)
        XCTAssertNil(thumbnailRequests[0].request.value(forHTTPHeaderField: "If-None-Match"))

        let second = await cache.image(for: item, api: api)
        XCTAssertNotNil(second)
        XCTAssertEqual(thumbnailRequests.count, 1, "no request again in the same session")

        // Next app session: revalidate with the stored ETag; 304 uses the stored bytes.
        let relaunched = ThumbnailCache(directory: directory)
        let third = await relaunched.image(for: item, api: api)
        XCTAssertNotNil(third)
        XCTAssertEqual(thumbnailRequests.count, 2)
        XCTAssertEqual(thumbnailRequests[1].request.value(forHTTPHeaderField: "If-None-Match"), "\"t1\"")
        _ = await relaunched.image(for: item, api: api)
        XCTAssertEqual(thumbnailRequests.count, 2)
    }

    func testOnlyItemsWithThumbnails() async {
        serveThumbnails()
        let cache = ThumbnailCache(directory: directory)
        let image = await cache.image(for: Items.file("notes.txt", thumbnail: false), api: client())
        XCTAssertNil(image)
        let folder = await cache.image(for: Items.folder("Fotos"), api: client())
        XCTAssertNil(folder)
        XCTAssertTrue(thumbnailRequests.isEmpty)
    }

    func testOfflineFallsBackToStoredData() async {
        serveThumbnails()
        let item = Items.file("photo.jpg", thumbnail: true)
        _ = await ThumbnailCache(directory: directory).image(for: item, api: client())
        MockURLProtocol.reset { _ in .failure(.notConnectedToInternet) }
        let image = await ThumbnailCache(directory: directory).image(for: item, api: client())
        XCTAssertNotNil(image)
    }

    func testLRUEviction() async {
        serveThumbnails()
        let limit = Self.png.count * 2 + Self.png.count / 2
        let cache = ThumbnailCache(directory: directory, limitBytes: limit)
        let api = client()
        let a = Items.file("a.jpg", thumbnail: true), b = Items.file("b.jpg", thumbnail: true)
        let c = Items.file("c.jpg", thumbnail: true)
        _ = await cache.image(for: a, api: api)
        _ = await cache.image(for: b, api: api)
        _ = await cache.image(for: a, api: api) // a used again
        _ = await cache.image(for: c, api: api) // over the limit: b goes
        XCTAssertEqual(thumbnailRequests.count, 3)
        let fresh = ThumbnailCache(directory: directory, limitBytes: limit)
        MockURLProtocol.reset { _ in .failure(.notConnectedToInternet) }
        let storedA = await fresh.image(for: a, api: api)
        let storedB = await fresh.image(for: b, api: api)
        let storedC = await fresh.image(for: c, api: api)
        XCTAssertNotNil(storedA)
        XCTAssertNil(storedB, "least recently used thumbnail evicted")
        XCTAssertNotNil(storedC)
    }

    func testClear() async {
        serveThumbnails()
        let item = Items.file("photo.jpg", thumbnail: true)
        let cache = ThumbnailCache(directory: directory)
        _ = await cache.image(for: item, api: client())
        await cache.clear()
        MockURLProtocol.reset { _ in .failure(.notConnectedToInternet) }
        let image = await cache.image(for: item, api: client())
        XCTAssertNil(image)
    }
}
