import Foundation
import XCTest
@testable import SyncletKit

final class TusUploaderTests: XCTestCase {
    func testMetadataUsesContractKeysAndTusEncoding() {
        let metadata = TusUploadMetadata(name: "Bericht & Co.pdf", parentId: "d_1", onConflict: .rename,
                                         modifiedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let decoded = FakeTusServer.decodeMetadata(metadata.headerValue)
        XCTAssertEqual(decoded, ["name": "Bericht & Co.pdf", "parentId": "d_1", "onConflict": "rename",
                                 "modifiedAt": "2023-11-14T22:13:20.000Z"])
        XCTAssertFalse(metadata.headerValue.contains("Bericht"), "values are base64")
    }

    func testCreateResolvesPathOnlyLocationAndSendsTusHeaders() async throws {
        let server = FakeTusServer()
        let tus = TusUploader(api: FakeServerProtocol.client())
        let result = try await tus.create(length: 10, metadata: TusUploadMetadata(name: "a.bin", parentId: "root"))
        XCTAssertEqual(result, .created(URL(string: "https://synclet.example.test/api/sync/v1/uploads/u1")!))
        let post = try XCTUnwrap(server.tusRequests.first)
        XCTAssertEqual(post.method, "POST")
        XCTAssertEqual(post.header("Tus-Resumable"), "1.0.0")
        XCTAssertEqual(post.header("Upload-Length"), "10")
        XCTAssertEqual(post.header("Authorization"), "Bearer syd_test")
    }

    func testPatchHeadAndTerminate() async throws {
        let server = FakeTusServer()
        let tus = TusUploader(api: FakeServerProtocol.client())
        guard case .created(let url) = try await tus.create(length: 6, metadata: TusUploadMetadata(name: "a.txt", parentId: "root")) else {
            return XCTFail("created expected")
        }
        let first = try await tus.patch(url, offset: 0, chunk: Data("abc".utf8))
        XCTAssertEqual(first, .offset(3))
        let patch = try XCTUnwrap(server.tusRequests.last)
        XCTAssertEqual(patch.header("Content-Type"), "application/offset+octet-stream")
        XCTAssertEqual(patch.header("Upload-Offset"), "0")
        let head = try await tus.head(url)
        XCTAssertEqual(head.offset, 3)
        XCTAssertEqual(head.length, 6)
        // Wrong offset → 409 (plain text) as .http(409).
        await assertThrows(.http(status: 409, code: nil, message: nil)) {
            _ = try await tus.patch(url, offset: 1, chunk: Data("x".utf8))
        }
        try await tus.terminate(url)
        await assertThrows(.notFound) { _ = try await tus.head(url) }
        try await tus.terminate(url) // unknown upload counts as terminated
    }

    func testFinalPatchReturnsPublishedItem() async throws {
        let server = FakeTusServer()
        let tus = TusUploader(api: FakeServerProtocol.client())
        guard case .created(let url) = try await tus.create(length: 3, metadata: TusUploadMetadata(name: "a.txt", parentId: "d_9")) else {
            return XCTFail("created expected")
        }
        guard case .completed(let item) = try await tus.patch(url, offset: 0, chunk: Data("abc".utf8)) else {
            return XCTFail("completed expected")
        }
        XCTAssertEqual(item.name, "a.txt")
        XCTAssertEqual(item.parentId, "d_9")
        XCTAssertEqual(server.publishedData, Data("abc".utf8))
    }

    func testCompletedWithoutBodyFetchesItemFromHeader() async throws {
        FakeServerProtocol.lock.withLock {
            FakeServerProtocol.handler = { request in
                if request.method == "PATCH" {
                    return .response(.empty(200, headers: ["X-Synclet-Item": "f_7"]))
                }
                return .response(.json(200, Fixtures.itemJSON(id: "f_7")))
            }
        }
        let tus = TusUploader(api: FakeServerProtocol.client())
        let result = try await tus.patch(URL(string: "https://synclet.example.test/api/sync/v1/uploads/u1")!,
                                         offset: 0, chunk: Data("x".utf8))
        guard case .completed(let item) = result else { return XCTFail("completed expected") }
        XCTAssertEqual(item.id, "f_7")
    }

    func testEmptyUploadCompletesWithPost() async throws {
        _ = FakeTusServer()
        let tus = TusUploader(api: FakeServerProtocol.client())
        guard case .completed(let item) = try await tus.create(length: 0, metadata: TusUploadMetadata(name: "leer.txt", parentId: "root")) else {
            return XCTFail("completed expected")
        }
        XCTAssertEqual(item.name, "leer.txt")
    }

    func testPublishErrorUsesSyncErrorFormat() async throws {
        FakeServerProtocol.lock.withLock {
            FakeServerProtocol.handler = { _ in .response(.error(507, "insufficient_storage")) }
        }
        let tus = TusUploader(api: FakeServerProtocol.client())
        await assertThrows(.insufficientStorage(message: "insufficient_storage")) {
            _ = try await tus.patch(URL(string: "https://synclet.example.test/api/sync/v1/uploads/u1")!,
                                    offset: 0, chunk: Data("x".utf8))
        }
    }
}
