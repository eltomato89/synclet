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

    static let teamID = "6f1c0d2e-0000-4000-8000-000000000001"
    static let team = SyncSpace(id: teamID, kind: .shared, name: "Marketing", rootId: "r_\(teamID)", canWrite: true)
    var twoSpaces: SpaceLayout { SpaceLayout(spaces: [Fixtures.personal, Self.team]) }

    /// Two spaces drain two feeds (`?space=`), each from its own cursor; both land in the anchor.
    func testTwoSpacesDrainTwoFeedsWithSeparateCursors() async {
        let teamRoot = Self.team.rootId
        MockURLProtocol.reset { request in
            guard request.path == "/api/sync/v1/changes" else { return .empty(500) }
            switch (request.query["space"], request.query["cursor"]) {
            case (nil, "10"):
                return .json(200, #"{"changes":[{"op":"delete","id":"f_a"}],"cursor":"11","hasMore":false}"#)
            case (Self.teamID, "50"):
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_t", parentId: teamRoot))},{"op":"delete","id":"f_b"}],"cursor":"60","hasMore":true}"#)
            default:
                return .empty(500)
            }
        }
        let log = CursorLog()
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { [twoSpaces] in twoSpaces }, cursorSink: log.record)
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updated.map(\.itemIdentifier.rawValue), ["f_t"])
        XCTAssertEqual(observer.updated.map(\.parentItemIdentifier.rawValue), ["space:\(Self.teamID)"])
        XCTAssertEqual(observer.deleted.map(\.rawValue), ["f_a", "f_b"])
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "11", Self.teamID: "60"])
        XCTAssertEqual(observer.moreComing, true)
        XCTAssertEqual(log.all, ["personal": "11", Self.teamID: "60"])
        XCTAssertEqual(MockURLProtocol.requests.count, 2)
    }

    /// A server without spaces answers `?space=` with 400/404: the personal feed keeps working
    /// and the other space keeps its cursor (or stays out of the anchor) for a later round.
    func testOldServerWithoutSpaceSupportKeepsThePersonalFeed() async {
        for status in [400, 404] {
            MockURLProtocol.reset { request in
                if request.query["space"] != nil {
                    return status == 400 ? .error(400, "invalid_request") : .error(404, "not_found")
                }
                return request.path.hasSuffix("/cursor")
                    ? .json(200, #"{"cursor":"5"}"#)
                    : .json(200, #"{"changes":[{"op":"delete","id":"f_a"}],"cursor":"11","hasMore":false}"#)
            }
            let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: twoSpaces)

            let observer = MockChangeObserver(expectation(description: "changes \(status)"))
            enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
            await fulfillment(of: [observer.finished], timeout: 5)
            XCTAssertNil(observer.error, "\(status)")
            XCTAssertEqual(observer.deleted.map(\.rawValue), ["f_a"])
            XCTAssertEqual(anchorMap(observer.anchor), ["personal": "11", Self.teamID: "50"])
            XCTAssertEqual(observer.moreComing, false)

            // A space without a cursor yet: its `GET /cursor?space=` fails too ⇒ left out.
            let fresh = MockChangeObserver(expectation(description: "fresh \(status)"))
            enumerator.enumerateChanges(for: fresh, from: SyncAnchorCodec.encode(["personal": "10"]))
            await fulfillment(of: [fresh.finished], timeout: 5)
            XCTAssertNil(fresh.error)
            XCTAssertEqual(anchorMap(fresh.anchor), ["personal": "11"])

            let anchorDone = expectation(description: "anchor \(status)")
            let anchorBox = AnchorBox()
            enumerator.currentSyncAnchor { anchorBox.value = $0; anchorDone.fulfill() }
            await fulfillment(of: [anchorDone], timeout: 5)
            XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "5"])
        }
    }

    /// A cross-space move: the old space reports `delete`, the new one `upsert` (same id).
    /// The item must stay – in the same round and when the delete comes a round later.
    func testCrossSpaceMoveIsNotReportedAsDelete() async {
        let teamRoot = Self.team.rootId
        let round = Counter()
        MockURLProtocol.reset { request in
            let teamFeed = request.query["space"] == Self.teamID
            switch (round.current, teamFeed) {
            case (1, false):   // same round: delete in personal, upsert in team
                return .json(200, #"{"changes":[{"op":"delete","id":"d_1"},{"op":"delete","id":"f_gone"}],"cursor":"11","hasMore":false}"#)
            case (1, true):
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_1", parentId: teamRoot, name: "Fotos"))}],"cursor":"51","hasMore":false}"#)
            case (2, true):    // next move: upsert arrives first …
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_2", parentId: teamRoot, name: "Akten"))}],"cursor":"52","hasMore":false}"#)
            case (3, false):   // … the old space's delete one round later
                return .json(200, #"{"changes":[{"op":"delete","id":"d_2"}],"cursor":"12","hasMore":false}"#)
            case (4, true):    // a real delete in the space that holds it
                return .json(200, #"{"changes":[{"op":"delete","id":"d_2"}],"cursor":"53","hasMore":false}"#)
            default:
                return .json(200, #"{"changes":[],"cursor":"\#(teamFeed ? "5x" : "1x")","hasMore":false}"#)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: twoSpaces)
        var results: [(updated: [String], deleted: [String])] = []
        for _ in 1...4 {
            _ = round.next()
            let observer = MockChangeObserver(expectation(description: "round"))
            enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
            await fulfillment(of: [observer.finished], timeout: 5)
            XCTAssertNil(observer.error)
            results.append((observer.updated.map(\.itemIdentifier.rawValue), observer.deleted.map(\.rawValue)))
        }
        XCTAssertEqual(results[0].updated, ["d_1"])
        XCTAssertEqual(results[0].deleted, ["f_gone"])
        XCTAssertEqual(results[1].updated, ["d_2"])
        XCTAssertEqual(results[2].deleted, [], "the moved item stays")
        XCTAssertEqual(results[3].deleted, ["d_2"])
    }

    /// `space_unavailable` (503) of one space does not stop the others.
    func testUnavailableSpaceKeepsItsCursor() async {
        MockURLProtocol.reset { request in
            if request.query["space"] != nil { return .error(503, "space_unavailable") }
            return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: twoSpaces)
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "11", Self.teamID: "50"])
    }

    /// Errors of the personal feed still fail the batch (as before).
    func testPersonalFeedErrorStillFails() async {
        MockURLProtocol.reset { _ in .error(503, "unavailable") }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: twoSpaces)
        let observer = MockChangeObserver(expectation(description: "error"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNotNil(observer.error)
    }

    /// A space that left the layout: the working set reports its folder deleted (the system
    /// removes everything below it) and drops its cursor; a single container does not.
    func testLostSpaceIsDeletedFromTheWorkingSet() async {
        MockURLProtocol.reset { request in
            request.query["space"] == nil
                ? .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
                : .empty(500)
        }
        let workingSet = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: layout)
        let observer = MockChangeObserver(expectation(description: "working set"))
        workingSet.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
        await fulfillment(of: [observer.finished], timeout: 5)
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.deleted.map(\.rawValue), ["space:\(Self.teamID)"])
        XCTAssertEqual(anchorMap(observer.anchor), ["personal": "11"])
        XCTAssertEqual(MockURLProtocol.requests.count, 1)

        let container = FileProviderEnumerator(containerIdentifier: personal, client: Fixtures.client(), layout: layout)
        let other = MockChangeObserver(expectation(description: "container"))
        container.enumerateChanges(for: other, from: SyncAnchorCodec.encode(["personal": "10", Self.teamID: "50"]))
        await fulfillment(of: [other.finished], timeout: 5)
        XCTAssertEqual(other.deleted, [])
        XCTAssertEqual(anchorMap(other.anchor), ["personal": "11"])
    }

    /// The cursor before the first page applies only to the enumerated folder's space; the
    /// other spaces read their own `GET /cursor?space=`.
    func testFirstPageCursorOnlyForTheEnumeratedSpace() async {
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/\(Self.team.rootId)/children":
                return .json(200, #"{"items":[],"nextPageToken":null,"cursor":"70"}"#)
            case "/api/sync/v1/cursor":
                return .json(200, request.query["space"] == nil ? #"{"cursor":"12"}"# : #"{"cursor":"99"}"#)
            default:
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: SpaceLayout.identifier(for: Self.team),
                                                client: Fixtures.client(), layout: twoSpaces)
        let page = MockEnumerationObserver(expectation(description: "page"))
        enumerator.enumerateItems(for: page, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [page.finished], timeout: 5)

        let done = expectation(description: "anchor")
        let anchorBox = AnchorBox()
        enumerator.currentSyncAnchor { anchorBox.value = $0; done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "12", Self.teamID: "70"])
        let cursorRequests = MockURLProtocol.requests.filter { $0.path == "/api/sync/v1/cursor" }
        XCTAssertEqual(cursorRequests.map { $0.query["space"] }, [nil])
    }

    /// A folder below a space root: its space comes from the items' `spaceId`.
    func testFirstPageCursorOfASubfolderUsesTheItemsSpace() async {
        let teamRoot = Self.team.rootId
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/d_7/children":
                var item = Fixtures.itemJSON(id: "f_1", parentId: "d_7")
                item.removeLast()
                item += #","spaceId":"\#(Self.teamID)"}"#
                return .json(200, #"{"items":[\#(item)],"nextPageToken":null,"cursor":"70"}"#)
            case "/api/sync/v1/cursor":
                return .json(200, request.query["space"] == nil ? #"{"cursor":"12"}"# : #"{"cursor":"99"}"#)
            default:
                _ = teamRoot
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("d_7"),
                                                client: Fixtures.client(), layout: twoSpaces)
        let page = MockEnumerationObserver(expectation(description: "page"))
        enumerator.enumerateItems(for: page, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [page.finished], timeout: 5)
        let done = expectation(description: "anchor")
        let anchorBox = AnchorBox()
        enumerator.currentSyncAnchor { anchorBox.value = $0; done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "12", Self.teamID: "70"])
    }

    func testWorkingSetAnchorReadsEachSpaceCursor() async {
        MockURLProtocol.reset { request in
            .json(200, request.query["space"] == Self.teamID ? #"{"cursor":"99"}"# : #"{"cursor":"12"}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(), layout: twoSpaces)
        let done = expectation(description: "anchor")
        let anchorBox = AnchorBox()
        enumerator.currentSyncAnchor { anchorBox.value = $0; done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(anchorMap(anchorBox.value), ["personal": "12", Self.teamID: "99"])
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
