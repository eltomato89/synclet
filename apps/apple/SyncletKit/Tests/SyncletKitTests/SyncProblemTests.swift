import FileProvider
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

/// Records the problems the base class reports (the macOS extension writes them to its error log).
final class RecordingExtension: SyncletReplicatedExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [SyncProblem] = []
    var problems: [SyncProblem] { lock.withLock { recorded } }

    override func report(_ problem: SyncProblem) {
        lock.withLock { recorded.append(problem) }
    }
}

final class SyncProblemTests: XCTestCase {
    var tempDir: URL!
    let personal = NSFileProviderItemIdentifier("space:personal")

    override func setUp() { tempDir = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: tempDir) }

    private func makeExtension() -> RecordingExtension {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"), displayName: "Synclet – jens@test")
        let context = SyncletReplicatedExtension.Context(client: Fixtures.client(), deviceName: "Jens' MacBook", layout: Fixtures.layout)
        return RecordingExtension(domain: domain, temporaryDirectory: tempDir,
                                  now: { Date(timeIntervalSince1970: 1_791_031_815) }) { context }
    }

    // MARK: Classification

    func testUserVisibleProblemsAreClassified() {
        let table: [(Error, SyncProblem.Code?)] = [
            (SyncAPIError.tooLarge(message: nil), .tooLarge),
            (SyncAPIError.insufficientStorage(message: nil), .insufficientStorage),
            (SyncAPIError.invalidName(message: nil), .invalidName),
            (SyncAPIError.forbidden(message: nil), .permission),
            (SyncAPIError.invalidMove(message: nil), .permission),
            (SpaceLayoutError.readOnlyTopLevel, .permission),
            // Transient or handled by the system: not logged.
            (SyncAPIError.transport(.notConnectedToInternet, message: "offline"), nil),
            (SyncAPIError.unauthorized(message: nil), nil),
            (SyncAPIError.notFound, nil),
            (SyncAPIError.nameConflict(existing: nil), nil),
            (SyncAPIError.http(status: 503, code: nil, message: nil), nil),
            (CancellationError(), nil),
            (NSFileProviderError(.excludedFromSync), nil),
        ]
        for (error, code) in table {
            XCTAssertEqual(ErrorMapping.problem(for: error, fileName: "x.bin", itemIdentifier: "id")?.code, code, "\(error)")
        }
        let problem = ErrorMapping.problem(for: SyncAPIError.tooLarge(message: nil), fileName: "Film.mov", itemIdentifier: "f_9")
        XCTAssertEqual(problem?.fileName, "Film.mov")
        XCTAssertEqual(problem?.itemIdentifier, "f_9")
        XCTAssertEqual(problem?.isInfo, false)
    }

    func testCodesAndMessagesInBothLanguages() {
        XCTAssertEqual(SyncProblem.Code.allCases.map(\.rawValue),
                       ["too_large", "insufficient_storage", "invalid_name", "permission", "conflict_copy"])
        let en = TestBundles.lproj("en"), de = TestBundles.lproj("de")
        for code in SyncProblem.Code.allCases {
            let problem = SyncProblem(code: code, fileName: "a.txt", itemIdentifier: nil, detail: "a (Konflikt).txt")
            let english = problem.message(bundle: en), german = problem.message(bundle: de)
            XCTAssertFalse(english.isEmpty)
            XCTAssertNotEqual(english, german, "\(code) needs a German text")
            XCTAssertFalse(german.contains("problem."), "missing de key for \(code)")
        }
        XCTAssertEqual(SyncProblem(code: .tooLarge, fileName: "a", itemIdentifier: nil).message(bundle: de),
                       "Zu groß für den Server – nicht hochgeladen.")
        XCTAssertTrue(SyncProblem(code: .conflictCopy, fileName: "a", itemIdentifier: nil, detail: "a (Konflikt X).txt")
            .message(bundle: de).contains("„a (Konflikt X).txt“"))
        XCTAssertTrue(SyncProblem(code: .conflictCopy, fileName: "a", itemIdentifier: nil).isInfo)
    }

    // MARK: Reporting from the extension

    func testCreateTooLargeIsReported() async {
        MockURLProtocol.reset { _ in .empty(413) }
        let ext = makeExtension()
        let template = TemplateItem(id: "local-1", parent: personal, name: "Film.mov", type: .movie)
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.createItem(basedOn: template, fields: [.contents], contents: Fixtures.tempFile("x"), options: [],
                               request: NSFileProviderRequest()) { _, _, _, error in continuation.resume(returning: error) }
        }
        XCTAssertEqual((error as NSError?)?.code, NSFileProviderError.insufficientQuota.rawValue)
        XCTAssertEqual(ext.problems, [SyncProblem(code: .tooLarge, fileName: "Film.mov", itemIdentifier: "local-1")])
    }

    func testModifyInsufficientStorageIsReported() async {
        MockURLProtocol.reset { _ in .error(507, "insufficient_storage") }
        let ext = makeExtension()
        let local = FileProviderItem(Fixtures.item(id: "f_1", name: "Angebot.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data("m".utf8))
        let error: Error? = await withCheckedContinuation { continuation in
            _ = ext.modifyItem(local, baseVersion: base, changedFields: [.contents], contents: Fixtures.tempFile("neu"),
                               options: [], request: NSFileProviderRequest()) { _, _, _, error in continuation.resume(returning: error) }
        }
        XCTAssertNotNil(error)
        XCTAssertEqual(ext.problems.map(\.code), [.insufficientStorage])
        XCTAssertEqual(ext.problems.first?.fileName, "Angebot.pdf")
        XCTAssertEqual(ext.problems.first?.itemIdentifier, "f_1")
    }

    func testTransientFailureIsNotReported() async {
        MockURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        let ext = makeExtension()
        let template = TemplateItem(parent: personal, name: "a.txt", type: .plainText)
        _ = await withCheckedContinuation { (continuation: CheckedContinuation<Error?, Never>) in
            _ = ext.createItem(basedOn: template, fields: [.contents], contents: Fixtures.tempFile("x"), options: [],
                               request: NSFileProviderRequest()) { _, _, _, error in continuation.resume(returning: error) }
        }
        XCTAssertEqual(ext.problems, [])
    }

    func testConflictCopyIsReportedAsInfo() async throws {
        let serverJSON = Fixtures.itemJSON(id: "f_1", parentId: "d_5", name: "Angebot.pdf", version: 5, contentEtag: "v5", etag: "v5")
        MockURLProtocol.reset { request in
            request.method == "PUT"
                ? .error(412, "conflict", item: serverJSON)
                : .json(201, Fixtures.itemJSON(id: "f_copy", parentId: "d_5", name: request.query["name"] ?? ""))
        }
        let ext = makeExtension()
        let local = FileProviderItem(Fixtures.item(id: "f_1", parentId: "d_5", name: "Angebot.pdf"), layout: Fixtures.layout)
        let base = NSFileProviderItemVersion(contentVersion: Data("v3".utf8), metadataVersion: Data("m".utf8))
        let context = SyncletReplicatedExtension.Context(client: Fixtures.client(), deviceName: "Jens' MacBook", layout: Fixtures.layout)
        _ = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents], contents: Fixtures.tempFile("lokal"),
                                 context: context, progress: nil)
        let expectedTime = ConflictNaming.timestamp(Date(timeIntervalSince1970: 1_791_031_815))
        XCTAssertEqual(ext.problems, [SyncProblem(code: .conflictCopy, fileName: "Angebot.pdf", itemIdentifier: "f_copy",
                                                  detail: "Angebot (Konflikt Jens' MacBook \(expectedTime)).pdf")])
        XCTAssertTrue(ext.problems[0].isInfo)
    }
}
