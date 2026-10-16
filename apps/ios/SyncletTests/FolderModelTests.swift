import Foundation
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class FolderModelTests: XCTestCase {
    private var server: FakeFolderServer!
    private var signals: SignalRecorder!

    override func setUp() async throws {
        server = FakeFolderServer(["root": [Items.file("b.txt"), Items.folder("A-folder"), Items.file("a.txt")]])
        server.install()
        signals = SignalRecorder()
    }

    private func makeModel(folderId: String = "root") -> FolderModel {
        FolderModel(accountKey: "acc", folderId: folderId, title: "Meine Dateien", api: server.client(),
                    signal: signals.callback)
    }

    private var requests: [RecordedRequest] { MockURLProtocol.requests }

    private func childrenGETs() -> Int {
        requests.filter { $0.method == "GET" && $0.path.hasSuffix("/children") }.count
    }

    private static let changedInTheMeantime = ["Changed in the meantime", "Wurde inzwischen geändert"]
    private static let noLongerExists = ["No longer exists", "Nicht mehr vorhanden"]

    // MARK: - Loading

    func testLoadSortsFoldersFirstThenName() async {
        let model = makeModel()
        XCTAssertEqual(model.state, .idle)
        await model.load()
        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.items.map(\.name), ["A-folder", "a.txt", "b.txt"])
    }

    func testSortBySizeAndModifiedKeepsFoldersFirst() async {
        server.children = ["root": [
            Items.file("small", size: 1, modified: "2026-10-03T10:00:00.000Z"),
            Items.folder("Z"),
            Items.file("big", size: 100, modified: "2026-10-01T10:00:00.000Z"),
        ]]
        let model = makeModel()
        await model.load()
        model.sort = .size
        XCTAssertEqual(model.items.map(\.name), ["Z", "big", "small"])
        model.sort = .modified
        XCTAssertEqual(model.items.map(\.name), ["Z", "small", "big"])
    }

    func testLoadFollowsPagination() async {
        server.children = ["root": (1...5).map { Items.file("file\($0).txt") }]
        server.pageSize = 2
        let model = makeModel()
        await model.load()
        XCTAssertEqual(model.items.count, 5)
        XCTAssertEqual(childrenGETs(), 3)
        let tokens = requests.compactMap { FakeBrowser.query($0.request.url!)["pageToken"] }
        XCTAssertEqual(tokens, ["2", "4"])
    }

    func testOfflineState() async {
        server.override = { _ in .failure(.notConnectedToInternet) }
        let model = makeModel()
        await model.load()
        XCTAssertEqual(model.state, .offline)
    }

    func testServerErrorIsFailed() async {
        server.override = { _ in Items.error(500, "internal") }
        let model = makeModel()
        await model.load()
        guard case .failed = model.state else { return XCTFail("state \(model.state)") }
    }

    // MARK: - Rename

    func testRenameSendsIfMatchAndSignals() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        let before = childrenGETs()
        let ok = await model.rename(item, to: "c.txt")
        XCTAssertTrue(ok)
        let patches = requests.filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.count, 1)
        XCTAssertEqual(patches.first?.request.value(forHTTPHeaderField: "If-Match"), "\"\(item.etag)\"")
        XCTAssertEqual(patches.first?.json?["name"] as? String, "c.txt")
        XCTAssertEqual(signals.keys, ["acc"])
        XCTAssertEqual(childrenGETs(), before + 1)
    }

    func testRenameConflictReloadsAndReports() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        server.override = { $0.method == "PATCH" ? Items.error(412, "conflict", item: item) : nil }
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let ok = await model.rename(item, to: "c.txt")
        XCTAssertFalse(ok)
        XCTAssertTrue(Self.changedInTheMeantime.contains(model.notice ?? ""), "notice \(model.notice ?? "nil")")
        XCTAssertEqual(model.lastOutcome, .conflictReloaded)
        XCTAssertNil(model.fieldError)
        let methods = requests.map(\.method)
        XCTAssertEqual(methods, ["PATCH", "GET"], "exactly one PATCH (no retry), then the reload")
        XCTAssertTrue(signals.keys.isEmpty)
    }

    func testConflictMessageIsLocalized() {
        let path = Bundle.main.path(forResource: "de", ofType: "lproj")
        let german = path.flatMap(Bundle.init(path:))
        XCTAssertEqual(german?.localizedString(forKey: "Changed in the meantime", value: nil, table: nil),
                       "Wurde inzwischen geändert")
        XCTAssertEqual(german?.localizedString(forKey: "No longer exists", value: nil, table: nil),
                       "Nicht mehr vorhanden")
        XCTAssertEqual(german?.localizedString(forKey: "Name already taken", value: nil, table: nil),
                       "Name bereits vergeben")
    }

    func testRenameToSameNameSendsNothing() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let ok = await model.rename(item, to: "a.txt")
        XCTAssertTrue(ok)
        XCTAssertTrue(requests.isEmpty)
    }

    func testRenameRejectsInvalidNameBeforeSending() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let ok = await model.rename(item, to: "a/b")
        XCTAssertFalse(ok)
        XCTAssertNotNil(model.fieldError)
        XCTAssertTrue(requests.isEmpty)
    }

    func testRenameServerInvalidNameIsInline() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        server.override = { $0.method == "PATCH" ? Items.error(400, "invalid_name") : nil }
        let ok = await model.rename(item, to: "CON")
        XCTAssertFalse(ok)
        XCTAssertEqual(model.lastOutcome, .invalidName("invalid_name message"))
        XCTAssertEqual(model.fieldError, "invalid_name message")
    }

    // MARK: - Create

    func testCreateFolderSignalsAndReloads() async {
        let model = makeModel()
        await model.load()
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let ok = await model.createFolder(name: "Neu")
        XCTAssertTrue(ok)
        let post = requests.first { $0.method == "POST" }
        XCTAssertEqual(post?.json?["parentId"] as? String, "root")
        XCTAssertEqual(post?.json?["name"] as? String, "Neu")
        XCTAssertEqual(signals.keys, ["acc"])
        XCTAssertEqual(childrenGETs(), 1)
    }

    func testCreateFolderNameTakenKeepsSheetOpen() async {
        let model = makeModel()
        await model.load()
        server.override = { $0.method == "POST" ? Items.error(409, "name_conflict", item: Items.folder("A-folder")) : nil }
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let ok = await model.createFolder(name: "A-folder")
        XCTAssertFalse(ok)
        XCTAssertEqual(model.lastOutcome, .nameTaken)
        XCTAssertTrue(["Name already taken", "Name bereits vergeben"].contains(model.fieldError ?? ""))
        XCTAssertNil(model.notice)
        XCTAssertTrue(signals.keys.isEmpty)
        XCTAssertEqual(requests.map(\.method), ["POST"], "no reload: the sheet stays open")
    }

    // MARK: - Delete / move

    func testDeleteGoneReloads() async {
        let model = makeModel()
        await model.load()
        let item = model.items.first { $0.name == "a.txt" }!
        server.override = { $0.method == "DELETE" ? Items.error(404, "not_found") : nil }
        MockURLProtocol.reset { [server] in server!.respond($0) }
        await model.delete([item])
        XCTAssertTrue(Self.noLongerExists.contains(model.notice ?? ""), "notice \(model.notice ?? "nil")")
        XCTAssertEqual(model.lastOutcome, .gone)
        XCTAssertEqual(requests.map(\.method), ["DELETE", "GET"])
    }

    func testDeleteMultipleSignalsOnce() async {
        let model = makeModel()
        await model.load()
        MockURLProtocol.reset { [server] in server!.respond($0) }
        await model.delete(model.items.filter { !$0.isFolder })
        XCTAssertEqual(requests.filter { $0.method == "DELETE" }.count, 2)
        XCTAssertEqual(signals.keys, ["acc"])
        XCTAssertEqual(childrenGETs(), 1)
        XCTAssertEqual(model.lastOutcome, .ok)
        XCTAssertNil(model.notice)
    }

    func testMoveMultipleItems() async {
        let model = makeModel()
        await model.load()
        let files = model.items.filter { !$0.isFolder }
        MockURLProtocol.reset { [server] in server!.respond($0) }
        await model.move(files, to: "d-A-folder")
        let patches = requests.filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.count, 2)
        XCTAssertEqual(patches.compactMap { $0.json?["parentId"] as? String }, ["d-A-folder", "d-A-folder"])
        XCTAssertEqual(Set(patches.compactMap { $0.request.value(forHTTPHeaderField: "If-Match") }),
                       Set(files.map { "\"\($0.etag)\"" }))
        XCTAssertEqual(signals.keys, ["acc"])
        XCTAssertEqual(childrenGETs(), 1)
    }

    func testMoveConflictOnOneItemStillSignalsTheOthers() async {
        let model = makeModel()
        await model.load()
        let files = model.items.filter { !$0.isFolder }
        let conflicting = files[0].id
        server.override = { request in
            request.method == "PATCH" && request.path.hasSuffix(conflicting) ? Items.error(412, "conflict") : nil
        }
        MockURLProtocol.reset { [server] in server!.respond($0) }
        await model.move(files, to: "d-A-folder")
        XCTAssertEqual(requests.filter { $0.method == "PATCH" }.count, 2)
        XCTAssertEqual(model.lastOutcome, .conflictReloaded)
        XCTAssertTrue(Self.changedInTheMeantime.contains(model.notice ?? ""))
        XCTAssertEqual(signals.keys, ["acc"])
        XCTAssertEqual(childrenGETs(), 1)
    }

    func testMutationOfflineReportsNotice() async {
        let model = makeModel()
        await model.load()
        let item = model.items[0]
        server.override = { $0.method == "DELETE" ? .failure(.notConnectedToInternet) : nil }
        await model.delete([item])
        XCTAssertEqual(model.lastOutcome, .offline)
        XCTAssertNotNil(model.notice)
        XCTAssertTrue(signals.keys.isEmpty)
    }

    // MARK: - Live changes

    func testChangeEventsReloadDebounced() async {
        let model = makeModel()
        model.debounce = .milliseconds(100)
        await model.load()
        MockURLProtocol.reset { [server] in server!.respond($0) }
        let (stream, continuation) = AsyncStream.makeStream(of: String.self)
        let observer = Task { await model.observe(stream) }
        continuation.yield("other")
        continuation.yield("acc")
        continuation.yield("acc")
        continuation.yield("acc")
        let reloaded = await eventually { self.childrenGETs() == 1 }
        XCTAssertTrue(reloaded)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(childrenGETs(), 1, "three changes in a burst reload once")
        continuation.finish()
        observer.cancel()
    }

    func testNamePrecheckRejectsInvalid() {
        for name in ["", "   ", "a/b", "a\\b", "x:y", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b",
                     String(repeating: "a", count: 256), String(repeating: "ä", count: 128)] {
            XCTAssertNotNil(MutationErrors.nameProblem(name), "should reject \(name)")
        }
        for name in ["Bericht 2026.pdf", String(repeating: "a", count: 255), "Ä Ö Ü"] {
            XCTAssertNil(MutationErrors.nameProblem(name), "should accept \(name)")
        }
    }
}
