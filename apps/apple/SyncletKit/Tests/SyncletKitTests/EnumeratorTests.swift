import FileProvider
import XCTest
@testable import SyncletKit

final class MockEnumerationObserver: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
    var items: [NSFileProviderItem] = []
    var nextPage: NSFileProviderPage?
    var error: Error?
    var suggestedPageSize: Int = 0
    let finished: XCTestExpectation

    init(_ finished: XCTestExpectation) { self.finished = finished }

    func didEnumerate(_ updatedItems: [NSFileProviderItem]) { items += updatedItems }
    func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
        self.nextPage = nextPage
        finished.fulfill()
    }
    func finishEnumeratingWithError(_ error: Error) {
        self.error = error
        finished.fulfill()
    }
}

final class MockChangeObserver: NSObject, NSFileProviderChangeObserver, @unchecked Sendable {
    var updated: [NSFileProviderItem] = []
    var deleted: [NSFileProviderItemIdentifier] = []
    var anchor: NSFileProviderSyncAnchor?
    var moreComing: Bool?
    var error: Error?
    var suggestedBatchSize: Int = 0
    let finished: XCTestExpectation

    init(_ finished: XCTestExpectation) { self.finished = finished }

    func didUpdate(_ updatedItems: [NSFileProviderItem]) { updated += updatedItems }
    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) { deleted += deletedItemIdentifiers }
    func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) {
        self.anchor = anchor
        self.moreComing = moreComing
        finished.fulfill()
    }
    func finishEnumeratingWithError(_ error: Error) {
        self.error = error
        finished.fulfill()
    }
}

final class AnchorBox: @unchecked Sendable {
    var value: NSFileProviderSyncAnchor?
}

final class CursorLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: String] = [:]
    var all: [String: String] { lock.withLock { entries } }
    func record(_ space: String, _ cursor: String) { lock.withLock { entries[space] = cursor } }
}

final class EnumeratorTests: XCTestCase {
    let layout = Fixtures.layout
    let personal = NSFileProviderItemIdentifier("space:personal")

    private func anchorMap(_ anchor: NSFileProviderSyncAnchor?) -> [String: String]? {
        anchor.flatMap(SyncAnchorCodec.decode)
    }

    func testSpaceFolderEnumeratesRootChildrenPaged() async throws {
        MockURLProtocol.reset { request in
            if request.query["pageToken"] == nil {
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_1", name: "A"))],"nextPageToken":"p2","cursor":"100"}"#)
            }
            return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_2"))],"nextPageToken":null,"cursor":"101"}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: personal, client: Fixtures.client(), layout: layout)

        let first = MockEnumerationObserver(expectation(description: "page 1"))
        first.suggestedPageSize = 5000
        enumerator.enumerateItems(for: first, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [first.finished], timeout: 5)
        XCTAssertNil(first.error)
        XCTAssertEqual(first.items.map(\.itemIdentifier.rawValue), ["d_1"])
        XCTAssertEqual(first.items.first?.parentItemIdentifier, personal)
        let page = try XCTUnwrap(first.nextPage)
        XCTAssertEqual(String(data: page.rawValue, encoding: .utf8), "p2")
        XCTAssertEqual(MockURLProtocol.requests.first?.path, "/api/sync/v1/items/root/children")
        XCTAssertEqual(MockURLProtocol.requests.first?.query["limit"], "1000") // clamped to the maximum

        let second = MockEnumerationObserver(expectation(description: "page 2"))
        enumerator.enumerateItems(for: second, startingAt: page)
        await fulfillment(of: [second.finished], timeout: 5)
        XCTAssertEqual(second.items.map(\.itemIdentifier.rawValue), ["f_2"])
        XCTAssertEqual(second.items.first?.parentItemIdentifier, personal)
        XCTAssertNil(second.nextPage)
        XCTAssertEqual(MockURLProtocol.requests.last?.query["pageToken"], "p2")
        XCTAssertEqual(MockURLProtocol.requests.last?.query["limit"], "500")

        // Anchor = cursor before the first page, per space, without another request.
        let requestsBefore = MockURLProtocol.requests.count
        let anchorExpectation = expectation(description: "anchor")
        let anchorBox = AnchorBox()
        enumerator.currentSyncAnchor { anchor in
            anchorBox.value = anchor
            anchorExpectation.fulfill()
        }
        await fulfillment(of: [anchorExpectation], timeout: 5)
        XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "100"])
        XCTAssertEqual(MockURLProtocol.requests.count, requestsBefore)
    }

    func testWorkingSetAnchorUsesCursorEndpoint() async {
        MockURLProtocol.reset { _ in .json(200, #"{"cursor":"555"}"#) }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let done = expectation(description: "anchor")
        let anchorBox = AnchorBox()
        enumerator.currentSyncAnchor { anchor in
            anchorBox.value = anchor
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "555"])
        XCTAssertEqual(MockURLProtocol.requests.first?.path, "/api/sync/v1/cursor")
    }

    func testWorkingSetChangesPerSpaceWithMoreComing() async {
        MockURLProtocol.reset { _ in
            .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_1", parentId: "root"))},{"op":"delete","id":"f_2"},{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_3", parentId: "d_9"))},{"op":"upsert","item":\#(Fixtures.itemJSON(id: "root", parentId: nil, type: "folder", name: "jens", etag: "t0"))}],"cursor":"20","hasMore":true}"#)
        }
        let log = CursorLog()
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { [layout] in layout }, cursorSink: log.record)
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        // The server root is never reported as an item; its children land in the space folder.
        XCTAssertEqual(observer.updated.map(\.itemIdentifier.rawValue), ["f_1", "f_3"])
        XCTAssertEqual(observer.updated.map(\.parentItemIdentifier.rawValue), ["space:personal", "d_9"])
        XCTAssertEqual(observer.deleted.map(\.rawValue), ["f_2"])
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "20"])
        XCTAssertEqual(observer.moreComing, true)
        XCTAssertEqual(MockURLProtocol.requests.first?.query["cursor"], "10")
        XCTAssertEqual(log.all, ["personal": "20"])
    }

    func testTwoFeedSpacesKeepTheirOwnCursors() async {
        // Two feed spaces (a hypothetical second personal-kind space) pull from their own cursors.
        let second = SyncSpace(id: "p2", kind: .personal, name: "P2", rootId: "d_p2", canWrite: true)
        let layout = SpaceLayout(spaces: [Fixtures.personal, second])
        MockURLProtocol.reset { request in
            switch request.query["cursor"] {
            case "10": return .json(200, #"{"changes":[{"op":"delete","id":"f_a"}],"cursor":"11","hasMore":false}"#)
            case "50": return .json(200, #"{"changes":[{"op":"delete","id":"f_b"}],"cursor":"60","hasMore":true}"#)
            default: return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", "p2": "50", "gone": "1"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.deleted.map(\.rawValue), ["f_a", "f_b"])
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "11", "p2": "60"])
        XCTAssertEqual(observer.moreComing, true)
        XCTAssertEqual(Set(MockURLProtocol.requests.compactMap { $0.query["cursor"] }), ["10", "50"])
    }

    func testFinishedTasksAreForgotten() async throws {
        MockURLProtocol.reset { _ in .json(200, #"{"changes":[],"cursor":"2","hasMore":false}"#) }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        for _ in 0..<5 {
            let observer = MockChangeObserver(expectation(description: "changes"))
            enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "1"]))
            await fulfillment(of: [observer.finished], timeout: 5)
        }
        for _ in 0..<50 where enumerator.runningTaskCount > 0 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(enumerator.runningTaskCount, 0)
    }

    func testSpaceMissingFromAnchorStartsAtHead() async {
        MockURLProtocol.reset { _ in .json(200, #"{"cursor":"77"}"#) }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode([:]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "77"])
        XCTAssertEqual(observer.moreComing, false)
    }

    func testContainerChangesOnlyContainDirectChildren() {
        let changes: [SyncChange] = [
            .upsert(Fixtures.item(id: "f_1", parentId: "d_9")),
            .upsert(Fixtures.item(id: "f_2", parentId: "root")),
            .delete(id: "f_3"),
            .delete(id: "root"),
        ]
        let (updated, deleted) = FileProviderEnumerator.split(changes, onlyChildrenOf: "d_9", layout: layout)
        XCTAssertEqual(updated.map(\.id), ["f_1"])
        XCTAssertEqual(deleted.map(\.rawValue), ["f_3"])

        let (top, _) = FileProviderEnumerator.split(changes, onlyChildrenOf: "root", layout: layout)
        XCTAssertEqual(top.map(\.id), ["f_2"])
    }

    func testExpiredCursorMapsToSyncAnchorExpired() async {
        MockURLProtocol.reset { _ in .error(410, "cursor_expired") }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockChangeObserver(expectation(description: "error"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "1"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        let error = observer.error as NSError?
        XCTAssertEqual(error?.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(error?.code, NSFileProviderError.Code.syncAnchorExpired.rawValue)
    }

    func testUndecodableAnchorMapsToSyncAnchorExpired() async {
        MockURLProtocol.reset { _ in XCTFail("no request expected"); return .empty() }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockChangeObserver(expectation(description: "error"))
        enumerator.enumerateChanges(for: observer, from: NSFileProviderSyncAnchor(Data("42".utf8)))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertEqual((observer.error as NSError?)?.code, NSFileProviderError.Code.syncAnchorExpired.rawValue)
    }

    func testUnauthorizedEnumerationMapsToNotAuthenticated() async {
        MockURLProtocol.reset { _ in .error(401, "device_revoked") }
        let enumerator = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("d_1"),
                                                client: Fixtures.client(), layout: layout)
        let observer = MockEnumerationObserver(expectation(description: "error"))
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertEqual((observer.error as NSError?)?.code, NSFileProviderError.Code.notAuthenticated.rawValue)
        XCTAssertEqual(MockURLProtocol.requests.first?.path, "/api/sync/v1/items/d_1/children")
    }

    func testUnknownSpaceContainerIsNoSuchItem() async {
        MockURLProtocol.reset { _ in XCTFail("no request expected"); return .empty() }
        let enumerator = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("space:gone"),
                                                client: Fixtures.client(), layout: layout)
        let observer = MockEnumerationObserver(expectation(description: "error"))
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertEqual((observer.error as NSError?)?.code, NSFileProviderError.Code.noSuchItem.rawValue)
    }

    func testWorkingSetItemEnumerationIsEmpty() async {
        MockURLProtocol.reset { _ in XCTFail("no request expected"); return .empty() }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockEnumerationObserver(expectation(description: "empty"))
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertTrue(observer.items.isEmpty)
        XCTAssertNil(observer.nextPage)
    }

    // MARK: Root container

    func testRootContainerListsSpaces() async {
        MockURLProtocol.reset { _ in XCTFail("no request expected"); return .empty() }
        let team = SyncSpace(id: "s_t", kind: .unknown("team"), name: "Team", rootId: "d_t", canWrite: false)
        let enumerator = TopLevelEnumerator(layout: SpaceLayout(spaces: [Fixtures.personal, team]))
        let observer = MockEnumerationObserver(expectation(description: "items"))
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertEqual(observer.items.map(\.itemIdentifier.rawValue), ["space:personal", "space:s_t"])
        XCTAssertEqual(observer.items.last?.filename, "Team")
        XCTAssertNil(observer.nextPage)
    }

    func testRootContainerChangesReportVanishedSpaces() async {
        let spaces = SpacesBox([Fixtures.personal, SyncSpace(id: "s_t", kind: .shared, name: "Team", rootId: "d_t", canWrite: true)])
        let enumerator = TopLevelEnumerator(layout: { SpaceLayout(spaces: spaces.value) })
        let anchorBox = AnchorBox()
        let anchorDone = expectation(description: "anchor")
        enumerator.currentSyncAnchor { anchorBox.value = $0; anchorDone.fulfill() }
        await fulfillment(of: [anchorDone], timeout: 5)

        spaces.value = [Fixtures.personal]
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: anchorBox.value!)
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertEqual(observer.updated.map(\.itemIdentifier.rawValue), ["space:personal"])
        XCTAssertEqual(observer.deleted.map(\.rawValue), ["space:s_t"])
        XCTAssertEqual(observer.moreComing, false)
    }
}

final class SpacesBox: @unchecked Sendable {
    var value: [SyncSpace]
    init(_ value: [SyncSpace]) { self.value = value }
}
