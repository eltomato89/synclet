import Foundation
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class TrashModelTests: XCTestCase {
    private var signals: SignalRecorder!
    private let entriesBox = LockedBox<[TrashEntry]>([])
    private let restoreBox = LockedBox<MockResponse?>(nil)
    private var entries: [TrashEntry] {
        get { entriesBox.value }
        set { entriesBox.value = newValue }
    }
    private var restoreResponse: MockResponse {
        get { restoreBox.value! }
        set { restoreBox.value = newValue }
    }

    override func setUp() async throws {
        signals = SignalRecorder()
        entries = [AppFixtures.trashEntry("a.txt"), AppFixtures.trashEntry("b.txt")]
        restoreResponse = AppFixtures.ok(RestoreResult(item: Items.file("a.txt"), restoredTo: "/Docs", renamed: false))
        MockURLProtocol.reset { [entriesBox, restoreBox] request in
            Self.respond(request, entries: entriesBox.value, restore: restoreBox.value!)
        }
    }

    nonisolated private static func respond(_ request: RecordedRequest, entries: [TrashEntry],
                                            restore: MockResponse) -> MockResponse {
        switch (request.method, request.path) {
        case ("GET", "/api/trash"): return AppFixtures.ok(entries)
        case ("POST", let path) where path.hasSuffix("/restore"): return restore
        case ("DELETE", "/api/trash"): return .json(200, #"{"removed":2}"#)
        case ("DELETE", _): return .empty(204)
        default: return Items.error(404, "not_found")
        }
    }

    private func makeModel() -> TrashModel {
        TrashModel(accountKey: "acc", api: AppFixtures.client(), signal: signals.callback)
    }

    private var requests: [RecordedRequest] { MockURLProtocol.requests }

    func testLoad() async {
        let model = makeModel()
        await model.load()
        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.entries.map(\.name), ["a.txt", "b.txt"])
    }

    func testRestoreNotice() async {
        let model = makeModel()
        await model.load()
        await model.restore(model.entries[0])
        XCTAssertTrue(requests.contains { $0.method == "POST" && $0.path == "/api/trash/t-a.txt/restore" })
        let notice = model.notice ?? ""
        XCTAssertTrue(notice.contains("“/Docs”") || notice.contains("„/Docs“"), notice)
        XCTAssertEqual(signals.keys, ["acc"])
    }

    func testRestoreRenamedNotice() async {
        restoreResponse = AppFixtures.ok(RestoreResult(item: Items.file("a (1).txt"), restoredTo: "/Docs", renamed: true))
        let model = makeModel()
        await model.load()
        await model.restore(model.entries[0])
        let notice = model.notice ?? ""
        XCTAssertTrue(notice.contains("/Docs"), notice)
        XCTAssertTrue(notice.contains("a (1).txt"), notice)
        XCTAssertEqual(signals.keys, ["acc"])
    }

    func testRestoreNoticeIsLocalized() {
        let path = Bundle.main.path(forResource: "de", ofType: "lproj")
        let german = path.flatMap(Bundle.init(path:))
        XCTAssertEqual(german?.localizedString(forKey: "Restored to “%@”", value: nil, table: nil),
                       "Wiederhergestellt in „%@“")
        XCTAssertEqual(german?.localizedString(forKey: "Restored to “%@” as “%@”", value: nil, table: nil),
                       "Wiederhergestellt in „%1$@“ als „%2$@“")
        XCTAssertEqual(german?.localizedString(forKey: "Recent", value: nil, table: nil), "Zuletzt")
        XCTAssertEqual(german?.localizedString(forKey: "Search", value: nil, table: nil), "Suche")
        XCTAssertEqual(german?.localizedString(forKey: "Trash", value: nil, table: nil), "Papierkorb")
        XCTAssertEqual(german?.localizedString(forKey: "Share Link", value: nil, table: nil), "Link teilen")
    }

    func testRestoreConflictShowsServerMessage() async {
        restoreResponse = .json(409, #"{"statusCode":409,"message":"target busy","code":"conflict"}"#)
        let model = makeModel()
        await model.load()
        await model.restore(model.entries[0])
        XCTAssertEqual(model.notice, "target busy")
        XCTAssertTrue(signals.keys.isEmpty)
    }

    func testDeleteForeverAndReload() async {
        let model = makeModel()
        await model.load()
        entries = [AppFixtures.trashEntry("b.txt")]
        await model.deleteForever(model.entries[0])
        XCTAssertTrue(requests.contains { $0.method == "DELETE" && $0.path == "/api/trash/t-a.txt" })
        XCTAssertEqual(model.entries.map(\.name), ["b.txt"])
        XCTAssertNil(model.notice)
    }

    func testEmpty() async {
        let model = makeModel()
        await model.load()
        entries = []
        await model.empty()
        XCTAssertTrue(requests.contains { $0.method == "DELETE" && $0.path == "/api/trash" })
        XCTAssertTrue(model.entries.isEmpty)
    }
    /// The server empties only the personal space: „Empty Trash“ is offered for personal entries
    /// only (like the web), and its confirmation says so.
    func testEmptyOnlyCoversMyFiles() async {
        var team = AppFixtures.trashEntry("t.txt")
        team.spaceId = "11111111-2222-4333-8444-555555555555"
        var mine = AppFixtures.trashEntry("m.txt")
        mine.spaceId = "personal"
        entries = [team]
        let model = makeModel()
        XCTAssertFalse(model.canEmpty)
        await model.load()
        XCTAssertFalse(model.canEmpty)
        XCTAssertTrue(model.personalEntries.isEmpty)
        entries = [team, mine, AppFixtures.trashEntry("old-server.txt")]
        await model.load()
        XCTAssertTrue(model.canEmpty)
        XCTAssertEqual(model.personalEntries.map(\.name), ["m.txt", "old-server.txt"])

        let path = Bundle.main.path(forResource: "de", ofType: "lproj")
        let german = path.flatMap(Bundle.init(path:))
        let key = TrashModel.emptyMessageKey
        XCTAssertEqual(german?.localizedString(forKey: key, value: nil, table: nil),
                       "Alle aus „Meine Dateien“ gelöschten Objekte werden endgültig gelöscht. Gelöschte Objekte anderer Bereiche bleiben im Papierkorb. Das kann nicht rückgängig gemacht werden.")
    }
}
