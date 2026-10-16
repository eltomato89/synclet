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
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: spaceDir.path).sorted(), ["pins.json", "pins.lock"])
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

    func testConcurrentWritersFromSeparateInstancesLoseNothing() throws {
        // Separate instances (as app and extension) share only the file lock.
        let dir = self.dir!
        DispatchQueue.concurrentPerform(iterations: 40) { index in
            let store = PinStore(stateDir: dir.appending(path: "accounts/0123456789abcdef"), post: { _ in })
            try? store.setFolder("d_\(index)", pinned: true, space: "personal")
        }
        XCTAssertEqual(store().pins(space: "personal").folders.count, 40)
    }

    func testPinnedDownloadQueueAppendsDrainsAndOverflows() throws {
        let queue = PinnedDownloadQueue(accountDirectory: dir)
        try queue.append(["f_1", "f_2"])
        try queue.append(["f_2", "f_3"])
        XCTAssertEqual(try queue.drain(), PinnedDownloadQueue.Batch(ids: ["f_1", "f_2", "f_3"]))
        XCTAssertEqual(try queue.drain(), PinnedDownloadQueue.Batch())
        try queue.append((0...PinnedDownloadQueue.maxEntries).map { "f_\($0)" })
        XCTAssertEqual(try queue.drain(), PinnedDownloadQueue.Batch(ids: [], overflow: true))
    }

    func testCorruptDownloadQueueBecomesAnOverflow() throws {
        let queue = PinnedDownloadQueue(accountDirectory: dir)
        try Data("garbage".utf8).write(to: queue.fileURL)
        XCTAssertEqual(try queue.drain(), PinnedDownloadQueue.Batch(ids: [], overflow: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.fileURL.appendingPathExtension("corrupt").path))
        try Data("garbage".utf8).write(to: queue.fileURL)
        try queue.append(["f_1"])
        XCTAssertEqual(try queue.drain(), PinnedDownloadQueue.Batch(ids: ["f_1"], overflow: true))
    }

    func testNotificationNames() {
        XCTAssertEqual(PinStore.notificationName(key16: "k"), "tech.jensk.synclet.pinsChanged.k")
        XCTAssertEqual(PinStore.pinnedContentNotificationName(key16: "k"), "tech.jensk.synclet.pinnedContentChanged.k")
    }
}

#if os(macOS)   // needs .downloadEagerlyAndKeepDownloaded (macOS-only SDK symbol)
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
#endif

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

#if os(macOS)   // needs .downloadEagerlyAndKeepDownloaded (macOS-only SDK symbol)
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
#endif

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

    func testPersistsOnFlushAndForgetsDeletedFoldersWithDescendants() throws {
        let dir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: "parent-map.json")
        let map = ParentMap(fileURL: url)
        map.record([Fixtures.item(id: "d_a", parentId: "root", type: "folder"),
                    Fixtures.item(id: "d_b", parentId: "d_a", type: "folder"),
                    Fixtures.item(id: "d_c", parentId: "d_b", type: "folder"),
                    Fixtures.item(id: "d_x", parentId: "root", type: "folder")])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))   // coalesced: nothing written per page
        map.remove(["d_a"])
        map.flush()
        let reloaded = ParentMap(fileURL: url)
        XCTAssertNil(reloaded.parent(of: "d_a"))
        XCTAssertNil(reloaded.parent(of: "d_b"))
        XCTAssertNil(reloaded.parent(of: "d_c"))
        XCTAssertEqual(reloaded.parent(of: "d_x"), "root")
        // Shared instances in one process see the same state.
        ParentMap.shared(at: url).record([Fixtures.item(id: "d_y", parentId: "root", type: "folder")])
        XCTAssertEqual(ParentMap.shared(at: url).parent(of: "d_y"), "root")
    }

    /// M2: a flush after the account directory was removed (sign-out) does not recreate it,
    /// and a cached map does not survive the directory being created again (new sign-in).
    func testSharedMapNeverRecreatesARemovedDirectoryAndReloadsAReplacedOne() throws {
        let base = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: base) }
        let dir = base.appending(path: "accounts/0123456789abcdef", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "pinned-content.json")
        let ledger = PinnedContentLedger(fileURL: url)
        let queue = PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json"))
        ledger.update(id: "f_1", version: "v3")
        ledger.flush()
        XCTAssertEqual(ledger.version(of: "f_1"), "v3")

        try FileManager.default.removeItem(at: dir)          // sign-out
        ledger.update(id: "f_2", version: "v1")              // operation still in flight
        ledger.flush()
        _ = queue.enqueue(PinTask(kind: .walk, id: "d_1", spaceId: "personal", announce: true))
        queue.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path), "not recreated")

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) // new sign-in
        XCTAssertNil(ledger.version(of: "f_1"), "stale cache dropped")
        XCTAssertNil(ledger.version(of: "f_2"))
        XCTAssertTrue(queue.isEmpty)
    }

    /// M6: bounded – beyond ``ParentMap/maxEntries`` the map starts over.
    func testParentMapIsBounded() {
        let map = ParentMap(fileURL: nil)
        let many = (0..<ParentMap.maxEntries).map { Fixtures.item(id: "d_\($0)", parentId: "root", type: "folder") }
        map.record(many)
        XCTAssertEqual(map.count, ParentMap.maxEntries)
        map.record([Fixtures.item(id: "d_new", parentId: "d_1", type: "folder")])
        XCTAssertEqual(map.count, 1)
        XCTAssertEqual(map.parent(of: "d_new"), "d_1")
        map.removeAll()
        XCTAssertEqual(map.count, 0)
    }

    /// M11: the app-group JSON files carry `"v": 1`; files of earlier builds (no version,
    /// bare map / array) are still read.
    func testStateFilesAreVersionedAndUnversionedFilesStillRead() throws {
        let dir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        // Earlier builds: bare map and bare array.
        try Data(#"{"f_1":"v3"}"#.utf8).write(to: dir.appending(path: "pinned-content.json"))
        try Data(#"[{"kind":"walk","id":"d_1","announce":true}]"#.utf8).write(to: dir.appending(path: "pin-queue.json"))
        try Data(#"{"wholeSpace":true}"#.utf8).write(to: dir.appending(path: "pins.json"))
        let ledger = PinnedContentLedger(fileURL: dir.appending(path: "pinned-content.json"))
        let queue = PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json"))
        XCTAssertEqual(ledger.version(of: "f_1"), "v3")
        XCTAssertFalse(queue.isEmpty)
        XCTAssertFalse(queue.takeCorruption())
        XCTAssertEqual(try JSONDecoder().decode(PinSet.self, from: Data(contentsOf: dir.appending(path: "pins.json"))),
                       PinSet(wholeSpace: true))

        // Written back versioned.
        ledger.update(id: "f_2", version: "v1")
        ledger.flush()
        _ = queue.enqueue(PinTask(kind: .walk, id: "d_2", announce: true))
        queue.flush()
        for name in ["pinned-content.json", "pin-queue.json"] {
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: dir.appending(path: name))) as? [String: Any])
            XCTAssertEqual(json["v"] as? Int, StateFormat.version, name)
        }
        XCTAssertEqual(PinnedContentLedger(fileURL: dir.appending(path: "pinned-content.json")).version(of: "f_1"), "v3")
        XCTAssertEqual(PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json")).tasks.count, 2)
        let pinJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(PinSet())) as? [String: Any])
        XCTAssertEqual(pinJSON["v"] as? Int, 1)
        let account = StoredAccount(key: "k", serverURL: Fixtures.server, userId: "u", username: "j", displayName: "J", spaces: [])
        let accountJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(account)) as? [String: Any])
        XCTAssertEqual(accountJSON["v"] as? Int, 1)
        let batch = try JSONDecoder().decode(PinnedDownloadQueue.Batch.self, from: Data(#"{"ids":["a"],"overflow":false}"#.utf8))
        XCTAssertEqual(batch.ids, ["a"])
    }

    func testNotePolicyReportsFlipsOnly() {
        let map = ParentMap(fileURL: nil)
        XCTAssertFalse(map.notePolicy("d_unknown", kept: true))
        map.record([Fixtures.item(id: "d_a", parentId: "root", type: "folder")])
        XCTAssertFalse(map.notePolicy("d_a", kept: false))   // first report
        XCTAssertFalse(map.notePolicy("d_a", kept: false))
        XCTAssertTrue(map.notePolicy("d_a", kept: true))
        map.record([Fixtures.item(id: "d_a", parentId: "d_b", type: "folder")])   // a move keeps the state
        XCTAssertTrue(map.notePolicy("d_a", kept: false))
    }
}

/// Enumerator and extension behaviour with pins (Strategy B: explicit policy on every item).
#if os(macOS)   // needs .downloadEagerlyAndKeepDownloaded (macOS-only SDK symbol)
final class PinnedEnumerationTests: XCTestCase {
    var dir: URL!
    let keep = NSFileProviderContentPolicy.downloadEagerlyAndKeepDownloaded
    let personal = NSFileProviderItemIdentifier("space:personal")

    override func setUp() { dir = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func pinning(log: PostLog = PostLog(), announced: PostLog? = nil, rounds: Counter? = nil,
                         announceSucceeds: Bool = true) -> PinningContext {
        PinningContext(store: PinStore(stateDir: dir.appending(path: "accounts/0123456789abcdef"), post: { log.record($0) }),
                       parentMap: ParentMap(fileURL: dir.appending(path: "parent-map.json")),
                       ledger: PinnedContentLedger(fileURL: dir.appending(path: "pinned-content.json")),
                       queue: PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json")),
                       announce: { ids in
                           ids.forEach { announced?.record($0) }
                           return announceSucceeds
                       },
                       requestWorkingSetRound: { _ = rounds?.next() })
    }

    private func policies(_ items: [NSFileProviderItem]) -> [String: NSFileProviderContentPolicy] {
        Dictionary(items.map { ($0.itemIdentifier.rawValue, $0.contentPolicy ?? .inherited) }, uniquingKeysWith: { $1 })
    }

    private func changes(_ enumerator: FileProviderEnumerator, from cursor: String = "10", batch: Int = 0) async -> MockChangeObserver {
        let observer = MockChangeObserver(expectation(description: "changes"))
        observer.suggestedBatchSize = batch
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
        let announced = PostLog()
        let pin = pinning(announced: announced)
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
        XCTAssertEqual(announced.all, ["f_new"])   // only the new kept file, not folders or unpinned files
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
        pin.parentMap.notePolicy("d_sub", kept: false)   // reported before, not kept
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

    func testFolderMovedOutOfAPinnedFolderReReportsItsSubtreeAsInherited() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_docs", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_sub", parentId: "d_fotos", type: "folder")])
        pin.parentMap.notePolicy("d_sub", kept: true)
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_sub", parentId: "d_docs", name: "sub"))}],"cursor":"11","hasMore":false}"#)
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
        XCTAssertEqual(policies(observer.updated), ["d_sub": .inherited, "f_old": .inherited])
    }

    func testMoveNoticedByAContainerEnumerationIsQueuedForTheWorkingSet() async throws {
        let rounds = Counter()
        let pin = pinning(rounds: rounds)
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_docs", parentId: "root", type: "folder"),
                              Fixtures.item(id: "d_sub", parentId: "d_docs", type: "folder")])
        pin.parentMap.notePolicy("d_sub", kept: false)
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/items/d_fotos/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_sub", parentId: "d_fotos", name: "sub"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/changes":
                // The move itself arrives later – the parent is already recorded by then.
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.folderJSON(id: "d_sub", parentId: "d_fotos", name: "sub"))}],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/d_sub/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_old", parentId: "d_sub"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let container = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("d_fotos"), client: Fixtures.client(),
                                               layout: { Fixtures.layout }, pinning: pin)
        let items = MockEnumerationObserver(expectation(description: "items"))
        container.enumerateItems(for: items, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        await fulfillment(of: [items.finished], timeout: 5)
        XCTAssertEqual(policies(items.items), ["d_sub": keep])
        XCTAssertEqual(pin.queue.tasks.map(\.id), ["d_sub"])
        XCTAssertEqual(rounds.next(), 2)   // one working-set round requested

        let workingSet = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(workingSet)
        XCTAssertEqual(policies(observer.updated), ["d_sub": keep, "f_old": keep])
        XCTAssertTrue(pin.queue.isEmpty)
    }

    func testFailingAncestorLookupDoesNotAbortTheBatch() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        let failing = Counter()
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_x", parentId: "d_unknown"))},{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_ok", parentId: "d_fotos"))}],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/d_unknown":
                _ = failing.next()
                return .error(503, "unavailable")
            case "/api/sync/v1/items/f_x":
                return .error(503, "unavailable")
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertNil(observer.error)
        XCTAssertEqual(SyncAnchorCodec.decode(observer.anchor!), ["personal": "11"])
        XCTAssertEqual(policies(observer.updated), ["f_x": .inherited, "f_ok": keep])
        XCTAssertEqual(pin.queue.tasks.map(\.id), ["f_x"])   // retried in a later round
        XCTAssertEqual(observer.moreComing, false)          // a paused queue does not spin
    }

    func testWholeSpaceReapplyResumesAfterAnErrorWithoutStartingOver() async throws {
        let pin = pinning()
        try pin.store.setWholeSpace(true, space: "personal")
        let rootListings = Counter()
        let failNext = PostLog()
        failNext.record("d_a")
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/root/children":
                _ = rootListings.next()
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_a", name: "A")),\#(Fixtures.folderJSON(id: "d_b", name: "B"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_a/children":
                if failNext.all.count == 1 {
                    failNext.record("done")
                    return .json(500, #"{"statusCode":500,"message":"boom"}"#)
                }
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_a", parentId: "d_a"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_b/children":
                return .json(200, #"{"items":[\#(Fixtures.itemJSON(id: "f_b", parentId: "d_b"))],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let first = await changes(enumerator)
        XCTAssertNil(first.error)
        XCTAssertEqual(SyncAnchorCodec.decode(first.anchor!), ["personal": "11"])
        XCTAssertEqual(policies(first.updated), ["space:personal": keep, "d_a": keep, "d_b": keep])
        // The failing walk is rotated behind the other one (with its failure counted).
        XCTAssertEqual(pin.queue.tasks.map(\.id), ["d_b", "d_a"])
        XCTAssertEqual(pin.queue.tasks.map(\.failures), [0, 1])
        // The queue is persisted: a restarted extension continues from it.
        let reloaded = PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json"))
        XCTAssertEqual(reloaded.tasks.map(\.id), ["d_b", "d_a"])

        let second = await changes(enumerator, from: "11")
        XCTAssertNil(second.error)
        XCTAssertEqual(policies(second.updated), ["f_a": keep, "f_b": keep])
        XCTAssertTrue(pin.queue.isEmpty)
        XCTAssertEqual(rootListings.next(), 2)   // the root was listed once, not again
    }

    func testReapplyIsBoundedPerRoundAndSignalsMoreComing() async throws {
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
        let first = await changes(enumerator, batch: 1)
        XCTAssertEqual(first.moreComing, true)
        XCTAssertEqual(Set(policies(first.updated).keys), ["space:personal", "d_a", "f_1"])
        let second = await changes(enumerator, from: "11", batch: 1)
        XCTAssertEqual(second.moreComing, false)
        XCTAssertEqual(policies(second.updated), ["f_2": keep])
    }

    func testOnlyNewContentOfKeptFilesIsAnnounced() async throws {
        let announced = PostLog()
        let pin = pinning(announced: announced)
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        let feed = PostLog()
        MockURLProtocol.reset { request in
            let item: String
            switch feed.all.count {
            case 0: item = Fixtures.itemJSON(id: "f_1", parentId: "d_fotos", name: "a.pdf", contentEtag: "v3")
            case 1: item = Fixtures.itemJSON(id: "f_1", parentId: "d_fotos", name: "renamed.pdf", contentEtag: "v3")
            default: item = Fixtures.itemJSON(id: "f_1", parentId: "d_fotos", name: "renamed.pdf", version: 4, contentEtag: "v4")
            }
            feed.record("x")
            return .json(200, #"{"changes":[{"op":"upsert","item":\#(item)}],"cursor":"11","hasMore":false}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        _ = await changes(enumerator)
        _ = await changes(enumerator, from: "11")   // metadata only
        _ = await changes(enumerator, from: "11")   // new content
        XCTAssertEqual(announced.all, ["f_1", "f_1"])
    }

    func testQueueIsOnDiskBeforePinsCountAsApplied() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        // Only the enqueue step runs – as if the extension were killed right after it,
        // before any drain or flush.
        pin.resolver(layout: Fixtures.layout, client: Fixtures.client()).enqueueChangedPins(gone: [], report: { _ in })
        XCTAssertEqual(pin.store.appliedPins(space: "personal"), pin.store.pins(space: "personal"))
        let restarted = PinWorkQueue(fileURL: dir.appending(path: "pin-queue.json"))
        XCTAssertEqual(restarted.tasks.map(\.id), ["d_fotos"])
        XCTAssertEqual(restarted.tasks.first?.walkAfter, true)
    }

    func testIdsThatCouldNotBeQueuedAreAnnouncedAgain() async throws {
        let announced = PostLog()
        let pin = pinning(announced: announced, announceSucceeds: false)
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        MockURLProtocol.reset { _ in
            .json(200, #"{"changes":[{"op":"upsert","item":\#(Fixtures.itemJSON(id: "f_1", parentId: "d_fotos"))}],"cursor":"11","hasMore":false}"#)
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        _ = await changes(enumerator)
        XCTAssertNil(pin.ledger.version(of: "f_1"))   // rolled back
        _ = await changes(enumerator, from: "11")
        XCTAssertEqual(announced.all, ["f_1", "f_1"])
    }

    func testCorruptQueueIsQuarantinedAndTriggersAFullRewalk() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        try Data("{nope".utf8).write(to: dir.appending(path: "pin-queue.json"))
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/root/children":
                return .json(200, #"{"items":[\#(Fixtures.folderJSON(id: "d_fotos", name: "Fotos")),\#(Fixtures.folderJSON(id: "d_docs", name: "Docs"))],"nextPageToken":null,"cursor":"5"}"#)
            case "/api/sync/v1/items/d_fotos/children", "/api/sync/v1/items/d_docs/children":
                return .json(200, #"{"items":[],"nextPageToken":null,"cursor":"5"}"#)
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let observer = await changes(enumerator)
        XCTAssertNil(observer.error)
        XCTAssertEqual(policies(observer.updated), ["d_fotos": keep, "d_docs": .inherited])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appending(path: "pin-queue.json.corrupt").path))
    }

    func testRepeatedlyFailingTaskIsRotatedAndFinallyDropped() async throws {
        let pin = pinning()
        try pin.store.setFolder("d_fotos", pinned: true, space: "personal")
        try pin.store.setAppliedPins(pin.store.pins(space: "personal"), space: "personal")
        pin.parentMap.record([Fixtures.item(id: "d_fotos", parentId: "root", type: "folder")])
        pin.queue.enqueue(PinTask(kind: .item, id: "f_bad", announce: true))
        pin.queue.enqueue(PinTask(kind: .item, id: "f_ok", announce: true))
        MockURLProtocol.reset { request in
            switch request.path {
            case "/api/sync/v1/changes":
                return .json(200, #"{"changes":[],"cursor":"11","hasMore":false}"#)
            case "/api/sync/v1/items/f_bad":
                return .json(200, "not json")   // a permanent, non-404 error
            case "/api/sync/v1/items/f_ok":
                return .json(200, Fixtures.itemJSON(id: "f_ok", parentId: "d_fotos"))
            default:
                XCTFail("unexpected \(request.path)")
                return .empty(500)
            }
        }
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: Fixtures.client(),
                                                layout: { Fixtures.layout }, pinning: pin)
        let first = await changes(enumerator)
        XCTAssertTrue(first.updated.isEmpty)
        XCTAssertEqual(pin.queue.tasks.map(\.id), ["f_ok", "f_bad"])   // rotated behind
        XCTAssertEqual(first.moreComing, false)
        let second = await changes(enumerator, from: "11")
        XCTAssertEqual(policies(second.updated), ["f_ok": keep])
        for _ in 0..<3 { _ = await changes(enumerator, from: "11") }
        XCTAssertTrue(pin.queue.isEmpty)   // dropped after 5 failures
    }

    func testOtherPathsRequestAtMostOneRoundUntilItRuns() async throws {
        let rounds = Counter()
        let pin = pinning(rounds: rounds)
        pin.queue.enqueue(PinTask(kind: .item, id: "f_x", announce: true))
        FileProviderEnumerator.finishPinning(pin, announce: [], workingSet: false)
        FileProviderEnumerator.finishPinning(pin, announce: [], workingSet: false)
        XCTAssertEqual(rounds.next(), 2)   // requested once
        pin.queue.roundStarted()
        FileProviderEnumerator.finishPinning(pin, announce: [], workingSet: false)
        XCTAssertEqual(rounds.next(), 4)
    }

    /// M6: without pins the parent map is not grown (and an old one is cleared).
    func testWithoutPinsTheParentMapStaysEmpty() async throws {
        let pin = pinning()
        pin.parentMap.record([Fixtures.item(id: "d_old", parentId: "root", type: "folder")])
        let resolver = pin.resolver(layout: Fixtures.layout, client: Fixtures.client())
        _ = try await resolver.items([Fixtures.item(id: "d_a", parentId: "root", type: "folder"),
                                      Fixtures.item(id: "d_b", parentId: "d_a", type: "folder")])
        XCTAssertEqual(pin.parentMap.count, 0)

        try pin.store.setFolder("d_a", pinned: true, space: "personal")
        MockURLProtocol.reset { request in
            request.path == "/api/sync/v1/items/d_a" ? .json(200, Fixtures.folderJSON(id: "d_a", name: "a")) : .empty(500)
        }
        _ = try await pin.resolver(layout: Fixtures.layout, client: Fixtures.client())
            .items([Fixtures.item(id: "d_b", parentId: "d_a", type: "folder")])
        XCTAssertEqual(pin.parentMap.parent(of: "d_b"), "d_a", "recorded again once something is pinned")
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
#endif
