import XCTest
@testable import SyncletKit

final class ModelsTests: XCTestCase {
    func testDecodesSyncItem() throws {
        let item = try JSONDecoder().decode(SyncItem.self, from: Data(Fixtures.itemJSON(id: "f_abc", sha256: "ab12").utf8))
        XCTAssertEqual(item.id, "f_abc")
        XCTAssertEqual(item.parentId, "root")
        XCTAssertEqual(item.type, .file)
        XCTAssertEqual(item.kind, .file)
        XCTAssertEqual(item.size, 1234)
        XCTAssertEqual(item.version, 3)
        XCTAssertEqual(item.sha256, "ab12")
        XCTAssertEqual(item.contentEtag, "v3")
        XCTAssertEqual(item.documentId, "f_abc")
        XCTAssertEqual(item.preview, SyncPreview(kind: "pdf", thumbnail: false))
        XCTAssertTrue(item.capabilities.write)
        XCTAssertFalse(item.capabilities.addChildren)
        XCTAssertEqual(try XCTUnwrap(item.modifiedDate).timeIntervalSince1970, 1_790_944_215.123, accuracy: 0.0005)
        XCTAssertNotNil(item.createdDate)
    }

    func testDecodesRootWithNullParent() throws {
        let json = Fixtures.itemJSON(id: "root", parentId: nil, type: "folder", name: "jens", etag: "t0")
        let item = try JSONDecoder().decode(SyncItem.self, from: Data(json.utf8))
        XCTAssertNil(item.parentId)
        XCTAssertEqual(item.kind, .root)
        XCTAssertTrue(item.isFolder)
        XCTAssertNil(item.version)
        XCTAssertFalse(item.capabilities.rename)
        XCTAssertTrue(item.capabilities.addChildren)
    }

    func testUnknownItemKindAndExtraFieldsAreTolerated() throws {
        let json = #"{"id":"x_1","parentId":"root","type":"folder","kind":"mount","name":"N","size":0,"mime":null,"version":null,"sha256":null,"etag":"t1","contentEtag":null,"createdAt":"2026-10-15T07:08:09.123Z","modifiedAt":"2026-10-15T07:08:09.123Z","documentId":null,"capabilities":{"read":true,"write":false,"rename":false,"move":false,"delete":false,"addChildren":false},"futureField":{"a":1}}"#
        let item = try JSONDecoder().decode(SyncItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.kind, .unknown("mount"))
        XCTAssertEqual(item.kind.rawValue, "mount")
        XCTAssertNil(item.preview)
    }

    func testDecodesChangesUnion() throws {
        let json = """
        {"changes":[{"op":"upsert","item":\(Fixtures.itemJSON(id: "f_1"))},{"op":"delete","id":"d_2"}],
         "cursor":"9007199254740993","hasMore":true}
        """
        let page = try JSONDecoder().decode(ChangesPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.cursor, "9007199254740993")
        XCTAssertTrue(page.hasMore)
        XCTAssertEqual(page.changes.count, 2)
        guard case .upsert(let item) = page.changes[0] else { return XCTFail("upsert expected") }
        XCTAssertEqual(item.id, "f_1")
        XCTAssertEqual(page.changes[1], .delete(id: "d_2"))
        XCTAssertEqual(page.changes.map(\.itemID), ["f_1", "d_2"])

        let again = try JSONDecoder().decode(SyncChangesPage.self, from: JSONEncoder().encode(page))
        XCTAssertEqual(again, page)
    }

    func testUnknownChangeOpFails() {
        let json = #"{"changes":[{"op":"move","id":"x"}],"cursor":"1","hasMore":false}"#
        XCTAssertThrowsError(try JSONDecoder().decode(SyncChangesPage.self, from: Data(json.utf8)))
    }

    // MARK: Spaces

    func testPhase1cAccountWithoutSpacesSynthesizesPersonal() throws {
        let account = try JSONDecoder().decode(SyncAccount.self, from: Data(Fixtures.phase1cAccountJSON.utf8))
        XCTAssertNil(account.email)
        XCTAssertEqual(account.slug, "jens")
        XCTAssertEqual(account.username, "jens")
        XCTAssertEqual(account.accountKey, "5e0c1a52-3b7f-4d0e-a8f1-9c2b7d6e4f10:0b6f6d0e-7a39-4c1e-9d3b-1f2e3d4c5b6a")
        XCTAssertEqual(account.maxUploadBytes, 10_737_418_240)
        XCTAssertEqual(account.cursor, "42")
        XCTAssertEqual(account.spaces, [SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien",
                                                  rootId: "root", canWrite: true)])
    }

    func testAccountWithSpacesIncludingUnknownKind() throws {
        let spaces = #"[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true},{"id":"s_9","kind":"team","name":"Team","rootId":"d_9","canWrite":false,"extra":1},{"id":"x","kind":"shared","name":"Geteilt","rootId":"d_x","canWrite":true}]"#
        let account = try JSONDecoder().decode(SyncAccount.self, from: Data(Fixtures.accountJSON(spaces: spaces).utf8))
        XCTAssertEqual(account.spaces.map(\.id), ["personal", "s_9", "x"])
        XCTAssertEqual(account.spaces.map(\.kind), [.personal, .unknown("team"), .shared])
        XCTAssertEqual(account.spaces[1].rootId, "d_9")
        XCTAssertFalse(account.spaces[1].canWrite)

        // Round trip keeps unknown kinds.
        let again = try JSONDecoder().decode(SyncAccount.self, from: JSONEncoder().encode(account))
        XCTAssertEqual(again, account)
    }

    func testDecodesRegistration() throws {
        let registration = try JSONDecoder().decode(DeviceRegistration.self, from: Data(Fixtures.registrationJSON().utf8))
        XCTAssertTrue(registration.token.hasPrefix("syd_"))
        XCTAssertEqual(registration.device.platform, "macos")
        XCTAssertNil(registration.device.lastSeenAt)
        XCTAssertEqual(registration.account.organizationId, "srv1:u1")
        XCTAssertEqual(registration.account.spaces.first?.rootId, "root")
    }

    func testDecodesAppTokens() throws {
        let json = #"{"accessToken":"eyJ.a.b","refreshToken":"syr_x","user":{"id":"u1","username":"jens","displayName":"Jens","email":null,"role":"admin"}}"#
        let tokens = try JSONDecoder().decode(AppTokens.self, from: Data(json.utf8))
        XCTAssertEqual(tokens.user.username, "jens")
        XCTAssertNil(tokens.user.email)
        XCTAssertEqual(tokens.refreshToken, "syr_x")
    }

    func testServerCapabilities() throws {
        let caps = try JSONDecoder().decode(SyncServerCapabilities.self,
                                            from: Data(#"{"versions":true,"office":{"enabled":false,"url":null}}"#.utf8))
        XCTAssertTrue(caps.versions)
        XCTAssertFalse(caps.office.enabled)
    }

    func testErrorBodyWithMessageArray() throws {
        let json = #"{"statusCode":400,"message":["name must be a string","x"],"error":"Bad Request"}"#
        let body = try JSONDecoder().decode(SyncErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.message, "name must be a string; x")
        XCTAssertNil(body.code)
    }

    func testErrorMappingFromStatusAndCode() {
        let item = Fixtures.item(id: "f_1")
        func body(_ status: Int, _ code: String?, _ item: SyncItem? = nil) -> SyncErrorBody {
            SyncErrorBody(statusCode: status, message: "m", code: code, item: item)
        }
        XCTAssertEqual(SyncAPIError.from(status: 401, body: body(401, "device_revoked")), .deviceRevoked)
        XCTAssertEqual(SyncAPIError.from(status: 401, body: nil), .unauthorized(message: nil))
        XCTAssertEqual(SyncAPIError.from(status: 403, body: body(403, "forbidden")), .forbidden(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 403, body: body(403, "password_login_disabled")), .passwordLoginDisabled)
        XCTAssertEqual(SyncAPIError.from(status: 404, body: nil), .notFound)
        XCTAssertEqual(SyncAPIError.from(status: 409, body: body(409, "name_conflict", item)), .nameConflict(existing: item))
        XCTAssertEqual(SyncAPIError.from(status: 409, body: body(409, "setup_done")), .setupDone)
        XCTAssertEqual(SyncAPIError.from(status: 400, body: body(400, "invalid_move")), .invalidMove(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 400, body: body(400, "invalid_name")), .invalidName(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 400, body: body(400, "invalid_request")), .invalidRequest(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 415, body: body(415, "invalid_request")), .invalidRequest(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 410, body: body(410, "cursor_expired")), .cursorExpired)
        XCTAssertEqual(SyncAPIError.from(status: 412, body: body(412, "conflict", item)), .conflict(current: item))
        XCTAssertEqual(SyncAPIError.from(status: 428, body: body(428, "precondition_required")), .preconditionRequired)
        XCTAssertEqual(SyncAPIError.from(status: 413, body: nil), .tooLarge(message: nil))
        XCTAssertEqual(SyncAPIError.from(status: 416, body: body(416, "range_not_satisfiable")), .rangeNotSatisfiable)
        XCTAssertEqual(SyncAPIError.from(status: 429, body: body(429, "rate_limited"), retryAfter: 12), .rateLimited(retryAfter: 12))
        XCTAssertEqual(SyncAPIError.from(status: 507, body: body(507, "insufficient_storage")), .insufficientStorage(message: "m"))
        XCTAssertEqual(SyncAPIError.from(status: 500, body: nil), .http(status: 500, code: nil, message: nil))
        XCTAssertEqual(SyncAPIError.from(status: 423, body: nil), .http(status: 423, code: nil, message: nil))
        XCTAssertTrue(SyncAPIError.http(status: 503, code: nil, message: nil).isTransient)
        XCTAssertTrue(SyncAPIError.http(status: 423, code: nil, message: nil).isTransient)
        XCTAssertTrue(SyncAPIError.insufficientStorage(message: nil).isTransient)
        XCTAssertFalse(SyncAPIError.tooLarge(message: nil).isTransient)
        XCTAssertTrue(SyncAPIError.deviceRevoked.isAuthenticationFailure)
    }

    func testRetryAfterParsing() {
        XCTAssertEqual(SyncAPIError.retryAfter(header: "30"), 30)
        XCTAssertNil(SyncAPIError.retryAfter(header: nil))
        XCTAssertNil(SyncAPIError.retryAfter(header: "soon"))
        let now = Date(timeIntervalSince1970: 1_784_000_000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let date = formatter.string(from: now.addingTimeInterval(60))
        XCTAssertEqual(try XCTUnwrap(SyncAPIError.retryAfter(header: date, now: now)), 60, accuracy: 1)
    }

    func testLocalizedErrorDescriptionsExist() {
        let english = SyncAPIError.tooLarge(message: nil).errorDescription ?? ""
        XCTAssertTrue(["The file is too large for this server.", "Die Datei ist für diesen Server zu groß."].contains(english))
        XCTAssertEqual(L10n.string("error.tooLarge", "x", bundle: TestBundles.lproj("de")), "Die Datei ist für diesen Server zu groß.")
        XCTAssertEqual(L10n.string("error.tooLarge", "x", bundle: TestBundles.lproj("en")), "The file is too large for this server.")
    }
}
