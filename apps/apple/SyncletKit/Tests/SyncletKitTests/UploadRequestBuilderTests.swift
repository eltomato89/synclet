import XCTest
@testable import SyncletKit

final class UploadRequestBuilderTests: XCTestCase {
    private let api = SyncAPIClient(baseURL: Fixtures.server, token: "unused")
    private let tusURL = URL(string: "https://synclet.example.test/api/sync/v1/uploads/abc")!
    private var createURL: URL { api.syncBaseURL.appending(path: "uploads") }

    private func entry(name: String = "Foto (1).heic", size: Int64 = 5) -> UploadEntry {
        UploadEntry(accountKey: "srv1:u1", parentId: "d_1", parentName: "Docs", name: name, size: size)
    }

    private func interpret(_ status: Int, _ headers: [String: String] = [:], _ body: String = "",
                           _ step: UploadStep, requestURL: URL? = nil) -> UploadStepResult {
        UploadRequestBuilder.interpret(status: status, headers: headers, body: Data(body.utf8), for: step,
                                       requestURL: requestURL ?? tusURL)
    }

    private func errorBody(_ status: Int, _ code: String) -> String {
        #"{"statusCode":\#(status),"message":"\#(code) message","code":"\#(code)"}"#
    }

    func testPlanThreshold() {
        XCTAssertEqual(UploadRequestBuilder.threshold, 32 * 1024 * 1024)
        XCTAssertEqual(UploadRequestBuilder.chunkSize, 16 * 1024 * 1024)
        XCTAssertEqual(UploadRequestBuilder.plan(size: 0), .single)
        XCTAssertEqual(UploadRequestBuilder.plan(size: 32 * 1024 * 1024), .single)
        XCTAssertEqual(UploadRequestBuilder.plan(size: 32 * 1024 * 1024 + 1), .tus)
    }

    func testSingleUploadRequest() throws {
        let request = try UploadRequestBuilder.singleUpload(api: api, entry: entry(), token: "syd_t")
        XCTAssertEqual(request.httpMethod, "POST")
        let url = try XCTUnwrap(request.url)
        XCTAssertEqual(url.path(percentEncoded: false), "/api/sync/v1/items/upload")
        XCTAssertEqual(url.query(percentEncoded: true), "parentId=d_1&name=Foto%20%281%29.heic&onConflict=rename")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "name" }?.value, "Foto (1).heic")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer syd_t")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testTusCreateHeaders() throws {
        let request = try UploadRequestBuilder.tusCreate(api: api, entry: entry(size: 40 << 20), token: "syd_t")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, createURL)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Tus-Resumable"), "1.0.0")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Upload-Length"), String(40 << 20))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer syd_t")
        let metadata = try XCTUnwrap(request.value(forHTTPHeaderField: "Upload-Metadata"))
        XCTAssertEqual(metadata, TusUploadMetadata(name: "Foto (1).heic", parentId: "d_1", onConflict: .rename).headerValue)
        XCTAssertEqual(FakeTusServer.decodeMetadata(metadata),
                       ["name": "Foto (1).heic", "parentId": "d_1", "onConflict": "rename"])
    }

    func testTusHeadAndPatchHeaders() {
        let head = UploadRequestBuilder.tusHead(url: tusURL, token: "syd_t")
        XCTAssertEqual(head.httpMethod, "HEAD")
        XCTAssertEqual(head.url, tusURL)
        XCTAssertEqual(head.value(forHTTPHeaderField: "Tus-Resumable"), "1.0.0")
        XCTAssertEqual(head.value(forHTTPHeaderField: "Authorization"), "Bearer syd_t")
        XCTAssertEqual(head.cachePolicy, .reloadIgnoringLocalCacheData)

        let patch = UploadRequestBuilder.tusPatch(url: tusURL, offset: 16 << 20, token: "syd_t")
        XCTAssertEqual(patch.httpMethod, "PATCH")
        XCTAssertEqual(patch.value(forHTTPHeaderField: "Upload-Offset"), String(16 << 20))
        XCTAssertEqual(patch.value(forHTTPHeaderField: "Content-Type"), "application/offset+octet-stream")
        XCTAssertEqual(patch.value(forHTTPHeaderField: "Tus-Resumable"), "1.0.0")
        XCTAssertEqual(patch.value(forHTTPHeaderField: "Authorization"), "Bearer syd_t")
    }

    func testInterpretSingle201Finished() {
        let body = Fixtures.itemJSON(id: "f_7", parentId: "d_1", name: "Foto (2).heic")
        XCTAssertEqual(interpret(201, [:], body, .single), .finished(itemId: "f_7", name: "Foto (2).heic"))
        XCTAssertEqual(interpret(201, [:], "nonsense", .single), .fail(.other, message: "unexpected response"))
    }

    func testInterpretErrors() {
        for step in [UploadStep.single, .tusCreate, .tusHead, .tusPatch(offset: 0, length: 5)] {
            XCTAssertEqual(interpret(507, [:], errorBody(507, "insufficient_storage"), step),
                           .fail(.insufficientStorage, message: "insufficient_storage message"), "\(step)")
            XCTAssertEqual(interpret(401, [:], errorBody(401, "unauthorized"), step),
                           .fail(.signedOut, message: "unauthorized message"), "\(step)")
            XCTAssertEqual(interpret(401, [:], errorBody(401, "device_revoked"), step),
                           .fail(.signedOut, message: "device_revoked message"), "\(step)")
            XCTAssertEqual(interpret(413, [:], "", step), .fail(.tooLarge, message: nil), "\(step)")
            XCTAssertEqual(interpret(400, [:], errorBody(400, "invalid_name"), step),
                           .fail(.invalidName, message: "invalid_name message"), "\(step)")
            XCTAssertEqual(interpret(400, [:], errorBody(400, "invalid_request"), step),
                           .fail(.other, message: "invalid_request message"), "\(step)")
            XCTAssertEqual(interpret(403, [:], errorBody(403, "forbidden"), step),
                           .fail(.other, message: "forbidden message"), "\(step)")
            XCTAssertEqual(interpret(503, [:], "", step), .retry, "\(step)")
            XCTAssertEqual(interpret(500, [:], "", step), .retry, "\(step)")
            XCTAssertEqual(interpret(423, [:], "", step), .retry, "\(step)")
            XCTAssertEqual(interpret(429, [:], errorBody(429, "rate_limited"), step), .retry, "\(step)")
        }
        XCTAssertEqual(interpret(404, [:], errorBody(404, "not_found"), .single), .fail(.targetGone, message: "not_found message"))
        XCTAssertEqual(interpret(404, [:], errorBody(404, "not_found"), .tusCreate), .fail(.targetGone, message: "not_found message"))
        XCTAssertEqual(interpret(404, [:], "Not Found", .tusHead), .restartTus)
        XCTAssertEqual(interpret(410, [:], "Gone", .tusHead), .restartTus)
        XCTAssertEqual(interpret(404, [:], "Not Found", .tusPatch(offset: 0, length: 5)), .restartTus)
        XCTAssertEqual(interpret(410, [:], "Gone", .tusPatch(offset: 0, length: 5)), .restartTus)
        XCTAssertEqual(interpret(409, [:], "offset mismatch", .tusPatch(offset: 0, length: 5)), .retry)
    }

    func testInterpretTusCreateLocationRelative() {
        let request = createURL
        XCTAssertEqual(interpret(201, ["Location": "/api/sync/v1/uploads/abc"], "", .tusCreate, requestURL: request),
                       .tusCreated(tusURL))
        // Header names are case-insensitive.
        XCTAssertEqual(interpret(201, ["location": "/api/sync/v1/uploads/abc"], "", .tusCreate, requestURL: request),
                       .tusCreated(tusURL))
        XCTAssertEqual(interpret(201, ["Location": "https://synclet.example.test:443/api/sync/v1/uploads/abc"], "",
                                 .tusCreate, requestURL: request),
                       .tusCreated(URL(string: "https://synclet.example.test:443/api/sync/v1/uploads/abc")!))
        XCTAssertEqual(interpret(201, [:], "", .tusCreate, requestURL: request), .fail(.other, message: "tus: Location missing"))
    }

    func testInterpretTusCreateCrossOriginLocationIsRetry() {
        // Never send the token elsewhere.
        XCTAssertEqual(interpret(201, ["Location": "https://evil.example.test/api/sync/v1/uploads/abc"], "",
                                 .tusCreate, requestURL: createURL),
                       .fail(.other, message: "tus: Location on another origin"))
        XCTAssertEqual(interpret(201, ["Location": "http://synclet.example.test/api/sync/v1/uploads/abc"], "",
                                 .tusCreate, requestURL: createURL),
                       .fail(.other, message: "tus: Location on another origin"))
    }

    func testInterpretHeadOffset() {
        XCTAssertEqual(interpret(200, ["Upload-Offset": "16777216", "Upload-Length": "41943040"], "", .tusHead),
                       .tusOffset(16 << 20))
        XCTAssertEqual(interpret(204, ["upload-offset": "0"], "", .tusHead), .tusOffset(0))
        XCTAssertEqual(interpret(200, [:], "", .tusHead), .retry)
    }

    func testInterpretPatchOffsetAndFinal() {
        let step = UploadStep.tusPatch(offset: 0, length: 16 << 20)
        XCTAssertEqual(interpret(204, ["Upload-Offset": String(16 << 20)], "", step), .tusOffset(16 << 20))
        XCTAssertEqual(interpret(204, [:], "", step), .retry)
        // §7.4: the completing PATCH answers 200 with the SyncItem body and X-Synclet-Item.
        let body = Fixtures.itemJSON(id: "f_9", parentId: "d_1", name: "Film (2).mov")
        XCTAssertEqual(interpret(200, ["X-Synclet-Item": "f_9"], body, step), .finished(itemId: "f_9", name: "Film (2).mov"))
        // Body lost (proxy): the header still identifies the item; the name stays unknown ("").
        XCTAssertEqual(interpret(200, ["X-Synclet-Item": "f_9"], "", step), .finished(itemId: "f_9", name: ""))
        XCTAssertEqual(interpret(200, [:], "", step), .fail(.other, message: "tus: completed upload without item"))
    }

    func testStepCodableRoundTrip() throws {
        for step in [UploadStep.single, .tusCreate, .tusHead, .tusPatch(offset: 16 << 20, length: 8 << 20)] {
            let data = try JSONEncoder().encode(step)
            XCTAssertEqual(try JSONDecoder().decode(UploadStep.self, from: data), step)
        }
    }
}
