import FileProvider
import Foundation
import XCTest
@testable import SyncletKit

final class RangeDownloaderTests: XCTestCase {
    var dir: URL!

    override func setUp() { dir = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func setHandler(_ handler: @escaping (RecordedRequest) -> FakeReply) -> Recorder {
        let recorder = Recorder()
        FakeServerProtocol.lock.withLock {
            FakeServerProtocol.handler = { request in
                recorder.append(request)
                return handler(request)
            }
        }
        return recorder
    }

    private func downloader(attempts: Int = 3, sleeps: SleepRecorder = SleepRecorder()) -> RangeDownloader {
        RangeDownloader(api: FakeServerProtocol.client(), maxAttempts: attempts, sleep: sleeps.sleep)
    }

    /// Server for `content` with tag `etag`, honouring Range + If-Range like §6.1.
    private static func serve(_ request: RecordedRequest, content: Data, etag: String) -> MockResponse {
        let headers = ["ETag": "\"\(etag)\"", "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes"]
        if let range = request.header("Range"), range.hasPrefix("bytes="), range.hasSuffix("-"),
           let start = Int(range.dropFirst(6).dropLast()), request.header("If-Range") == "\"\(etag)\"" {
            return .data(206, content.subdata(in: start..<content.count),
                         headers: headers.merging(["Content-Range": "bytes \(start)-\(content.count - 1)/\(content.count)"]) { a, _ in a })
        }
        return .data(200, content, headers: headers)
    }

    func testResumesWithRangeAndIfRangeAfterNetworkError() async throws {
        let content = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 * 7) })
        let counter = Counter()
        let recorder = setHandler { request in
            if counter.next() == 1 {
                return .partial(status: 200, headers: ["ETag": "\"v3\"", "Content-Length": String(content.count)],
                                body: content.prefix(120_000), then: .networkConnectionLost)
            }
            return .response(Self.serve(request, content: content, etag: "v3"))
        }
        let progress = Progress(totalUnitCount: 100)
        let sleeps = SleepRecorder()
        let destination = dir.appending(path: "out")

        let result = try await downloader(sleeps: sleeps).download(itemID: "f_1", to: destination, progress: progress)

        XCTAssertEqual(try Data(contentsOf: destination), content)
        XCTAssertEqual(result.statusCode, 206)
        XCTAssertEqual(result.etag, "v3")
        let second = recorder.requests[1]
        XCTAssertEqual(second.header("Range"), "bytes=120000-")
        XCTAssertEqual(second.header("If-Range"), "\"v3\"")
        XCTAssertNil(recorder.requests[0].header("Range"))
        XCTAssertEqual(progress.totalUnitCount, Int64(content.count))
        XCTAssertEqual(progress.completedUnitCount, Int64(content.count))
        XCTAssertEqual(sleeps.delays.count, 1)
    }

    func test200InsteadOf206RestartsTheFile() async throws {
        let old = Data(repeating: 0xAA, count: 200_000)
        let new = Data(repeating: 0x55, count: 150_000)
        let counter = Counter()
        let recorder = setHandler { request in
            if counter.next() == 1 {
                return .partial(status: 200, headers: ["ETag": "\"v3\"", "Content-Length": String(old.count)],
                                body: old.prefix(100_000), then: .networkConnectionLost)
            }
            // Changed meanwhile: If-Range "v3" no longer matches → whole new file.
            return .response(Self.serve(request, content: new, etag: "v4"))
        }
        let destination = dir.appending(path: "out")

        let result = try await downloader().download(itemID: "f_1", to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), new, "no spliced bytes")
        XCTAssertEqual(result.statusCode, 200)
        XCTAssertEqual(result.etag, "v4")
        XCTAssertEqual(recorder.requests[1].header("If-Range"), "\"v3\"")
    }

    func testGivesUpAfterThreeAttempts() async throws {
        let recorder = setHandler { _ in
            .partial(status: 200, headers: ["ETag": "\"v3\"", "Content-Length": "1000"], body: Data(count: 10),
                     then: .networkConnectionLost)
        }
        do {
            _ = try await downloader().download(itemID: "f_1", to: dir.appending(path: "out"))
            XCTFail("error expected")
        } catch SyncAPIError.transport(let code, _) {
            XCTAssertEqual(code, .networkConnectionLost)
        }
        XCTAssertEqual(recorder.requests.count, 3)
    }

    func testHTTPErrorIsNotRetried() async throws {
        let recorder = setHandler { _ in .response(.error(404, "not_found")) }
        await assertThrows(.notFound) {
            _ = try await self.downloader().download(itemID: "f_1", to: self.dir.appending(path: "out"))
        }
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertEqual(recorder.requests[0].path, "/api/sync/v1/items/f_1/content")
        XCTAssertEqual(recorder.requests[0].header("Authorization"), "Bearer syd_test")
    }

    func testEmptyFile() async throws {
        _ = setHandler { _ in .response(.data(200, Data(), headers: ["ETag": "\"v1\"", "Content-Length": "0"])) }
        let destination = dir.appending(path: "out")
        let result = try await downloader().download(itemID: "f_1", to: destination)
        XCTAssertEqual(try Data(contentsOf: destination), Data())
        XCTAssertEqual(result.etag, "v1")
    }

    func testUnexpectedContentRangeRestartsFromZero() async throws {
        let content = Data((0..<50_000).map { UInt8(truncatingIfNeeded: $0) })
        let counter = Counter()
        _ = setHandler { request in
            switch counter.next() {
            case 1:
                return .partial(status: 200, headers: ["ETag": "\"v3\"", "Content-Length": String(content.count)],
                                body: content.prefix(10_000), then: .networkConnectionLost)
            case 2:
                // A broken proxy answers a different range.
                return .response(.data(206, content.subdata(in: 5_000..<content.count),
                                       headers: ["ETag": "\"v3\"", "Content-Range": "bytes 5000-49999/50000"]))
            default:
                return .response(Self.serve(request, content: content, etag: "v3"))
            }
        }
        let destination = dir.appending(path: "out")
        _ = try await downloader().download(itemID: "f_1", to: destination)
        XCTAssertEqual(try Data(contentsOf: destination), content)
    }

    // MARK: - Extension wiring

    func testExtensionCreateAboveThresholdUsesTus() async throws {
        let server = FakeTusServer()
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "x")
        let context = SyncletReplicatedExtension.Context(client: FakeServerProtocol.client(), deviceName: "Mac",
                                                         layout: Fixtures.layout, transferStateDirectory: dir,
                                                         uploadThreshold: 4)
        let ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: dir) { context }
        let template = TemplateItem(parent: NSFileProviderItemIdentifier("space:personal"), name: "Notiz.txt", type: .plainText)
        let progress = Progress(totalUnitCount: 100)
        let created = try await ext.create(template: template, contents: Fixtures.tempFile("Hallo Welt"), modifiedAt: nil,
                                           mayAlreadyExist: false, context: context, progress: progress)
        XCTAssertEqual(created.name, "Notiz.txt")
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH"])
        XCTAssertEqual(server.publishedData, Data("Hallo Welt".utf8))
        XCTAssertEqual(progress.totalUnitCount, 10)
        XCTAssertEqual(progress.completedUnitCount, 10)
    }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [RecordedRequest] = []
    var requests: [RecordedRequest] { lock.withLock { storage } }
    func append(_ request: RecordedRequest) { lock.withLock { storage.append(request) } }
}
