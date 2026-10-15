import FileProvider
import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

/// Replacing content above 32 MiB through tus (`itemId` + `ifMatch`, SYNC_API.md §7), and the
/// re-review items N1 (no rewrite without a trusted etag) and N2 (conflict copies resume
/// across the minute boundary).
final class TransferReplaceTests: XCTestCase {
    static let mib = 1 << 20
    var stateDir: URL!
    var files: [URL] = []

    override func setUp() { stateDir = Fixtures.tempDirectory() }

    override func tearDown() {
        try? FileManager.default.removeItem(at: stateDir)
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    private func engine(threshold: Int = TransferEngine.defaultThreshold) -> TransferEngine {
        let api = FakeServerProtocol.client()
        return TransferEngine(api: api, tus: TusUploader(api: api), stateDir: stateDir, threshold: threshold,
                              sleep: SleepRecorder().sleep)
    }

    private func patternFile(_ size: Int, seed: UInt8 = 0) -> URL {
        let url = TransferFixtures.patternFile(size: size, seed: seed)
        files.append(url)
        return url
    }

    private var storedStates: [URL] {
        (try? FileManager.default.contentsOfDirectory(at: stateDir, includingPropertiesForKeys: nil)) ?? []
    }

    // MARK: - Replace via tus

    func testReplaceAbove32MiBUsesTusWithItemIdAndIfMatchOnly() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(33 * Self.mib)
        let progress = Progress(totalUnitCount: 100)

        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3",
                                              modifiedAt: Date(timeIntervalSince1970: 1_700_000_000), progress: progress)

        XCTAssertEqual(item.id, "f_1", "same item")
        XCTAssertEqual(item.version, 4)
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(FakeTusServer.decodeMetadata(server.tusRequests[0].header("Upload-Metadata") ?? ""),
                       ["itemId": "f_1", "ifMatch": "v3", "modifiedAt": "2023-11-14T22:13:20.000Z"],
                       "no name, parentId or onConflict")
        XCTAssertFalse(server.allRequests.contains { $0.method == "PUT" })
        XCTAssertEqual(server.file("f_1")?.data, try Data(contentsOf: file))
        XCTAssertEqual(progress.completedUnitCount, Int64(33 * Self.mib))
        XCTAssertTrue(storedStates.isEmpty)
    }

    func testReplaceExactly32MiBUsesPut() async throws {
        let server = FakeTusServer()
        server.fallback = { request in
            .response(.json(200, Fixtures.itemJSON(id: "f_1", version: 4, contentEtag: "v4", etag: "v4")))
        }
        _ = try await engine().replace(file: TransferFixtures.sparseFile(size: 32 * Self.mib), itemId: "f_1",
                                       baseEtag: "v3", modifiedAt: nil)
        XCTAssertTrue(server.tusRequests.isEmpty)
        let put = try XCTUnwrap(server.allRequests.last)
        XCTAssertEqual(put.method, "PUT")
        XCTAssertEqual(put.header("If-Match"), "\"v3\"")
    }

    func testReplaceWithWildcardEtagUsesPutEvenWhenLarge() async throws {
        // tus supports only `v<n>` (§7); `*` stays on PUT.
        let server = FakeTusServer()
        server.fallback = { _ in .response(.json(200, Fixtures.itemJSON(id: "f_1", version: 4, contentEtag: "v4", etag: "v4"))) }
        _ = try await engine().replace(file: TransferFixtures.sparseFile(size: 33 * Self.mib), itemId: "f_1",
                                       baseEtag: "*", modifiedAt: nil)
        XCTAssertTrue(server.tusRequests.isEmpty)
        XCTAssertEqual(server.allRequests.last?.header("If-Match"), "*")
    }

    func testReplaceResumesWithNewEngine() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let size = 40 * Self.mib
        let file = patternFile(size)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        XCTAssertEqual(storedStates.count, 1)
        server.onPatch = nil

        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)

        XCTAssertEqual(item.id, "f_1")
        XCTAssertEqual(item.version, 4)
        let tus = server.tusRequests
        XCTAssertEqual(tus.map(\.method), ["POST", "PATCH", "PATCH", "HEAD", "PATCH", "PATCH"])
        XCTAssertEqual(tus[4].header("Upload-Offset"), String(16 * Self.mib))
        server.assertRangesContiguous(length: Int64(size))
        XCTAssertEqual(server.file("f_1")?.data, try Data(contentsOf: file))
    }

    func testReplaceLostFinalResponseFindsTheNewVersion() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(33 * Self.mib)
        server.onPatch = { number, _ in number == 3 ? .dropAfter : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
        XCTAssertEqual(item.version, 4, "published once")
        XCTAssertEqual(server.file("f_1")?.version, 4)
        XCTAssertEqual(server.tusRequests.filter { $0.method == "POST" }.count, 1)
    }

    func testReplace412AtPostIsConflictWithoutUpload() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 5)
        do {
            _ = try await engine().replace(file: patternFile(33 * Self.mib), itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("conflict expected")
        } catch SyncAPIError.conflict(let current) {
            XCTAssertEqual(current?.contentEtag, "v5")
        }
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST"])
        XCTAssertTrue(storedStates.isEmpty)
    }

    func testReplace412AtPublishIsConflictWithoutSecondAttempt() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        // A web edit lands while the last chunk is on its way.
        server.onPatch = { number, _ in
            if number == 3 { server.bumpVersion("f_1") }
            return .proceed
        }
        do {
            _ = try await engine().replace(file: patternFile(33 * Self.mib), itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("conflict expected")
        } catch SyncAPIError.conflict(let current) {
            XCTAssertEqual(current?.contentEtag, "v4")
        }
        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "PATCH"], "no second replace attempt")
        XCTAssertEqual(server.file("f_1")?.data, Data("old".utf8), "file untouched")
        XCTAssertTrue(storedStates.isEmpty)
    }

    /// Extension: a 412 at publish takes the conflict path (conflict copy via tus create)
    /// and never replaces a second time.
    func testExtensionReplaceConflictAtPublishUploadsConflictCopy() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Bericht.pdf", version: 3)
        server.onPatch = { number, _ in
            if number == 1 { server.bumpVersion("f_1") }
            return .proceed
        }
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "x")
        let context = SyncletReplicatedExtension.Context(client: FakeServerProtocol.client(), deviceName: "Mac",
                                                         layout: Fixtures.layout, transferStateDirectory: stateDir,
                                                         uploadThreshold: 4)
        let ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: stateDir,
                                             now: { Date(timeIntervalSince1970: 1_791_031_815) }) { context }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "root", name: "Bericht.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        let contents = Fixtures.tempFile("lokal geändert")

        let result = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents], contents: contents,
                                          context: context, progress: nil)

        XCTAssertTrue(result.shouldFetchContent)
        XCTAssertEqual(result.item.syncItem?.contentEtag, "v4")
        let posts = server.tusRequests.filter { $0.method == "POST" }
            .map { FakeTusServer.decodeMetadata($0.header("Upload-Metadata") ?? "") }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0]["itemId"], "f_1")
        XCTAssertNil(posts[1]["itemId"], "the second upload is the conflict copy, not a replace")
        let expected = ConflictNaming.name(original: "Bericht.pdf", device: "Mac", date: Date(timeIntervalSince1970: 1_791_031_815))
        XCTAssertEqual(posts[1]["name"], expected)
        XCTAssertEqual(server.publishedData, Data("lokal geändert".utf8))
        XCTAssertEqual(server.file("f_1")?.data, Data("old".utf8))
    }

    // MARK: - "Upload gone" safety (review I1)

    /// Replace interrupted after the first chunk (network), state kept.
    private func interruptedReplace(_ server: FakeTusServer, file: URL) async throws {
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        XCTAssertEqual(storedStates.count, 1)
    }

    /// (a) A foreign edit of the **same size** with other bytes is not our upload: conflict,
    /// never returned as the replace result.
    func testGoneWithSameSizeForeignEditIsConflict() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let size = 40 * Self.mib
        let file = patternFile(size)
        try await interruptedReplace(server, file: file)
        let foreign = Data(repeating: 7, count: size)
        server.foreignEdit("f_1", data: foreign)
        server.expireAll()

        do {
            let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("conflict expected, got \(item.id) \(item.contentEtag ?? "")")
        } catch SyncAPIError.conflict(let current) {
            XCTAssertEqual(current?.contentEtag, "v4")
        }
        XCTAssertEqual(server.file("f_1")?.data, foreign, "the foreign edit stays")
        XCTAssertEqual(server.file("f_1")?.version, 4)
    }

    /// (b) Upload gone, item still at the base version ⇒ restart from 0 with a new POST
    /// (`itemId` + `ifMatch v3`) ⇒ v4 with our bytes.
    func testGoneStillAtBaseRestartsFromZero() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(40 * Self.mib)
        try await interruptedReplace(server, file: file)
        server.expireAll()

        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)

        XCTAssertEqual(item.version, 4)
        let tus = server.tusRequests
        XCTAssertEqual(tus.map(\.method), ["POST", "PATCH", "PATCH", "HEAD", "POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(FakeTusServer.decodeMetadata(tus[4].header("Upload-Metadata") ?? ""), ["itemId": "f_1", "ifMatch": "v3"])
        XCTAssertEqual(tus[5].header("Upload-Offset"), "0")
        XCTAssertEqual(server.file("f_1")?.data, try Data(contentsOf: file))
    }

    /// (c) Upload gone after a foreign edit: the client's own etag check reports the
    /// conflict – no second POST (the server's POST check is disabled to observe it).
    func testGoneAfterForeignEditIsConflictWithoutSecondPost() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(40 * Self.mib)
        try await interruptedReplace(server, file: file)
        server.skipPostIfMatchCheck = true
        server.foreignEdit("f_1", data: Data("web edit".utf8))
        server.expireAll()

        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("conflict expected")
        } catch SyncAPIError.conflict(let current) {
            XCTAssertEqual(current?.contentEtag, "v4")
        }
        XCTAssertEqual(server.tusRequests.filter { $0.method == "POST" }.count, 1, "no second replace")
        XCTAssertEqual(server.file("f_1")?.data, Data("web edit".utf8))
    }

    /// (d) The local file changed between attempts ⇒ the stored upload is terminated and a
    /// fresh replace starts; never HEAD/resume.
    func testLocalFileChangedBetweenReplaceAttemptsRestarts() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(40 * Self.mib)
        try await interruptedReplace(server, file: file)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: file.path)

        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)

        XCTAssertEqual(item.version, 4)
        let methods = server.tusRequests.map(\.method)
        XCTAssertEqual(methods, ["POST", "PATCH", "PATCH", "DELETE", "POST", "PATCH", "PATCH", "PATCH"])
        XCTAssertFalse(methods.contains("HEAD"))
        XCTAssertEqual(server.tusRequests[3].path, "/api/sync/v1/uploads/u1")
    }

    // MARK: - Upload lost twice (review I2)

    func testUploadLostTwiceIsTransientNeverNotFound() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        // The server loses the staged upload in both attempts of this call.
        server.onPatch = { number, _ in (number == 2 || number == 3) ? .dropUpload : .proceed }
        do {
            _ = try await engine().replace(file: patternFile(40 * Self.mib), itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("error expected")
        } catch let error as SyncAPIError {
            XCTAssertNotEqual(error, .notFound, "would fork the file through the re-create path")
            XCTAssertEqual(error, TransferEngine.uploadLostError)
            XCTAssertTrue(error.isTransient)
        }
        XCTAssertEqual(server.tusRequests.filter { $0.method == "POST" }.count, 2, "one restart, then give up")
        XCTAssertEqual(server.file("f_1")?.version, 3, "item untouched")
    }

    func testExtensionReplaceLostTwiceIsRetriedNotRecreated() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Bericht.pdf", version: 3)
        server.onPatch = { _, _ in .dropUpload }
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "x")
        let context = SyncletReplicatedExtension.Context(client: FakeServerProtocol.client(), deviceName: "Mac",
                                                         layout: Fixtures.layout, transferStateDirectory: stateDir,
                                                         uploadThreshold: 4)
        let ext = SyncletReplicatedExtension(domain: domain, temporaryDirectory: stateDir) { context }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "root", name: "Bericht.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        do {
            _ = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents],
                                     contents: Fixtures.tempFile("lokal geändert"), context: context, progress: nil)
            XCTFail("error expected")
        } catch {
            let mapped = ErrorMapping.fileProviderError(error) as NSError
            XCTAssertEqual(mapped.code, NSFileProviderError.Code.serverUnreachable.rawValue)
        }
        XCTAssertFalse(server.allRequests.contains { $0.path == "/api/sync/v1/items/upload" }, "no re-create")
        XCTAssertTrue(server.tusRequests.filter { $0.method == "POST" }
            .allSatisfy { FakeTusServer.decodeMetadata($0.header("Upload-Metadata") ?? "")["itemId"] == "f_1" },
                      "only replaces, no new file")
        XCTAssertEqual(server.file("f_1")?.version, 3)
    }

    /// tus `404` at POST of a replace is confirmed with GET /items/:id: only that may report
    /// the item as deleted.
    func testReplacePost404IsConfirmedWithItemLookup() async throws {
        let server = FakeTusServer()
        server.fallback = { _ in .response(.error(404, "not_found")) }
        await assertThrows(.notFound) {
            _ = try await self.engine().replace(file: self.patternFile(33 * Self.mib), itemId: "f_gone", baseEtag: "v3",
                                                modifiedAt: nil)
        }
        XCTAssertEqual(server.allRequests.map(\.method), ["POST", "GET"])
        XCTAssertEqual(server.allRequests.last?.path, "/api/sync/v1/items/f_gone")
    }

    /// m2: our version may be published but not hashed yet (sha256 null, version = base + 1):
    /// unknown ⇒ transient, not a conflict copy.
    func testGoneWithUnhashedNextVersionIsTransient() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let file = patternFile(33 * Self.mib)
        server.onPatch = { number, _ in number == 3 ? .dropAfter : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        server.unhashed = ["f_1"]
        await assertThrows(TransferEngine.uploadLostError) {
            _ = try await self.engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
        }
        server.unhashed = []
        let item = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
        XCTAssertEqual(item.version, 4, "found once hashed")
    }

    func testVersionEtagFormat() {
        XCTAssertTrue(TransferEngine.isVersionEtag("v3"))
        XCTAssertTrue(TransferEngine.isVersionEtag("v120"))
        for bad in ["v", "v+1", "v-1", "*", "W/\"v3\"", "3", "v3a", "v٣"] {
            XCTAssertFalse(TransferEngine.isVersionEtag(bad), bad)
        }
    }

    // MARK: - N1: no rewrite without a trusted etag

    func testSplicedResumeWithoutCompletionBodyIsNotRewritten() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let size = 40 * Self.mib
        let file = patternFile(size)
        let mtime = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        // Same-size rewrite with the mtime kept (`cp -p`): the resume splices old bytes.
        let other = patternFile(size, seed: 9)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.copyItem(at: other, to: file)
        try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: file.path)
        // The completion has no JSON body: the item comes from GET /items/:id, whose etag may
        // already belong to someone else's edit – it must not be used for a rewrite.
        server.omitCompletionBody = true

        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("error expected")
        } catch let error as SyncAPIError {
            XCTAssertTrue(error.isTransient, "the File Provider retries: \(error)")
        }
        XCTAssertFalse(server.allRequests.contains { $0.method == "PUT" }, "no rewrite, never If-Match: *")
    }

    func testSplicedResumeWithCompletionBodyIsRewrittenWithOwnEtag() async throws {
        let server = FakeTusServer()
        server.addFile(id: "f_1", name: "Video.mov", version: 3)
        let size = 40 * Self.mib
        let file = patternFile(size)
        let mtime = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        let other = patternFile(size, seed: 9)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.copyItem(at: other, to: file)
        try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: file.path)
        server.fallback = { request in
            request.method == "PUT"
                ? .response(.json(200, FakeTusServer.itemJSON(id: "f_1", parentId: "root", name: "Video.mov",
                                                              data: request.body, version: 5)))
                : .response(.empty(500))
        }

        _ = try await engine().replace(file: file, itemId: "f_1", baseEtag: "v3", modifiedAt: nil)

        let put = try XCTUnwrap(server.allRequests.last)
        XCTAssertEqual(put.method, "PUT")
        XCTAssertEqual(put.header("If-Match"), "\"v4\"", "the etag of our own published version")
    }

    // MARK: - N2: conflict copies resume across the minute boundary

    func testConflictCopyResumesAcrossTheMinuteBoundary() async throws {
        let server = FakeTusServer()
        let size = 40 * Self.mib
        let file = patternFile(size)
        let first = "Video (Konflikt Mac 2026-10-15 10-00).mov"
        let second = "Video (Konflikt Mac 2026-10-15 10-01).mov"
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: first, modifiedAt: nil, resumeKey: "conflict-key",
                                          reuseIdentical: false, nameMayChange: true)
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil

        let item = try await engine().upload(file: file, newIn: "root", name: second, modifiedAt: nil, resumeKey: "conflict-key",
                                             reuseIdentical: false, nameMayChange: true)

        XCTAssertEqual(server.tusRequests.map(\.method), ["POST", "PATCH", "PATCH", "HEAD", "PATCH", "PATCH"], "resumed, not restarted")
        XCTAssertEqual(item.name, first, "published under the name of the first attempt")
        server.assertRangesContiguous(length: Int64(size))
    }

    func testOrdinaryUploadStillRestartsWhenTheNameChanges() async throws {
        let server = FakeTusServer()
        let file = patternFile(40 * Self.mib)
        server.onPatch = { number, _ in number == 2 ? .dropBefore : .proceed }
        do {
            _ = try await engine().upload(file: file, newIn: "root", name: "A.mov", modifiedAt: nil, resumeKey: "k")
            XCTFail("network error expected")
        } catch SyncAPIError.transport {
        }
        server.onPatch = nil
        let item = try await engine().upload(file: file, newIn: "root", name: "B.mov", modifiedAt: nil, resumeKey: "k")
        XCTAssertEqual(item.name, "B.mov")
        XCTAssertTrue(server.tusRequests.contains { $0.method == "DELETE" })
    }
}
