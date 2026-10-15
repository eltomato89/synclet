import FileProvider
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

/// Local item with freely settable fields (as handed in by the system).
final class TemplateItem: NSObject, NSFileProviderItem, @unchecked Sendable {
    var itemIdentifier: NSFileProviderItemIdentifier
    var parentItemIdentifier: NSFileProviderItemIdentifier
    var filename: String
    var contentType: UTType
    var contentModificationDate: Date?

    init(id: String = "__new__", parent: NSFileProviderItemIdentifier, name: String, type: UTType, modified: Date? = nil) {
        itemIdentifier = NSFileProviderItemIdentifier(id)
        parentItemIdentifier = parent
        filename = name
        contentType = type
        contentModificationDate = modified
    }
}

final class ExtensionTests: XCTestCase {
    var tempDir: URL!
    let personal = NSFileProviderItemIdentifier("space:personal")

    override func setUp() {
        tempDir = Fixtures.tempDirectory()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
    }

    private func makeExtension() -> SyncletReplicatedExtension {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "Synclet – jens@test")
        let context = self.context
        // 2026-10-03 12:50:15 UTC
        return SyncletReplicatedExtension(domain: domain, temporaryDirectory: tempDir,
                                          now: { Date(timeIntervalSince1970: 1_791_031_815) }) { context }
    }

    private var context: SyncletReplicatedExtension.Context {
        .init(client: Fixtures.client(), deviceName: "Jens' MacBook", layout: Fixtures.layout)
    }

    private func assertNoRequests() {
        MockURLProtocol.reset { request in
            XCTFail("unexpected request \(request.method) \(request.path)")
            return .empty(500)
        }
    }

    // MARK: modifyItem

    func testModifyContentConflictCreatesCopyAndReturnsServerState() async throws {
        let serverJSON = Fixtures.itemJSON(id: "f_1", parentId: "d_5", name: "Angebot.pdf", version: 5, contentEtag: "v5", etag: "v5")
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PUT", "/api/sync/v1/items/f_1/content"):
                return .error(412, "conflict", item: serverJSON)
            case ("POST", "/api/sync/v1/items/upload"):
                return .json(201, Fixtures.itemJSON(id: "f_copy", parentId: "d_5", name: request.query["name"] ?? ""))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "d_5", name: "Angebot.pdf"), layout: Fixtures.layout)
        let file = Fixtures.tempFile("lokal geändert")
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data("m".utf8))

        let result = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents, .contentModificationDate],
                                                      contents: file, context: context, progress: nil)

        XCTAssertEqual(result.item.syncItem?.contentEtag, "v5")
        XCTAssertTrue(result.shouldFetchContent)
        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["PUT", "POST"])
        XCTAssertEqual(requests[0].header("If-Match"), "\"v3\"")
        let upload = requests[1]
        XCTAssertEqual(upload.query["parentId"], "d_5")
        XCTAssertEqual(upload.query["onConflict"], "rename")
        let expectedTime = ConflictNaming.timestamp(Date(timeIntervalSince1970: 1_791_031_815))
        XCTAssertEqual(upload.query["name"], "Angebot (Konflikt Jens' MacBook \(expectedTime)).pdf")
        XCTAssertEqual(upload.body, Data("lokal geändert".utf8))
    }

    /// I1: the first PUT is published but its response is lost; the system retries with the
    /// old base version and gets 412 with our own content ⇒ no conflict copy, no problem.
    func testLostPutResponseThenRetryWith412OfOwnContentMakesNoConflictCopy() async throws {
        let content = "lokal geändert"
        let file = Fixtures.tempFile(content)
        let sha = try TransferEngine.sha256(of: file)
        let published = Fixtures.itemJSON(id: "f_1", parentId: "d_5", name: "Angebot.pdf", version: 4,
                                          contentEtag: "v4", etag: "v4", sha256: sha, size: Data(content.utf8).count)
        let puts = Counter()
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PUT", "/api/sync/v1/items/f_1/content"):
                if puts.next() == 1 { throw URLError(.networkConnectionLost) } // committed, response lost
                return .error(412, "conflict", item: published)
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "d_5", name: "Angebot.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data("m".utf8))
        let ext = ReportRecordingExtension.make(tempDir: tempDir, context: context)

        do {
            _ = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents],
                                     contents: file, context: context, progress: nil)
            XCTFail("the lost response must fail the first attempt")
        } catch {}
        let result = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents],
                                          contents: file, context: context, progress: nil)

        XCTAssertEqual(result.item.syncItem?.contentEtag, "v4")
        XCTAssertFalse(result.shouldFetchContent)
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PUT", "PUT"])
        XCTAssertEqual(MockURLProtocol.requests.last?.header("If-Match"), "\"v3\"")
        XCTAssertTrue(ext.problems.isEmpty)
    }

    /// Same size but other content on the server ⇒ still a real conflict.
    func testConflictWithSameSizeButOtherShaStillMakesCopy() async throws {
        let content = "lokal geändert"
        let serverJSON = Fixtures.itemJSON(id: "f_1", parentId: "d_5", name: "Angebot.pdf", version: 4, contentEtag: "v4",
                                           etag: "v4", sha256: String(repeating: "0", count: 64), size: Data(content.utf8).count)
        MockURLProtocol.reset { request in
            request.method == "PUT" ? .error(412, "conflict", item: serverJSON)
                : .json(201, Fixtures.itemJSON(id: "f_copy", parentId: "d_5", name: request.query["name"] ?? ""))
        }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "d_5", name: "Angebot.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        let ext = ReportRecordingExtension.make(tempDir: tempDir, context: context)
        let result = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents],
                                          contents: Fixtures.tempFile(content), context: context, progress: nil)
        XCTAssertTrue(result.shouldFetchContent)
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PUT", "POST"])
        XCTAssertEqual(ext.problems.map(\.code), [.conflictCopy])
    }

    func testModifyContentConflictAtTopLevelUploadsCopyIntoRoot() async throws {
        let serverJSON = Fixtures.itemJSON(id: "f_1", parentId: "root", name: "Notiz.txt", version: 5, contentEtag: "v5", etag: "v5")
        MockURLProtocol.reset { request in
            request.method == "PUT" ? .error(412, "conflict", item: serverJSON)
                : .json(201, Fixtures.itemJSON(id: "f_copy", parentId: "root", name: request.query["name"] ?? ""))
        }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "root", name: "Notiz.txt"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        let result = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents],
                                                      contents: Fixtures.tempFile("x"), context: context, progress: nil)
        XCTAssertEqual(result.item.parentItemIdentifier, personal)
        XCTAssertEqual(MockURLProtocol.requests.last?.query["parentId"], "root")
    }

    func testModifyContentSuccessSendsModifiedAt() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1", version: 4, contentEtag: "v4", etag: "v4")) }
        let local = TemplateItem(id: "f_1", parent: personal, name: "Angebot.pdf", type: .pdf,
                                 modified: Date(timeIntervalSince1970: 1_700_000_000))
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        let result = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents],
                                                      contents: Fixtures.tempFile("neu"), context: context, progress: nil)
        XCTAssertEqual(result.item.syncItem?.contentEtag, "v4")
        XCTAssertFalse(result.shouldFetchContent)
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PUT"])
        XCTAssertEqual(MockURLProtocol.requests.first?.header("X-Synclet-Modified-At"), "2023-11-14T22:13:20.000Z")
    }

    func testModifyContentOfRemotelyDeletedFileReuploadsAsNewFile() async throws {
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PUT", _): return .error(404, "not_found")
            case ("POST", "/api/sync/v1/items/upload"):
                return .json(201, Fixtures.itemJSON(id: "f_new", parentId: "d_5", name: request.query["name"] ?? ""))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_5"), name: "Bericht.docx", type: .data)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents],
                                                 contents: Fixtures.tempFile("meine Änderung"), context: context, progress: nil)
            XCTFail("noSuchItem expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.noSuchItem.rawValue)
        }
        let upload = try XCTUnwrap(MockURLProtocol.requests.last)
        XCTAssertEqual(upload.query["parentId"], "d_5")
        XCTAssertEqual(upload.query["name"], "Bericht.docx")
        XCTAssertEqual(upload.body, Data("meine Änderung".utf8))
    }

    func testModifyContentConflictWithoutItemFetchesServerState() async throws {
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PUT", _): return .json(412, #"{"statusCode":412,"message":"conflict","code":"conflict"}"#)
            case ("GET", "/api/sync/v1/items/f_1"):
                return .json(200, Fixtures.itemJSON(id: "f_1", parentId: "d_5", version: 6, contentEtag: "v6", etag: "v6"))
            case ("POST", "/api/sync/v1/items/upload"):
                return .json(201, Fixtures.itemJSON(id: "f_copy", parentId: "d_5", name: request.query["name"] ?? ""))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "d_5"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        let result = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents],
                                                      contents: Fixtures.tempFile("x"), context: context, progress: nil)
        XCTAssertEqual(result.item.syncItem?.contentEtag, "v6")
        XCTAssertTrue(result.shouldFetchContent)
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PUT", "GET", "POST"])
        XCTAssertEqual(MockURLProtocol.requests.last?.query["parentId"], "d_5")
    }

    func testRecreateFallsBackToSpaceRootWhenParentIsGoneToo() async throws {
        MockURLProtocol.reset { request in
            switch (request.method, request.query["parentId"]) {
            case ("PUT", _): return .error(404, "not_found")
            case ("POST", "d_gone"): return .error(404, "not_found")
            case ("POST", "root"):
                return .json(201, Fixtures.itemJSON(id: "f_new", parentId: "root", name: request.query["name"] ?? ""))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_gone"), name: "Bericht.docx", type: .data)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data())
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: base, changedFields: [.contents],
                                                 contents: Fixtures.tempFile("x"), context: context, progress: nil)
            XCTFail("noSuchItem expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.noSuchItem.rawValue)
        }
        XCTAssertEqual(MockURLProtocol.requests.compactMap { $0.query["parentId"] }, ["d_gone", "root"])
    }

    // I1: PATCH 404 with a new parent is ambiguous.

    func testMoveIntoVanishedFolderReportsMissingParentWithoutUpload() async throws {
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PATCH", _): return .error(404, "not_found")
            case ("GET", "/api/sync/v1/items/f_1"): return .json(200, Fixtures.itemJSON(id: "f_1", parentId: "d_old"))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let target = NSFileProviderItemIdentifier("d_gone")
        let local = TemplateItem(id: "f_1", parent: target, name: "Angebot.pdf", type: .pdf)
        for fields: NSFileProviderItemFields in [[.parentItemIdentifier], [.parentItemIdentifier, .contents]] {
            do {
                _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                     changedFields: fields, contents: Fixtures.tempFile("x"),
                                                     context: context, progress: nil)
                XCTFail("noSuchItem expected")
            } catch {
                let ns = ErrorMapping.fileProviderError(error) as NSError
                XCTAssertEqual(ns.domain, NSFileProviderErrorDomain)
                XCTAssertEqual(ns.code, NSFileProviderError.Code.noSuchItem.rawValue)
                XCTAssertEqual(ns.userInfo[NSFileProviderErrorNonExistentItemIdentifierKey] as? NSFileProviderItemIdentifier, target)
            }
        }
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.method == "POST" || $0.method == "PUT" })
    }

    /// The probe after a PATCH 404 fails transiently: that is not "item gone". The error is
    /// rethrown (the system retries later) and nothing is uploaded.
    func testMoveProbeServerErrorIsRethrownWithoutUpload() async throws {
        for status in [500, 503] {
            MockURLProtocol.reset { request in
                switch (request.method, request.path) {
                case ("PATCH", _): return .error(404, "not_found")
                case ("GET", "/api/sync/v1/items/f_1"): return .empty(status)
                default:
                    XCTFail("unexpected: \(request.method) \(request.path)")
                    return .empty(500)
                }
            }
            let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_2"), name: "Angebot.pdf", type: .pdf)
            do {
                _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                     changedFields: [.parentItemIdentifier, .contents],
                                                     contents: Fixtures.tempFile("lokal"), context: context, progress: nil)
                XCTFail("error expected")
            } catch {
                XCTAssertEqual(error as? SyncAPIError, .http(status: status, code: nil, message: nil))
                let mapped = ErrorMapping.fileProviderError(error) as NSError
                XCTAssertEqual(mapped.code, NSFileProviderError.Code.serverUnreachable.rawValue)
            }
            XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PATCH", "GET"])
        }
    }

    func testMoveProbeNetworkErrorIsRethrownWithoutUpload() async throws {
        MockURLProtocol.reset { request in
            if request.method == "GET" { throw URLError(.notConnectedToInternet) }
            if request.method == "PATCH" { return .error(404, "not_found") }
            XCTFail("unexpected: \(request.method) \(request.path)")
            return .empty(500)
        }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_2"), name: "Angebot.pdf", type: .pdf)
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                 changedFields: [.parentItemIdentifier, .contents],
                                                 contents: Fixtures.tempFile("lokal"), context: context, progress: nil)
            XCTFail("error expected")
        } catch SyncAPIError.transport(let code, _) {
            XCTAssertEqual(code, .notConnectedToInternet)
        }
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.method == "POST" || $0.method == "PUT" })
    }

    func testMoveOfItemDeletedOnServerWithContentRecreates() async throws {
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("PATCH", _), ("GET", "/api/sync/v1/items/f_1"): return .error(404, "not_found")
            case ("POST", "/api/sync/v1/items/upload"):
                return .json(201, Fixtures.itemJSON(id: "f_new", parentId: "d_2", name: request.query["name"] ?? ""))
            default:
                XCTFail("unexpected: \(request.method) \(request.path)")
                return .empty(500)
            }
        }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_2"), name: "Angebot.pdf", type: .pdf)
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                 changedFields: [.parentItemIdentifier, .contents],
                                                 contents: Fixtures.tempFile("lokal"), context: context, progress: nil)
            XCTFail("noSuchItem expected")
        } catch {
            let ns = error as NSError
            XCTAssertEqual(ns.code, NSFileProviderError.Code.noSuchItem.rawValue)
            XCTAssertNil(ns.userInfo[NSFileProviderErrorNonExistentItemIdentifierKey])
        }
        let upload = try XCTUnwrap(MockURLProtocol.requests.first { $0.method == "POST" })
        XCTAssertEqual(upload.query["parentId"], "d_2")
        XCTAssertEqual(upload.body, Data("lokal".utf8))
    }

    func testMoveOfItemDeletedOnServerWithoutContentIsNoSuchItem() async {
        MockURLProtocol.reset { request in
            if request.method == "POST" { XCTFail("no upload expected") }
            return .error(404, "not_found")
        }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_2"), name: "Angebot.pdf", type: .pdf)
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                 changedFields: [.parentItemIdentifier], contents: nil,
                                                 context: context, progress: nil)
            XCTFail("noSuchItem expected")
        } catch {
            let ns = error as NSError
            XCTAssertEqual(ns.code, NSFileProviderError.Code.noSuchItem.rawValue)
            XCTAssertNil(ns.userInfo[NSFileProviderErrorNonExistentItemIdentifierKey])
        }
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PATCH", "GET"])
    }

    func testRenameOnlyOf404ItemDoesNotProbe() async {
        MockURLProtocol.reset { _ in .error(404, "not_found") }
        let local = TemplateItem(id: "f_1", parent: personal, name: "Neu.pdf", type: .pdf)
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                 changedFields: [.filename], contents: nil, context: context, progress: nil)
            XCTFail("noSuchItem expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.noSuchItem.rawValue)
        }
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["PATCH"])
    }

    func testModifyRenameAndMoveWithinSpaceUsesPatch() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1", parentId: "d_2", name: "Neu.pdf")) }
        let local = TemplateItem(id: "f_1", parent: NSFileProviderItemIdentifier("d_2"), name: "Neu.pdf", type: .pdf)
        let result = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                      changedFields: [.filename, .parentItemIdentifier],
                                                      contents: nil, context: context, progress: nil)
        XCTAssertEqual(result.item.filename, "Neu.pdf")
        XCTAssertEqual(result.item.parentItemIdentifier.rawValue, "d_2")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "PATCH")
        XCTAssertEqual(request.json?["name"] as? String, "Neu.pdf")
        XCTAssertEqual(request.json?["parentId"] as? String, "d_2")
    }

    func testModifyMoveIntoSpaceFolderMapsToRootID() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1", parentId: "root")) }
        let local = TemplateItem(id: "f_1", parent: personal, name: "Angebot.pdf", type: .pdf)
        let result = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                      changedFields: [.parentItemIdentifier],
                                                      contents: nil, context: context, progress: nil)
        XCTAssertEqual(MockURLProtocol.requests.first?.json?["parentId"] as? String, "root")
        XCTAssertEqual(result.item.parentItemIdentifier, personal)
    }

    func testModifyMoveIntoRootContainerIsRejectedWithoutRequest() async {
        assertNoRequests()
        let local = TemplateItem(id: "f_1", parent: .rootContainer, name: "A.pdf", type: .pdf)
        do {
            _ = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                 changedFields: [.parentItemIdentifier],
                                                 contents: nil, context: context, progress: nil)
            XCTFail("error expected")
        } catch {
            let mapped = ErrorMapping.fileProviderError(error) as NSError
            XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(mapped.code, NSFileProviderError.Code.cannotSynchronize.rawValue)
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testRenameOrMoveOfSpaceFolderIsUnsupported() async {
        assertNoRequests()
        for fields: NSFileProviderItemFields in [.filename, .parentItemIdentifier, .contents] {
            let space = TemplateItem(id: "space:personal", parent: .rootContainer, name: "Umbenannt", type: .folder)
            do {
                _ = try await makeExtension().modify(item: space, baseVersion: NSFileProviderItemVersion(),
                                                     changedFields: fields, contents: nil, context: context, progress: nil)
                XCTFail("error expected for \(fields)")
            } catch {
                let ns = ErrorMapping.fileProviderError(error) as NSError
                XCTAssertEqual(ns.domain, NSCocoaErrorDomain)
                XCTAssertEqual(ns.code, NSFeatureUnsupportedError)
            }
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testOtherFieldsOfSpaceFolderAreIgnored() async throws {
        assertNoRequests()
        let space = TemplateItem(id: "space:personal", parent: .rootContainer, name: "Meine Dateien", type: .folder)
        let result = try await makeExtension().modify(item: space, baseVersion: NSFileProviderItemVersion(),
                                                      changedFields: [.tagData, .lastUsedDate], contents: nil,
                                                      context: context, progress: nil)
        XCTAssertEqual(result.item.itemIdentifier, personal)
        XCTAssertFalse(result.item.capabilities.contains(.allowsRenaming))
    }

    func testModifyIgnoresUnsupportedFields() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1")) }
        let local = FileProviderItem(Fixtures.item(id: "f_1"), layout: Fixtures.layout)
        let result = try await makeExtension().modify(item: local, baseVersion: NSFileProviderItemVersion(),
                                                      changedFields: [.tagData, .lastUsedDate, .favoriteRank, .contentModificationDate],
                                                      contents: nil, context: context, progress: nil)
        XCTAssertEqual(result.item.syncItem?.id, "f_1")
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["GET"])
    }

    // MARK: createItem

    func testCreateFileInSpaceUploadsIntoRoot() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.itemJSON(id: "f_new", parentId: "root", name: "Notiz.txt")) }
        let template = TemplateItem(parent: personal, name: "Notiz.txt", type: .plainText)
        let created = try await makeExtension().create(template: template, contents: Fixtures.tempFile("x"), modifiedAt: nil,
                                                       mayAlreadyExist: false, context: context, progress: nil)
        XCTAssertEqual(created.name, "Notiz.txt")
        XCTAssertEqual(FileProviderItem(created, layout: Fixtures.layout).parentItemIdentifier, personal)
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.path, "/api/sync/v1/items/upload")
        XCTAssertEqual(request.query["parentId"], "root")
        XCTAssertEqual(request.query["onConflict"], "fail")
    }

    func testCreateFileNameConflictRenamesUnlessIdentical() async throws {
        let existing = Fixtures.itemJSON(id: "f_old", parentId: "d_1", name: "Notiz.txt", sha256: "0000")
        MockURLProtocol.reset { request in
            request.query["onConflict"] == "fail"
                ? .error(409, "name_conflict", item: existing)
                : .json(201, Fixtures.itemJSON(id: "f_new", parentId: "d_1", name: "Notiz (2).txt"))
        }
        let template = TemplateItem(parent: NSFileProviderItemIdentifier("d_1"), name: "Notiz.txt", type: .plainText)
        let created = try await makeExtension().create(template: template, contents: Fixtures.tempFile("x"), modifiedAt: nil,
                                                       mayAlreadyExist: false, context: context, progress: nil)
        XCTAssertEqual(created.name, "Notiz (2).txt")
        XCTAssertEqual(MockURLProtocol.requests.map { $0.query["onConflict"] }, ["fail", "rename"])
    }

    func testCreateReusesIdenticalExistingFile() async throws {
        let file = Fixtures.tempFile("same")
        let sha = try SyncletReplicatedExtension.sha256(of: file)
        let existing = Fixtures.itemJSON(id: "f_old", parentId: "d_1", name: "Notiz.txt", sha256: sha)
        MockURLProtocol.reset { _ in .error(409, "name_conflict", item: existing) }
        let template = TemplateItem(parent: NSFileProviderItemIdentifier("d_1"), name: "Notiz.txt", type: .plainText)
        let created = try await makeExtension().create(template: template, contents: file, modifiedAt: nil,
                                                       mayAlreadyExist: true, context: context, progress: nil)
        XCTAssertEqual(created.id, "f_old")
        XCTAssertEqual(MockURLProtocol.requests.count, 1)
    }

    func testCreateFolderMergesExistingFolder() async throws {
        let existing = Fixtures.folderJSON(id: "d_7", name: "Fotos")
        MockURLProtocol.reset { _ in .error(409, "name_conflict", item: existing) }
        let template = TemplateItem(parent: personal, name: "Fotos", type: .folder)
        let created = try await makeExtension().create(template: template, contents: nil, modifiedAt: nil,
                                                       mayAlreadyExist: false, context: context, progress: nil)
        XCTAssertEqual(created.id, "d_7")
        XCTAssertEqual(MockURLProtocol.requests.first?.json?["parentId"] as? String, "root")
    }

    func testCreateInRootContainerIsRejectedWithoutRequest() async {
        assertNoRequests()
        for type: UTType in [.folder, .plainText] {
            let template = TemplateItem(parent: .rootContainer, name: "Streuner", type: type)
            do {
                _ = try await makeExtension().create(template: template, contents: Fixtures.tempFile("x"), modifiedAt: nil,
                                                     mayAlreadyExist: false, context: context, progress: nil)
                XCTFail("error expected")
            } catch {
                let mapped = ErrorMapping.fileProviderError(error) as NSError
                XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain)
                XCTAssertEqual(mapped.code, NSFileProviderError.Code.cannotSynchronize.rawValue)
            }
        }
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
    }

    func testCreateIgnoredNameIsExcluded() async {
        assertNoRequests()
        let template = TemplateItem(parent: personal, name: ".DS_Store", type: .data)
        do {
            _ = try await makeExtension().create(template: template, contents: Fixtures.tempFile("x"), modifiedAt: nil,
                                                 mayAlreadyExist: false, context: context, progress: nil)
            XCTFail("error expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.excludedFromSync.rawValue)
        }
    }

    func testCreateSymlinkIsUnsupported() async {
        assertNoRequests()
        let template = TemplateItem(parent: personal, name: "Link", type: .symbolicLink)
        do {
            _ = try await makeExtension().create(template: template, contents: nil, modifiedAt: nil,
                                                 mayAlreadyExist: false, context: context, progress: nil)
            XCTFail("error expected")
        } catch {
            XCTAssertEqual((error as NSError).code, CocoaError.featureUnsupported.rawValue)
        }
    }

    // MARK: deleteItem / fetchContents / item

    func testDeleteTreatsNotFoundAsSuccess() async throws {
        MockURLProtocol.reset { _ in .error(404, "not_found") }
        try await makeExtension().delete(NSFileProviderItemIdentifier("f_1"), recursive: true, context: context)
        XCTAssertEqual(MockURLProtocol.requests.map(\.method), ["DELETE"])
        XCTAssertEqual(MockURLProtocol.requests.map(\.path), ["/api/sync/v1/items/f_1"])
    }

    func testDeleteOfSpaceFolderOrRootIsUnsupported() async {
        assertNoRequests()
        for identifier in [personal, .rootContainer] {
            do {
                try await makeExtension().delete(identifier, recursive: true, context: context)
                XCTFail("error expected")
            } catch {
                XCTAssertEqual((error as NSError).domain, NSCocoaErrorDomain)
                XCTAssertEqual((error as NSError).code, NSFeatureUnsupportedError)
            }
        }
    }

    func testNonRecursiveDeleteOfNonEmptyFolderFails() async {
        MockURLProtocol.reset { request in
            if request.path.hasSuffix("/children") {
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_1", parentId: "d_1"))],"nextPageToken":null,"cursor":"1"}"#)
            }
            return .json(200, Fixtures.folderJSON(id: "d_1", name: "A"))
        }
        do {
            try await makeExtension().delete(NSFileProviderItemIdentifier("d_1"), recursive: false, context: context)
            XCTFail("error expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.directoryNotEmpty.rawValue)
            XCTAssertFalse(MockURLProtocol.requests.contains { $0.method == "DELETE" })
        }
    }

    func testItemForVirtualAndServerIdentifiers() async throws {
        MockURLProtocol.reset { _ in .json(200, Fixtures.itemJSON(id: "f_1")) }
        let ext = makeExtension()
        let root = try await ext.item(for: .rootContainer)
        XCTAssertEqual(root.itemIdentifier, .rootContainer)
        let space = try await ext.item(for: personal)
        XCTAssertEqual(space.space, Fixtures.personal)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty)
        let file = try await ext.item(for: NSFileProviderItemIdentifier("f_1"))
        XCTAssertEqual(file.parentItemIdentifier, personal)
        XCTAssertEqual(MockURLProtocol.requests.map(\.path), ["/api/sync/v1/items/f_1"])
        do {
            _ = try await ext.item(for: NSFileProviderItemIdentifier("space:gone"))
            XCTFail("error expected")
        } catch {
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.noSuchItem.rawValue)
        }
    }

    func testDownloadReturnsMatchingItem() async throws {
        MockURLProtocol.reset { request in
            if request.path.hasSuffix("/content") {
                return .data(200, Data("PDF".utf8), headers: ["ETag": "\"v3\""])
            }
            return .json(200, Fixtures.itemJSON(id: "f_1"))
        }
        let result = try await makeExtension().download("f_1", client: Fixtures.client(), progress: Progress(totalUnitCount: 100))
        XCTAssertEqual(result.item.id, "f_1")
        XCTAssertEqual(try String(contentsOf: result.url, encoding: .utf8), "PDF")
        XCTAssertTrue(result.url.path.hasPrefix(tempDir.path))
    }

    func testDownloadRetriesWhenContentChangedMeanwhile() async throws {
        let counter = Counter()
        MockURLProtocol.reset { request in
            if request.path.hasSuffix("/content") {
                let n = counter.next()
                return .data(200, Data("Stand \(n)".utf8), headers: ["ETag": n == 1 ? "\"v3\"" : "\"v4\""])
            }
            return .json(200, Fixtures.itemJSON(id: "f_1", version: 4, contentEtag: "v4", etag: "v4"))
        }
        let result = try await makeExtension().download("f_1", client: Fixtures.client(), progress: Progress(totalUnitCount: 100))
        XCTAssertEqual(result.item.contentEtag, "v4")
        XCTAssertEqual(try String(contentsOf: result.url, encoding: .utf8), "Stand 2")
    }

    func testEnumeratorsAndMissingCredentials() throws {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "x")
        let signedOut = SyncletReplicatedExtension(domain: domain) { nil }
        XCTAssertThrowsError(try signedOut.enumerator(for: personal, request: NSFileProviderRequest())) { error in
            XCTAssertEqual((error as NSError).code, NSFileProviderError.Code.notAuthenticated.rawValue)
        }
        let ext = makeExtension()
        XCTAssertThrowsError(try ext.enumerator(for: .trashContainer, request: NSFileProviderRequest()))
        XCTAssertTrue(try ext.enumerator(for: .rootContainer, request: NSFileProviderRequest()) is TopLevelEnumerator)
        XCTAssertTrue(try ext.enumerator(for: personal, request: NSFileProviderRequest()) is FileProviderEnumerator)
        XCTAssertTrue(try ext.enumerator(for: .workingSet, request: NSFileProviderRequest()) is FileProviderEnumerator)
    }
}

/// Records reported problems.
final class ReportRecordingExtension: SyncletReplicatedExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [SyncProblem] = []
    var problems: [SyncProblem] { lock.withLock { recorded } }

    override func report(_ problem: SyncProblem) {
        lock.withLock { recorded.append(problem) }
    }

    static func make(tempDir: URL, context: Context) -> ReportRecordingExtension {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "Synclet – jens@test")
        return ReportRecordingExtension(domain: domain, temporaryDirectory: tempDir,
                                        now: { Date(timeIntervalSince1970: 1_791_031_815) }) { context }
    }
}

