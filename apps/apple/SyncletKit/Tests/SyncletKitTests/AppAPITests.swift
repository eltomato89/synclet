import XCTest
@testable import SyncletKit

final class AppAPITests: XCTestCase {
    func testSearchBuildsQueryAndDecodes() async throws {
        MockURLProtocol.reset { _ in .json(200, #"{"hits":[{"item":\#(Fixtures.itemJSON(id: "f_1")),"path":"Docs","snippet":"a «b» c","matched":"content"}],"total":1}"#) }
        let result = try await Fixtures.client().search("b c", folder: "d_1", limit: 10, offset: 20)
        XCTAssertEqual(result.total, 1); XCTAssertEqual(result.hits.first?.path, "Docs")
        let r = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(r.path, "/api/sync/v1/search")
        XCTAssertEqual(r.query["q"], "b c"); XCTAssertEqual(r.query["folder"], "d_1")
        XCTAssertEqual(r.query["limit"], "10"); XCTAssertEqual(r.query["offset"], "20")
    }

    func testSearchNullSnippet() async throws {
        MockURLProtocol.reset { _ in .json(200, #"{"hits":[{"item":\#(Fixtures.itemJSON(id: "f_1")),"path":"","snippet":null,"matched":"name"}],"total":1}"#) }
        let result = try await Fixtures.client().search("x")
        XCTAssertNil(result.hits.first?.snippet)
        XCTAssertNil(MockURLProtocol.requests.first?.query["folder"])
    }

    func testRecent() async throws {
        MockURLProtocol.reset { _ in .json(200, "[\(Fixtures.itemJSON(id: "f_1"))]") }
        let items = try await Fixtures.client().recent()
        XCTAssertEqual(items.map(\.id), ["f_1"])
        let r = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(r.method, "GET"); XCTAssertEqual(r.path, "/api/sync/v1/recent"); XCTAssertEqual(r.query["limit"], "50")
    }

    func testTrashListRestoreDeleteEmpty() async throws {
        MockURLProtocol.reset { r in
            switch (r.method, r.path) {
            case ("GET", "/api/trash"): return .json(200, "[\(Fixtures.trashEntryJSON())]")
            case ("POST", "/api/trash/t1/restore"):
                return .json(200, #"{"item":\#(Fixtures.itemJSON(id: "f_9")),"restoredTo":"Docs","renamed":true}"#)
            case ("DELETE", "/api/trash/t1"): return .empty(204)
            case ("DELETE", "/api/trash"): return .json(200, #"{"removed":3}"#)
            default: return .error(404, "not_found")
            }
        }
        let client = Fixtures.client()
        let entries = try await client.trash()
        XCTAssertEqual(entries.first?.id, "t1"); XCTAssertEqual(entries.first?.size, 2048)
        XCTAssertEqual(entries.first?.type, .file); XCTAssertNil(entries.first?.expiresAt)
        let restored = try await client.restoreFromTrash(id: "t1")
        XCTAssertEqual(restored.restoredTo, "Docs"); XCTAssertTrue(restored.renamed)
        try await client.deleteFromTrash(id: "t1")
        let removed = try await client.emptyTrash()
        XCTAssertEqual(removed, 3)
        XCTAssertEqual(MockURLProtocol.requests.map { "\($0.method) \($0.path)" },
                       ["GET /api/trash", "POST /api/trash/t1/restore", "DELETE /api/trash/t1", "DELETE /api/trash"])
    }

    func testTrashRestoreConflict409IsReported() async {
        MockURLProtocol.reset { _ in .error(409, "conflict") }
        let expected = SyncAPIError.from(status: 409, body: SyncErrorBody(statusCode: 409, message: "conflict", code: "conflict", item: nil))
        await assertThrows(expected) { _ = try await Fixtures.client().restoreFromTrash(id: "t1") }
    }

    func testCreateShareLinkBody() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.shareJSON(url: "https://x/s/abc")) }
        let exp = ISO8601DateFormatter().date(from: "2030-01-01T00:00:00Z")!
        _ = try await Fixtures.client().createShareLink(itemID: "d_1", options: .init(password: "pw", expiresAt: exp, allowDownload: true, allowUpload: true))
        let r = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(r.method, "POST"); XCTAssertEqual(r.path, "/api/shares")
        let body = try XCTUnwrap(r.jsonBody)
        XCTAssertEqual(body["itemId"] as? String, "d_1"); XCTAssertEqual(body["password"] as? String, "pw")
        XCTAssertEqual(body["expiresAt"] as? String, "2030-01-01T00:00:00Z"); XCTAssertEqual(body["allowUpload"] as? Bool, true)
        XCTAssertEqual(body["allowDownload"] as? Bool, true)
    }

    func testCreateShareLinkOmitsUnset() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.shareJSON(url: "/s/abc")) }
        _ = try await Fixtures.client().createShareLink(itemID: "d_1", options: .init())
        XCTAssertEqual(MockURLProtocol.requests.first?.bodyString, #"{"itemId":"d_1"}"#)
    }

    func testPatchShareLinkRemovesPasswordWithNullAndOmitsUnset() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.shareJSON(url: "/s/abc")) }
        _ = try await Fixtures.client().updateShareLink(id: "s1", options: .init(password: .some(nil)))
        let r = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(r.method, "PATCH"); XCTAssertEqual(r.path, "/api/shares/s1")
        XCTAssertEqual(r.bodyString, #"{"password":null}"#)
    }

    func testListShareLinks() async throws {
        MockURLProtocol.reset { _ in .json(200, "[\(Fixtures.shareJSON(url: "/s/abc"))]") }
        let links = try await Fixtures.client().shareLinks(itemID: "d_1")
        XCTAssertEqual(links.first?.hits, 4); XCTAssertTrue(links.first?.isActive ?? false)
        XCTAssertEqual(MockURLProtocol.requests.first?.query["itemId"], "d_1")
    }

    func testRelativeShareURLResolvesAgainstServer() throws {
        let link = try JSONDecoder().decode(ShareLink.self, from: Data(Fixtures.shareJSON(url: "/s/abc").utf8))
        XCTAssertEqual(link.absoluteURL(server: URL(string: "https://synclet.dw83.de")!)?.absoluteString, "https://synclet.dw83.de/s/abc")
        let abs = try JSONDecoder().decode(ShareLink.self, from: Data(Fixtures.shareJSON(url: "https://pub.example/s/abc").utf8))
        XCTAssertEqual(abs.absoluteURL(server: URL(string: "https://synclet.dw83.de")!)?.absoluteString, "https://pub.example/s/abc")
    }

    func testTrashedLinkIsInactive() throws {
        let link = try JSONDecoder().decode(ShareLink.self, from: Data(Fixtures.shareJSON(url: "/s/a", itemTrashed: true).utf8))
        XCTAssertFalse(link.isActive)
    }

    func testRevokeShareLink() async throws {
        MockURLProtocol.reset { _ in .empty(204) }
        try await Fixtures.client().revokeShareLink(id: "s1")
        let r = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(r.method, "DELETE"); XCTAssertEqual(r.path, "/api/shares/s1")
    }
}
