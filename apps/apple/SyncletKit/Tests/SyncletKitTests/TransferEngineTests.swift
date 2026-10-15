import FileProvider
import Foundation
import XCTest
@testable import SyncletKit

final class TransferEngineTests: XCTestCase {
    static let mib = 1 << 20
    var stateDir: URL!
    var files: [URL] = []

    override func setUp() {
        stateDir = Fixtures.tempDirectory()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: stateDir)
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    private func engine(sleep: SleepRecorder = SleepRecorder(), now: @escaping @Sendable () -> Date = { Date() }) -> TransferEngine {
        let api = FakeServerProtocol.client()
        return TransferEngine(api: api, tus: TusUploader(api: api), stateDir: stateDir, now: now, sleep: sleep.sleep)
    }

    private func patternFile(_ size: Int, seed: UInt8 = 0) -> URL {
        let url = TransferFixtures.patternFile(size: size, seed: seed)
        files.append(url)
        return url
    }

    private func sparseFile(_ size: Int) -> URL {
        let url = TransferFixtures.sparseFile(size: size)
        files.append(url)
        return url
    }

    private var storedStates: [URL] {
        (try? FileManager.default.contentsOfDirectory(at: stateDir, includingPropertiesForKeys: nil)) ?? []
    }

    // MARK: - tus

    func test100MiBUploadsWithCreateAndSevenPatches() async throws {
        let server = FakeTusServer()
        let size = 100 * Self.mib
        let file = patternFile(size)
        let progress = Progress(totalUnitCount: 100)
        let observed = OffsetLog()
        server.onPatch = { _, _ in
            observed.append(progress.completedUnitCount)
            return .proceed
        }
        let modified = Date(timeIntervalSince1970: 1_700_000_000)

        let item = try await engine().upload(file: file, newIn: "d_1", name: "Video.mov", modifiedAt: modified, progress: progress)

        XCTAssertEqual(item.name, "Video.mov")
        XCTAssertEqual(item.size, Int64(size))
        let tus = server.tusRequests
        XCTAssertEqual(tus.map(\.method), ["POST"] + Array(repeating: "PATCH", count: 7))
        XCTAssertEqual(tus[0].header("Upload-Length"), String(size))
        XCTAssertEqual(server.publishedMetadata, ["name": "Video.mov", "parentId": "d_1", "onConflict": "rename",
                                                  "modifiedAt": "2023-11-14T22:13:20.000Z"])
        XCTAssertEqual(tus.dropFirst().map { $0.body.count }, Array(repeating: 16 * Self.mib, count: 6) + [4 * Self.mib])
        XCTAssertEqual(server.publishedData, try Data(contentsOf: file))
        server.assertRangesContiguous(length: Int64(size))
        XCTAssertEqual(progress.totalUnitCount, Int64(size))
        XCTAssertEqual(progress.completedUnitCount, Int64(size))
        XCTAssertEqual(observed.values, (0..<7).map { Int64($0 * 16 * Self.mib) }, "progress updated per chunk")
        XCTAssertTrue(storedStates.isEmpty, "state removed after completion")
    }

    func testFailureAfterChunk3ResumesAt48MiBWithNewEngine() async throws {
        let server = FakeTusServer()
        let size = 100 * Self.mib
        let file = patternFile(size)
        server.onPatch = { number, _ in
            guard number == 4 else { return .proceed }
            server.setNetworkDown(true) // Wi-Fi off
            return .dropBefore
        }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k1")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        XCTAssertEqual(storedStates.count, 1, "upload state kept")

        server.setNetworkDown(false) // Wi-Fi on
        server.onPatch = nil
        let item = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k1")

        XCTAssertEqual(item.name, "Big.bin")
        let tus = server.tusRequests
        XCTAssertEqual(tus.filter { $0.method == "POST" }.count, 1, "no second upload")
        let head = try XCTUnwrap(tus.firstIndex { $0.method == "HEAD" })
        XCTAssertEqual(tus[head + 1].header("Upload-Offset"), String(48 * Self.mib))
        server.assertRangesContiguous(length: Int64(size))
        XCTAssertEqual(server.publishedData, try Data(contentsOf: file))
        XCTAssertTrue(storedStates.isEmpty)
    }

    func testResumesWithSubMillisecondModificationDate() async throws {
        let server = FakeTusServer()
        let size = 40 * Self.mib
        let file = patternFile(size)
        // A file system date with sub-millisecond precision (as handed in by the system).
        let modified = Date(timeIntervalSince1970: 1_700_000_000.123_456_7)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: modified, resumeKey: "k")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: modified, resumeKey: "k")
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "HEAD", "PATCH", "PATCH"])
        XCTAssertEqual(server.publishedMetadata?["modifiedAt"], "2023-11-14T22:13:20.123Z")
        server.assertRangesContiguous(length: Int64(size))
    }

    func testHead404RestartsFromZero() async throws {
        let server = FakeTusServer()
        let size = 40 * Self.mib
        let file = patternFile(size)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.expireAll()
        server.onPatch = nil

        _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")

        let methods = server.tusRequests.map(\.method)
        XCTAssertEqual(methods, ["POST", "PATCH", "PATCH", "HEAD", "POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(server.tusRequests[5].header("Upload-Offset"), "0")
        XCTAssertEqual(server.publishedData, try Data(contentsOf: file))
        XCTAssertEqual(server.publishedItems.count, 1)
    }

    func testLostFinalResponseFindsPublishedFileInsteadOfDuplicating() async throws {
        let server = FakeTusServer()
        let size = 33 * Self.mib
        let file = patternFile(size)
        // The final PATCH publishes on the server, but its response never arrives.
        server.onPatch = { number, _ in number == 3 ? .dropAfter : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil

        let item = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")

        XCTAssertEqual(item.id, "f_u1")
        XCTAssertEqual(server.publishedItems.count, 1, "no duplicate")
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "PATCH", "HEAD"])
        XCTAssertTrue(storedStates.isEmpty)
    }

    func testLocalFileChangedBetweenAttemptsTerminatesAndRestarts() async throws {
        let server = FakeTusServer()
        let size = 40 * Self.mib
        let file = patternFile(size)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        // New content of the same size, new mtime.
        let changed = patternFile(size, seed: 7)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.copyItem(at: changed, to: file)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: file.path)

        _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil, resumeKey: "k")

        let tus = server.tusRequests
        XCTAssertEqual(tus.map(\.method), ["POST", "PATCH", "PATCH", "DELETE", "POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(tus[3].path, "/api/sync/v1/uploads/u1")
        XCTAssertEqual(server.publishedData, try Data(contentsOf: changed))
    }

    func test423RetriesAfterTwoSeconds() async throws {
        let server = FakeTusServer()
        let file = patternFile(40 * Self.mib)
        server.onPatch = { number, _ in (number == 2 || number == 3) ? .status(423) : .proceed }
        let sleeps = SleepRecorder()

        _ = try await engine(sleep: sleeps).upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil)

        XCTAssertEqual(sleeps.delays, [.seconds(2), .seconds(2)])
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "HEAD", "PATCH", "HEAD", "PATCH", "PATCH"])
        XCTAssertEqual(server.publishedData, try Data(contentsOf: file))
    }

    func test423GivesUpAfterFiveRetries() async throws {
        let server = FakeTusServer()
        let file = patternFile(40 * Self.mib)
        server.onPatch = { number, _ in number >= 2 ? .status(423) : .proceed }
        let sleeps = SleepRecorder()
        await assertThrows(.http(status: 423, code: nil, message: nil)) {
            _ = try await self.engine(sleep: sleeps).upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil)
        }
        XCTAssertEqual(sleeps.delays.count, 5)
        XCTAssertEqual(storedStates.count, 1, "kept for a later retry")
        let mapped = ErrorMapping.fileProviderError(SyncAPIError.http(status: 423, code: nil, message: nil)) as NSError
        XCTAssertEqual(mapped.code, NSFileProviderError.Code.serverUnreachable.rawValue)
    }

    func testExpiredStateIsDropped() async throws {
        let store = UploadStateStore(directory: stateDir, now: { Date(timeIntervalSince1970: 100_000) })
        let target = TusUploadMetadata(name: "a", parentId: "root")
        let url = URL(string: "https://synclet.example.test/api/sync/v1/uploads/u1")!
        try store.save(UploadState(uploadURL: url, length: 1, fileSize: 1, fileMtime: Date(), target: target,
                                   createdAt: Date(timeIntervalSince1970: 100_000 - 24 * 3600 - 1)), key: "old")
        try store.save(UploadState(uploadURL: url, length: 1, fileSize: 1, fileMtime: Date(), target: target,
                                   baseEtag: "v3", createdAt: Date(timeIntervalSince1970: 100_000 - 3600)), key: "fresh")
        XCTAssertNil(store.load(key: "old"))
        XCTAssertEqual(store.load(key: "fresh")?.baseEtag, "v3")
        store.purgeExpired()
        XCTAssertEqual(storedStates.map(\.lastPathComponent), ["fresh.json"])
        XCTAssertEqual(UploadStateStore.key(itemIdentifier: "f_1", contentVersion: "v3").count, 64)
    }

    // MARK: - Thresholds and replace

    func testExactly32MiBIsSingleRequestAndOneMoreByteIsTus() async throws {
        let server = FakeTusServer()
        server.fallback = { request in
            .response(.json(201, Fixtures.itemJSON(id: "f_single", name: request.query["name"] ?? "")))
        }
        let progress = Progress(totalUnitCount: 100)
        _ = try await engine().upload(file: sparseFile(32 * Self.mib), newIn: "root", name: "a.bin", modifiedAt: nil, progress: progress)
        XCTAssertTrue(server.tusRequests.isEmpty)
        let single = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(single.path, "/api/sync/v1/items/upload")
        XCTAssertEqual(single.body.count, 32 * Self.mib)
        XCTAssertEqual(progress.totalUnitCount, Int64(32 * Self.mib))

        _ = try await engine().upload(file: sparseFile(32 * Self.mib + 1), newIn: "root", name: "b.bin", modifiedAt: nil)
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(server.tusRequests.last?.body.count, 1)
    }

    func testEmptyFileIsSingleRequest() async throws {
        let server = FakeTusServer()
        server.fallback = { _ in .response(.json(201, Fixtures.itemJSON(id: "f_empty", name: "leer.txt"))) }
        let item = try await engine().upload(file: Fixtures.tempFile(""), newIn: "root", name: "leer.txt", modifiedAt: nil)
        XCTAssertEqual(item.id, "f_empty")
        XCTAssertTrue(server.tusRequests.isEmpty)
        XCTAssertEqual(server.requests.map(\.path), ["/api/sync/v1/items/upload"])
    }

    func testReplaceWithStaleEtagSurfacesConflict() async throws {
        let server = FakeTusServer()
        let current = Fixtures.itemJSON(id: "f_1", version: 5, contentEtag: "v5", etag: "v5")
        server.fallback = { _ in .response(.error(412, "conflict", item: current)) }
        do {
            _ = try await engine().replace(file: sparseFile(40 * Self.mib), itemId: "f_1", baseEtag: "v3",
                                           modifiedAt: nil, progress: Progress())
            XCTFail("conflict expected")
        } catch SyncAPIError.conflict(let item) {
            XCTAssertEqual(item?.contentEtag, "v5")
        }
        let put = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(put.method, "PUT")
        XCTAssertEqual(put.header("If-Match"), "\"v3\"")
        XCTAssertTrue(server.tusRequests.isEmpty, "tus cannot replace (SYNC_API.md §7)")
    }

    func testIdenticalExistingFileIsReusedForLargeUpload() async throws {
        let server = FakeTusServer()
        let file = patternFile(33 * Self.mib)
        // A first upload publishes the file …
        _ = try await engine().upload(file: file, newIn: "root", name: "Big.bin", modifiedAt: nil)
        let before = server.tusRequests.count
        // … a re-create of the same content (mayAlreadyExist) does not upload again.
        let item = try await engine().upload(file: file, newIn: "root", name: "big.BIN", modifiedAt: nil)
        XCTAssertEqual(item.id, "f_u1")
        XCTAssertEqual(server.tusRequests.count, before)
    }

    func testNameHelpers() {
        let (base, ext) = TransferEngine.splitName("Video.MOV")
        XCTAssertEqual(base, "video")
        XCTAssertEqual(ext, ".mov")
        XCTAssertTrue(TransferEngine.isSuffixed("video (2).mov", base: base, ext: ext))
        XCTAssertFalse(TransferEngine.isSuffixed("video (1).mov", base: base, ext: ext))
        XCTAssertFalse(TransferEngine.isSuffixed("video (x).mov", base: base, ext: ext))
        XCTAssertEqual(TransferEngine.splitName(".env").ext, "")
    }
}

final class OffsetLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Int64] = []
    var values: [Int64] { lock.withLock { storage } }
    func append(_ value: Int64) { lock.withLock { storage.append(value) } }
}
