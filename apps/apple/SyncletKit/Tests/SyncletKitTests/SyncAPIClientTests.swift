import XCTest
@testable import SyncletKit

final class SyncAPIClientTests: XCTestCase {
    func testBaseURLs() {
        let client = SyncAPIClient(baseURL: URL(string: "https://synclet.dw83.de")!, token: "t")
        XCTAssertEqual(client.apiBaseURL.absoluteString, "https://synclet.dw83.de/api")
        XCTAssertEqual(client.syncBaseURL.absoluteString, "https://synclet.dw83.de/api/sync/v1")
        let local = SyncAPIClient(baseURL: URL(string: "http://localhost:8080")!, token: "t")
        XCTAssertEqual(local.syncBaseURL.absoluteString, "http://localhost:8080/api/sync/v1")
    }

    func testGetItemSendsBearerAndDecodes() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1")) }
        let item = try await Fixtures.client().item(id: "f_1")
        XCTAssertEqual(item.id, "f_1")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/api/sync/v1/items/f_1")
        XCTAssertEqual(request.header("Authorization"), "Bearer syd_test")
    }

    func testTokenProviderIsAskedPerRequest() async throws {
        let counter = Counter()
        let client = SyncAPIClient(baseURL: Fixtures.server, token: { "syd_\(counter.next())" },
                                   session: MockURLProtocol.session())
        MockURLProtocol.reset { _ in .json(200, #"{"cursor":"5"}"#) }
        _ = try await client.cursor()
        _ = try await client.cursor()
        XCTAssertEqual(MockURLProtocol.requests.map { $0.header("Authorization") }, ["Bearer syd_1", "Bearer syd_2"])
    }

    func testFailingTokenProviderIsUnauthorizedWithoutRequest() async {
        struct NoToken: Error {}
        let client = SyncAPIClient(baseURL: Fixtures.server, token: { throw NoToken() }, session: MockURLProtocol.session())
        MockURLProtocol.reset { _ in .json(200, "{}") }
        do {
            _ = try await client.account()
            XCTFail("error expected")
        } catch let error as SyncAPIError {
            XCTAssertTrue(error.isAuthenticationFailure)
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testAccountAndCapabilities() async throws {
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/account": return .json(200, Fixtures.accountJSON())
            case "/api/sync/v1/capabilities": return .json(200, #"{"versions":true,"office":{"enabled":true,"url":"https://office.example.test"}}"#)
            default: return .empty(500)
            }
        }
        let client = Fixtures.client()
        let account = try await client.account()
        XCTAssertEqual(account.spaces.map(\.id), ["personal"])
        let caps = try await client.capabilities()
        XCTAssertTrue(caps.versions)
        XCTAssertEqual(caps.office.url, "https://office.example.test")
    }

    func testCapabilities404MeansOlderServer() async throws {
        MockURLProtocol.reset { _ in .json(404, #"{"statusCode":404,"message":"Cannot GET","error":"Not Found"}"#) }
        let caps = try await Fixtures.client().capabilities()
        XCTAssertEqual(caps, SyncServerCapabilities())
    }

    func testChildrenQuery() async throws {
        MockURLProtocol.reset { _ in .json(200, #"{"items":[],"nextPageToken":null,"cursor":"7"}"#) }
        let page = try await Fixtures.client().children(of: "d_x", pageToken: "abc+/=", limit: 200)
        XCTAssertEqual(page.cursor, "7")
        XCTAssertNil(page.nextPageToken)
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.path, "/api/sync/v1/items/d_x/children")
        XCTAssertEqual(request.query["pageToken"], "abc+/=")
        XCTAssertEqual(request.query["limit"], "200")
        // `+` must be encoded, otherwise the server reads a space.
        XCTAssertTrue(request.request.url!.absoluteString.contains("pageToken=abc%2B%2F%3D"))
    }

    func testChangesAndCursor() async throws {
        MockURLProtocol.reset { request in
            request.path.hasSuffix("/cursor")
                ? .json(200, #"{"cursor":"12"}"#)
                : .json(200, #"{"changes":[{"op":"delete","id":"f_9"}],"cursor":"13","hasMore":false}"#)
        }
        let client = Fixtures.client()
        let cursor = try await client.cursor()
        let page = try await client.changes(since: cursor, limit: 50)
        XCTAssertEqual(page.changes, [.delete(id: "f_9")])
        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.path), ["/api/sync/v1/cursor", "/api/sync/v1/changes"])
        XCTAssertEqual(requests[1].query["cursor"], "12")
        XCTAssertEqual(requests[1].query["limit"], "50")
    }

    // MARK: Error mapping

    func testErrorMappingDeviceRevoked() async {
        MockURLProtocol.reset { _ in .error(401, "device_revoked") }
        await assertThrows(.deviceRevoked) { _ = try await Fixtures.client().account() }
    }

    func testErrorMapping410CursorExpired() async {
        MockURLProtocol.reset { _ in .error(410, "cursor_expired") }
        await assertThrows(.cursorExpired) { _ = try await Fixtures.client().changes(since: "1") }
        XCTAssertEqual(MockURLProtocol.requests.first?.query["cursor"], "1")
    }

    func testErrorMapping412ConflictCarriesItem() async {
        let server = Fixtures.item(id: "f_1", version: 5, contentEtag: "v5", etag: "v5")
        MockURLProtocol.reset { _ in .error(412, "conflict", item: Fixtures.itemJSON(id: "f_1", version: 5, contentEtag: "v5", etag: "v5")) }
        await assertThrows(.conflict(current: server)) {
            _ = try await Fixtures.client().replaceContent(itemID: "f_1", from: Fixtures.tempFile("x"), ifMatch: "v3")
        }
    }

    func testErrorMapping413WithoutJSONBodyFromProxy() async {
        MockURLProtocol.reset { _ in .data(413, Data("<html>Request Entity Too Large</html>".utf8), headers: ["Content-Type": "text/html"]) }
        await assertThrows(.tooLarge(message: nil)) {
            _ = try await Fixtures.client().uploadNewFile(parentID: "root", name: "big.bin", from: Fixtures.tempFile("x"))
        }
    }

    func testErrorMapping429ReadsRetryAfter() async {
        MockURLProtocol.reset { _ in .error(429, "rate_limited", headers: ["Retry-After": "17"]) }
        await assertThrows(.rateLimited(retryAfter: 17)) { _ = try await Fixtures.client().account() }
    }

    func testErrorMapping507InsufficientStorage() async {
        MockURLProtocol.reset { _ in .error(507, "insufficient_storage") }
        await assertThrows(.insufficientStorage(message: "insufficient_storage")) {
            _ = try await Fixtures.client().uploadNewFile(parentID: "root", name: "a.txt", from: Fixtures.tempFile("x"))
        }
    }

    func testErrorMapping428PreconditionRequired() async {
        MockURLProtocol.reset { _ in .error(428, "precondition_required") }
        await assertThrows(.preconditionRequired) {
            _ = try await Fixtures.client().replaceContent(itemID: "f_1", from: Fixtures.tempFile("x"), ifMatch: "v1")
        }
    }

    func testErrorMappingNameConflictCarriesItem() async {
        let existingJSON = Fixtures.folderJSON(id: "d_9", name: "Neu")
        let existing = try! JSONDecoder().decode(SyncItem.self, from: Data(existingJSON.utf8))
        MockURLProtocol.reset { _ in .error(409, "name_conflict", item: existingJSON) }
        await assertThrows(.nameConflict(existing: existing)) {
            _ = try await Fixtures.client().createFolder(parentID: "root", name: "Neu")
        }
        let request = MockURLProtocol.requests.first
        XCTAssertEqual(request?.method, "POST")
        XCTAssertEqual(request?.path, "/api/sync/v1/items")
        XCTAssertEqual(request?.json?["parentId"] as? String, "root")
        XCTAssertEqual(request?.json?["type"] as? String, "folder")
        XCTAssertEqual(request?.json?["name"] as? String, "Neu")
        XCTAssertEqual(request?.json?["onConflict"] as? String, "fail")
    }

    // MARK: Content

    func testReplaceSendsIfMatchAndModifiedAt() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1", version: 4, contentEtag: "v4", etag: "v4")) }
        let modified = Date(timeIntervalSince1970: 1_700_000_000)
        let item = try await Fixtures.client().replaceContent(itemID: "f_1", from: Fixtures.tempFile("Hallo"),
                                                              ifMatch: "v3", modifiedAt: modified)
        XCTAssertEqual(item.contentEtag, "v4")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.path, "/api/sync/v1/items/f_1/content")
        XCTAssertEqual(request.header("Authorization"), "Bearer syd_test")
        XCTAssertEqual(request.header("If-Match"), "\"v3\"")
        XCTAssertEqual(request.header("Content-Type"), "application/octet-stream")
        XCTAssertEqual(request.header("X-Synclet-Modified-At"), "2023-11-14T22:13:20.000Z")
        XCTAssertEqual(request.body, Data("Hallo".utf8))
    }

    func testReplaceWithWildcardIsNotQuoted() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1")) }
        _ = try await Fixtures.client().replaceContent(itemID: "f_1", from: Fixtures.tempFile("x"), ifMatch: "*")
        XCTAssertEqual(MockURLProtocol.requests.first?.header("If-Match"), "*")
    }

    func testUploadNewFileQuery() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_2", name: "Bericht (2).docx")) }
        let item = try await Fixtures.client().uploadNewFile(parentID: "d_1", name: "Bericht & Co.docx",
                                                             from: Fixtures.tempFile("x"), onConflict: .rename)
        XCTAssertEqual(item.name, "Bericht (2).docx")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/sync/v1/items/upload")
        XCTAssertEqual(request.query["parentId"], "d_1")
        XCTAssertEqual(request.query["name"], "Bericht & Co.docx")
        XCTAssertEqual(request.query["onConflict"], "rename")
        XCTAssertNil(request.header("If-Match"))
        XCTAssertNil(request.header("X-Synclet-Modified-At"))
        XCTAssertEqual(request.header("Content-Type"), "application/octet-stream")
    }

    func testMoveAndRenameSendIfMatchAndOnlyChangedFields() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1", name: "Neu.pdf")) }
        let client = Fixtures.client()
        _ = try await client.rename(id: "f_1", to: "Neu.pdf", ifMatch: "v3")
        _ = try await client.move(id: "f_1", toParent: "d_2")
        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["PATCH", "PATCH"])
        XCTAssertEqual(requests.map(\.path), ["/api/sync/v1/items/f_1", "/api/sync/v1/items/f_1"])
        XCTAssertEqual(requests[0].json?.keys.sorted(), ["name"])
        XCTAssertEqual(requests[0].header("If-Match"), "\"v3\"")
        XCTAssertEqual(requests[1].json?.keys.sorted(), ["parentId"])
        XCTAssertEqual(requests[1].json?["parentId"] as? String, "d_2")
        XCTAssertNil(requests[1].header("If-Match"))
    }

    func testDeleteAndDeviceEndpoints() async throws {
        MockURLProtocol.reset { _ in .empty(204) }
        let client = Fixtures.client()
        try await client.deleteItem(id: "f_1")
        try await client.revokeCurrentDevice()
        try await client.revokeDevice(id: "dev-2")
        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["DELETE", "DELETE", "DELETE"])
        XCTAssertEqual(requests.map(\.path), ["/api/sync/v1/items/f_1", "/api/sync/v1/devices/current",
                                              "/api/sync/v1/devices/dev-2"])
    }

    func testRegisterDevice() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.registrationJSON()) }
        let registration = try await Fixtures.client(token: "jwt.access").registerDevice(
            name: "Jens' MacBook", platform: .macos, appVersion: "0.1.0", installationId: "abc")
        XCTAssertTrue(registration.token.hasPrefix("syd_"))
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.path, "/api/sync/v1/devices")
        XCTAssertEqual(request.header("Authorization"), "Bearer jwt.access")
        XCTAssertEqual(request.json?["platform"] as? String, "macos")
        XCTAssertEqual(request.json?["installationId"] as? String, "abc")
    }

    func testDownloadFullAndRange() async throws {
        let destination = FileManager.default.temporaryDirectory.appending(path: "synclet-dl-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: destination) }
        MockURLProtocol.reset { _ in .data(200, Data("Hallo ".utf8), headers: ["ETag": "\"v3\"", "Content-Type": "text/plain"]) }
        let progress = Progress(totalUnitCount: 100)
        let first = try await Fixtures.client().downloadContent(itemID: "f_1", to: destination, progress: progress)
        XCTAssertEqual(first.statusCode, 200)
        XCTAssertEqual(first.etag, "v3")
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "Hallo ")
        XCTAssertEqual(MockURLProtocol.requests.first?.path, "/api/sync/v1/items/f_1/content")
        XCTAssertNil(MockURLProtocol.requests.first?.header("Range"))

        MockURLProtocol.reset { _ in .data(206, Data("Welt".utf8), headers: ["ETag": "\"v3\"", "Content-Range": "bytes 6-9/10"]) }
        let second = try await Fixtures.client().downloadContent(itemID: "f_1", to: destination, resumeFrom: 6, ifRange: "v3")
        XCTAssertEqual(second.statusCode, 206)
        XCTAssertEqual(MockURLProtocol.requests.first?.header("Range"), "bytes=6-")
        XCTAssertEqual(MockURLProtocol.requests.first?.header("If-Range"), "\"v3\"")
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "Hallo Welt")
    }

    func testDownloadNotModifiedAndError() async throws {
        let destination = FileManager.default.temporaryDirectory.appending(path: "synclet-dl-\(UUID().uuidString)")
        MockURLProtocol.reset { _ in .empty(304) }
        await assertThrows(.notModified) {
            _ = try await Fixtures.client().downloadContent(itemID: "f_1", to: destination, ifNoneMatch: "v3")
        }
        XCTAssertEqual(MockURLProtocol.requests.first?.header("If-None-Match"), "\"v3\"")

        MockURLProtocol.reset { _ in .error(404, "not_found") }
        await assertThrows(.notFound) {
            _ = try await Fixtures.client().downloadContent(itemID: "f_1", to: destination)
        }
        MockURLProtocol.reset { _ in .error(416, "range_not_satisfiable", headers: ["Content-Range": "bytes */10"]) }
        await assertThrows(.rangeNotSatisfiable) {
            _ = try await Fixtures.client().downloadContent(itemID: "f_1", to: destination, resumeFrom: 20)
        }
    }

    func testThumbnail() async throws {
        let client = Fixtures.client()
        let url = try client.thumbnailURL(itemID: "f_1", size: 1024)
        XCTAssertEqual(url.absoluteString, "https://synclet.example.test/api/sync/v1/items/f_1/thumbnail?size=1024")

        MockURLProtocol.reset { _ in .data(200, Data([1, 2, 3]), headers: ["ETag": "\"abc-256\"", "Content-Type": "image/webp"]) }
        let thumb = try await client.thumbnail(itemID: "f_1")
        XCTAssertEqual(thumb, SyncThumbnail(data: Data([1, 2, 3]), etag: "abc-256"))
        XCTAssertEqual(MockURLProtocol.requests.first?.query["size"], "256")
        XCTAssertEqual(MockURLProtocol.requests.first?.header("Authorization"), "Bearer syd_test")

        MockURLProtocol.reset { _ in .error(404, "not_found") }
        let none = try await client.thumbnail(itemID: "f_1")
        XCTAssertNil(none)
    }

    func testTransportError() async {
        MockURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await Fixtures.client().cursor()
            XCTFail("error expected")
        } catch let SyncAPIError.transport(code, _) {
            XCTAssertEqual(code, .notConnectedToInternet)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testETagQuoting() {
        XCTAssertEqual(SyncAPIClient.unquoted("\"v3\""), "v3")
        XCTAssertEqual(SyncAPIClient.unquoted("W/\"v3\""), "v3")
        XCTAssertEqual(SyncAPIClient.unquoted("v3"), "v3")
        XCTAssertEqual(SyncAPIClient.quoted("v3"), "\"v3\"")
        XCTAssertEqual(SyncAPIClient.quoted("\"v3\""), "\"v3\"")
        XCTAssertEqual(SyncAPIClient.quoted("*"), "*")
    }
}
