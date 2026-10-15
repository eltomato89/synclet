import FileProvider
import XCTest
@testable import SyncletKit

/// Records the Darwin notifications a ``PinStore`` would post.
final class PostLog: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    var all: [String] { lock.withLock { names } }
    func record(_ name: String) { lock.withLock { names.append(name) } }
}

final class PinStoreTests: XCTestCase {
    var dir: URL!

    override func setUp() { dir = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func store(_ key16: String = "0123456789abcdef", log: PostLog = PostLog()) -> PinStore {
        PinStore(stateDir: dir.appending(path: "accounts/\(key16)", directoryHint: .isDirectory), post: { log.record($0) })
    }

    func testEmptyByDefault() {
        XCTAssertEqual(store().pins(space: "personal"), PinSet())
        XCTAssertTrue(store().pins(space: "personal").isEmpty)
    }

    func testRoundTripAcrossInstances() throws {
        let log = PostLog()
        let a = store(log: log)
        try a.setFolder("d_fotos", pinned: true, space: "personal")
        try a.setFolder("d_docs", pinned: true, space: "personal")
        try a.setWholeSpace(true, space: "team")
        try a.setFolder("d_docs", pinned: false, space: "personal")

        let b = store()
        XCTAssertEqual(b.pins(space: "personal"), PinSet(wholeSpace: false, folders: ["d_fotos"]))
        XCTAssertEqual(b.pins(space: "team"), PinSet(wholeSpace: true, folders: []))
        // The file lives in the space state dir, written atomically (no temp leftovers).
        let spaceDir = dir.appending(path: "accounts/0123456789abcdef/spaces/personal")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: spaceDir.path), ["pins.json"])
        XCTAssertEqual(log.all, Array(repeating: "tech.jensk.synclet.pinsChanged.0123456789abcdef", count: 4))
    }

    func testNoNotificationWithoutChange() throws {
        let log = PostLog()
        let s = store(log: log)
        try s.setFolder("d_1", pinned: false, space: "personal")
        try s.setWholeSpace(false, space: "personal")
        try s.setFolder("d_1", pinned: true, space: "personal")
        try s.setFolder("d_1", pinned: true, space: "personal")
        XCTAssertEqual(log.all.count, 1)
    }

    func testPruneDropsVanishedFolders() throws {
        let log = PostLog()
        let s = store(log: log)
        try s.setFolder("d_1", pinned: true, space: "personal")
        try s.setFolder("d_2", pinned: true, space: "personal")
        let removed = try s.prune(existingFirstLevel: ["d_2", "d_3"], space: "personal")
        XCTAssertEqual(removed, ["d_1"])
        XCTAssertEqual(s.pins(space: "personal").folders, ["d_2"])
        XCTAssertEqual(try s.prune(existingFirstLevel: ["d_2"], space: "personal"), [])
        XCTAssertEqual(log.all.count, 3)   // two pins + one effective prune
    }

    func testForgetRemovesADeletedFolderFromEverySpace() throws {
        let s = store()
        try s.setFolder("d_1", pinned: true, space: "personal")
        try s.setFolder("d_9", pinned: true, space: "personal")
        XCTAssertTrue(try s.forget(folder: "d_1", spaces: ["personal", "team"]))
        XCTAssertFalse(try s.forget(folder: "d_1", spaces: ["personal", "team"]))
        XCTAssertEqual(s.pins(space: "personal").folders, ["d_9"])
    }

    func testAccountsAndSpacesAreIndependent() throws {
        let a = store("aaaaaaaaaaaaaaaa")
        let b = store("bbbbbbbbbbbbbbbb")
        // Same folder id/name in two accounts and two spaces.
        try a.setFolder("d_fotos", pinned: true, space: "personal")
        XCTAssertTrue(b.pins(space: "personal").isEmpty)
        XCTAssertTrue(a.pins(space: "team").isEmpty)
        try b.setWholeSpace(true, space: "personal")
        XCTAssertFalse(a.pins(space: "personal").wholeSpace)
        XCTAssertEqual(a.key16, "aaaaaaaaaaaaaaaa")
    }

    func testUnreadableFileCountsAsEmpty() throws {
        let s = store()
        let file = dir.appending(path: "accounts/0123456789abcdef/spaces/personal/pins.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("nope".utf8).write(to: file)
        XCTAssertEqual(s.pins(space: "personal"), PinSet())
    }

    func testAppliedPinsAreSeparateAndSilent() throws {
        let log = PostLog()
        let s = store(log: log)
        XCTAssertEqual(s.appliedPins(space: "personal"), PinSet())
        try s.setAppliedPins(PinSet(wholeSpace: false, folders: ["d_1"]), space: "personal")
        XCTAssertEqual(s.appliedPins(space: "personal").folders, ["d_1"])
        XCTAssertTrue(s.pins(space: "personal").isEmpty)
        XCTAssertTrue(log.all.isEmpty)
    }

    func testNotificationNames() {
        XCTAssertEqual(PinStore.notificationName(key16: "k"), "tech.jensk.synclet.pinsChanged.k")
        XCTAssertEqual(PinStore.pinnedContentNotificationName(key16: "k"), "tech.jensk.synclet.pinnedContentChanged.k")
    }
}

final class PinPolicyTests: XCTestCase {
    private let keep = NSFileProviderContentPolicy.downloadEagerlyAndKeepDownloaded

    func testTable() {
        let file = Fixtures.item(id: "f_1", parentId: "d_sub")
        let folder = Fixtures.item(id: "d_fotos", parentId: "root", type: "folder", name: "Fotos")
        let renamed = Fixtures.item(id: "d_fotos", parentId: "root", type: "folder", name: "Bilder 2026")
        let pinned = PinSet(wholeSpace: false, folders: ["d_fotos"])
        let cases: [(String, SyncItem, String?, PinSet, NSFileProviderContentPolicy)] = [
            ("whole space", file, "d_other", PinSet(wholeSpace: true), keep),
            ("whole space, unknown ancestor", file, nil, PinSet(wholeSpace: true), keep),
            ("pinned folder itself", folder, "d_fotos", pinned, keep),
            ("nested descendant", file, "d_fotos", pinned, keep),
            ("other folder", file, "d_docs", pinned, .inherited),
            ("unknown ancestor", file, nil, pinned, .inherited),
            ("renamed folder keeps the id", renamed, "d_fotos", pinned, keep),
            ("nothing pinned", file, "d_fotos", PinSet(), .inherited),
        ]
        for (name, item, ancestor, pins, expected) in cases {
            XCTAssertEqual(PinPolicy.contentPolicy(for: item, firstLevelAncestor: ancestor, space: "personal", pins: pins),
                           expected, name)
        }
        XCTAssertEqual(PinPolicy.contentPolicy(forSpace: "personal", pins: PinSet(wholeSpace: true)), keep)
        XCTAssertEqual(PinPolicy.contentPolicy(forSpace: "personal", pins: pinned), .inherited)
    }
}

final class ParentMapTests: XCTestCase {
    let roots: Set<String> = ["root"]

    private func noFetch(_ id: String) async throws -> SyncItem? {
        XCTFail("unexpected fetch of \(id)")
        return nil
    }

    func testDirectChildOfRootIsItsOwnFirstLevel() async throws {
        let map = ParentMap(fileURL: nil)
        let result = try await map.firstLevelAncestor(itemId: "d_fotos", parentId: "root", rootIds: roots, fetch: noFetch)
        XCTAssertEqual(result?.rootId, "root")
        XCTAssertEqual(result?.firstLevel, "d_fotos")
    }

    func testNestedFromRecordedFolders() async throws {
        let map = ParentMap(fileURL: nil)
        map.record([
            Fixtures.item(id: "d_fotos", parentId: "root", type: "folder"),
            Fixtures.item(id: "d_2026", parentId: "d_fotos", type: "folder"),
            Fixtures.item(id: "d_urlaub", parentId: "d_2026", type: "folder"),
            Fixtures.item(id: "f_x", parentId: "d_urlaub"),   // files are not recorded
        ])
        XCTAssertNil(map.parent(of: "f_x"))
        let result = try await map.firstLevelAncestor(itemId: "f_1", parentId: "d_urlaub", rootIds: roots, fetch: noFetch)
        XCTAssertEqual(result?.firstLevel, "d_fotos")
    }

    func testUnknownParentIsFetchedAndCached() async throws {
        let map = ParentMap(fileURL: nil)
        let fetched = PostLog()
        let fetch: @Sendable (String) async throws -> SyncItem? = { id in
            fetched.record(id)
            switch id {
            case "d_b": return Fixtures.item(id: "d_b", parentId: "d_a", type: "folder")
            case "d_a": return Fixtures.item(id: "d_a", parentId: "root", type: "folder")
            default: return nil
            }
        }
        let first = try await map.firstLevelAncestor(itemId: "f_1", parentId: "d_b", rootIds: roots, fetch: fetch)
        XCTAssertEqual(first?.firstLevel, "d_a")
        let second = try await map.firstLevelAncestor(itemId: "f_2", parentId: "d_b", rootIds: roots, fetch: fetch)
        XCTAssertEqual(second?.firstLevel, "d_a")
        XCTAssertEqual(fetched.all, ["d_b", "d_a"])
    }

    func testMissingParentResolvesToNil() async throws {
        let map = ParentMap(fileURL: nil)
        let result = try await map.firstLevelAncestor(itemId: "f_1", parentId: "d_gone", rootIds: roots, fetch: { _ in nil })
        XCTAssertNil(result)
    }

    func testMoveIntoAndOutOfAPinnedFolder() async throws {
        let map = ParentMap(fileURL: nil)
        map.record([
            Fixtures.item(id: "d_fotos", parentId: "root", type: "folder"),
            Fixtures.item(id: "d_docs", parentId: "root", type: "folder"),
            Fixtures.item(id: "d_sub", parentId: "d_docs", type: "folder"),
        ])
        let pins = PinSet(folders: ["d_fotos"])
        func policy() async throws -> NSFileProviderContentPolicy {
            let file = Fixtures.item(id: "f_1", parentId: "d_sub")
            let ancestor = try await map.firstLevelAncestor(itemId: file.id, parentId: file.parentId, rootIds: roots, fetch: noFetch)
            return PinPolicy.contentPolicy(for: file, firstLevelAncestor: ancestor?.firstLevel, space: "personal", pins: pins)
        }
        let before = try await policy()
        XCTAssertEqual(before, .inherited)
        // d_sub moved into the pinned folder (change feed upsert with the new parent).
        map.record([Fixtures.item(id: "d_sub", parentId: "d_fotos", type: "folder")])
        let inside = try await policy()
        XCTAssertEqual(inside, .downloadEagerlyAndKeepDownloaded)
        // … and out again.
        map.record([Fixtures.item(id: "d_sub", parentId: "d_docs", type: "folder")])
        let after = try await policy()
        XCTAssertEqual(after, .inherited)
    }

    func testHopLimitAndCycles() async throws {
        let map = ParentMap(fileURL: nil)
        // A chain deeper than 64 levels never resolves (and never loops forever).
        var items: [SyncItem] = [Fixtures.item(id: "d_0", parentId: "root", type: "folder")]
        for level in 1...70 { items.append(Fixtures.item(id: "d_\(level)", parentId: "d_\(level - 1)", type: "folder")) }
        map.record(items)
        let deep = try await map.firstLevelAncestor(itemId: "f", parentId: "d_70", rootIds: roots, fetch: noFetch)
        XCTAssertNil(deep)
        let shallow = try await map.firstLevelAncestor(itemId: "f", parentId: "d_30", rootIds: roots, fetch: noFetch)
        XCTAssertEqual(shallow?.firstLevel, "d_0")
        map.record([Fixtures.item(id: "d_x", parentId: "d_y", type: "folder"), Fixtures.item(id: "d_y", parentId: "d_x", type: "folder")])
        let cycle = try await map.firstLevelAncestor(itemId: "f", parentId: "d_x", rootIds: roots, fetch: noFetch)
        XCTAssertNil(cycle)
    }

    func testPersistsAndForgetsDeletedFolders() throws {
        let dir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: "parent-map.json")
        let map = ParentMap(fileURL: url)
        map.record([Fixtures.item(id: "d_a", parentId: "root", type: "folder"),
                    Fixtures.item(id: "d_b", parentId: "d_a", type: "folder")])
        map.remove(["d_a"])
        let reloaded = ParentMap(fileURL: url)
        XCTAssertNil(reloaded.parent(of: "d_a"))
        XCTAssertEqual(reloaded.parent(of: "d_b"), "d_a")
        XCTAssertTrue(ParentMap.shared(at: url) === ParentMap.shared(at: url))
    }
}

/// Enumerator and extension behaviour with pins (Strategy B: explicit policy on every item).
final class PinnedEnumerationTests: XCTestCase {
    var dir: URL!
    let keep = NSFileProviderContentPolicy.downloadEagerlyAndKeepDownloaded
    let personal = NSFileProviderItemIdentifier("space:personal")

    override func setUp() { dir = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func pinning(log: PostLog = PostLog(), notified: Counter? = nil) -> PinningContext {
        PinningContext(store: PinStore(stateDir: dir.appending(path: "accounts/0123456789abcdef"), post: { log.record($0) }),
                       parentMap: ParentMap(fileURL: dir.appending(path: "parent-map.json")),
                       notifyPinnedContent: { _ = notified?.next() })
    }

    private func policies(_ items: [NSFileProviderItem]) -> [String: NSFileProviderContentPolicy] {
        Dictionary(items.map { ($0.itemIdentifier.rawValue, $0.contentPolicy ?? .inherited) }, uniquingKeysWith: { $1 })
    }

    private func changes(_ enumerator: FileProviderEnumerator, from cursor: String = "10") async -> MockChangeObserver {
        let observer = MockChangeObserver(expectation(description: "changes"))
        enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(["personal": cursor]))
        await fulfillment(of: [observer.finished], timeout: 5)
        return observer
    }

    func testContainerItemsGetThePolicyOfTheirFirstLevelFolder() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/root/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_fotos", name: "Fotos")),\#(Fixtures.folderJSON(id: "d_docs", name: "Docs"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_fotos/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_2026", parentId: "d_fotos", name: "2026")),\#(Fixtures.itemJSON(id: "f_1", parentId: "d_fotos"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_2026/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_2", parentId: "d_2026"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        var result: [String: NSFileProviderContentPolicy] = [:]
        for container in [personal, NSFileProviderItemIdentifier("d_fotos"), NSFileProviderItemIdentifier("d_2026")] {
            let enumerator = FileProviderEnumerator(containerIdentifier: container, client: Fixtures.client(),
                                                    layout: { Fixtures.layout }, pinning: pin)
            let observer = MockEnumerationObserver(expectation(description: "items"))
            enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
            await fulfillment(of: [observer.finished], timeout: 5)
            XCTAssertNil(observer.error)
            result.merge(policies(observer.items)) { $1 }
        }
        XCTAssertEqual(result, ["d_fotos": keep, "d_docs": .inherited, "d_2026": keep, "f_1": keep, "f_2": keep])
        XCTAssertEqual(pin.parentMap.parent(of: "d_2026"), "d_fotos")
    }

    func testNewRemoteFileDeepInsideAPinnedFolderIsKeptAndAnnounced() async throws {
        let notified = Counter()
        let pin = pinning(notified: notified)
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_a", parentId: "d_fotos", name: "a"))},{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_b", parentId: "d_a", name: "b"))},{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_new", parentId: "d_b"))},{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_out", parentId: "root"))}],"cursor":"11","hasMore":false}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertNil(observer.error)
        XCTAssertEqual(policies(observer.updated), ["d_a": keep, "d_b": keep, "f_new": keep, "f_out": .inherited])
        XCTAssertEqual(notified.next(), 2)   // announced once
    }

    func testDeletedPinnedFolderDropsThePin() async throws {
        let log = PostLog()
        let pin = pinning(log: log)
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        MockURLProtocol.reset { _ in
            .json(200, #"{"changes":[{"op":"delete","id":"d_fotos"}],"cursor":"11","hasMore":false}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertEqual(observer.deleted, [NSFileProviderItemIdentifier("d_fotos")])
        XCTAssertTrue(pin.store.pins(space: "personal").isEmpty)
        XCTAssertEqual(log.all.count, 2)   // pin + drop
    }

    func testPinChangeReReportsTheFolderSubtreeOnce() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/d_fotos":
                return .json(200, Fixtures.folderJSON(id: "d_fotos", name: "Fotos"))
            case "/api/sync/v1/items/d_fotos/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_2026", parentId: "d_fotos", name: "2026")),\#(Fixtures.itemJSON(id: "f_1", parentId: "d_fotos"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_2026/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_2", parentId: "d_2026"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let first = await changes(enumerator)
        XCTAssertNil(first.error)
        XCTAssertEqual(policies(first.updated), ["d_fotos": keep, "d_2026": keep, "f_1": keep, "f_2": keep])
        XCTAssertEqual(pin.store.appliedPins(space: "personal"), pin.store.pins(space: "personal"))

        // Applied ⇒ the next round re-reports nothing.
        let second = await changes(enumerator, from: "11")
        XCTAssertTrue(second.updated.isEmpty)

        // Unpin ⇒ the subtree goes back to inherited (no eviction is requested).
        try pin.store.setFolder("d_fotos", pinned: false, space: "personal")
        let third = await changes(enumerator, from: "11")
        XCTAssertEqual(policies(third.updated), ["d_fotos": .inherited, "d_2026": .inherited, "f_1": .inherited, "f_2": .inherited])
        XCTAssertTrue(pin.store.appliedPins(space: "personal").isEmpty)
    }

    func testWholeSpacePinReReportsTheSpaceFolderAndItsTree() async throws {
        let pin = pinning()
        try pin.store.setWholeSpace(true, space: "personal")
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/root/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_a", name: "A")),\#(Fixtures.itemJSON(id: "f_1"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_a/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_2", parentId: "d_a"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertEqual(policies(observer.updated), ["space:personal": keep, "d_a": keep, "f_1": keep, "f_2": keep])
    }

    func testFolderMovedIntoAPinnedFolderReReportsItsSubtree() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_docs", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_sub", parentId: "d_docs", type: "folder")])
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_sub", parentId: "d_fotos", name: "sub"))}],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/d_sub/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_old", parentId: "d_sub"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertEqual(policies(observer.updated), ["d_sub": keep, "f_old": keep])
    }

    func testWithoutPinsNothingIsResolved() async throws {
        let pin = pinning()
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                // The unknown parent d_x would need a GET – but nothing is pinned.
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_1", parentId: "d_x"))}],"cursor":"11","hasMore":false}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertEqual(policies(observer.updated), ["f_1": .inherited])
    }

    func testTopLevelSpaceFolderCarriesTheWholeSpacePolicy() {
        let observer = MockEnumerationObserver(expectation(description: "top"))
        TopLevelEnumerator(layout: { Fixtures.layout }, pins: { ["personal": PinSet(wholeSpace: true)] })
            .enumerateItems(for: observer, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        wait(for: [observer.finished], timeout: 1)
        XCTAssertEqual(policies(observer.items), ["space:personal": keep])
    }

    func testExtensionItemLookupUsesThePins() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        MockURLProtocol.reset { request in
            .json(200, Fixtures.itemJSON(id: "f_1", parentId: "d_fotos"))
        }
        let context = SyncletReplicatedExtension.Context(client: Fixtures.client(), deviceName: "Mac", layout: Fixtures.layout,
                                                         pinning: pin)
        let ext = SyncletReplicatedExtension(domain: NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("0123456789abcdef"),
                                                                          displayName: "x"),
                                             temporaryDirectory: dir) { context }
        let item = try await ext.item(for: NSFileProviderItemIdentifier("f_1"))
        XCTAssertEqual(item.contentPolicy, keep)
        try pin.store.setWholeSpace(true, space: "personal")
        let space = try await ext.item(for: personal)
        XCTAssertEqual(space.contentPolicy, keep)
    }
}
