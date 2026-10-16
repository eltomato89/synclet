import FileProvider
import XCTest
import SyncletKit
@testable import Synclet

/// Records what the model asks the system for.
final class FakeOfflineContent: OfflineContentManaging, @unchecked Sendable {
    private let lock = NSLock()
    private var _signals: [(domain: String, containers: [String])] = []
    private var _ensured: [(domain: String, containers: [String])] = []
    private var _requested: [[String]] = []
    private var _cancelledWalks = 0
    /// Bytes reported per container id.
    var bytes: [String: Int64] = [:]
    /// Ids whose download request fails (once each).
    var failOnce: Set<String> = []
    /// `ensureDownloaded` waits this long (cancellable).
    var walkDuration: Duration = .zero
    /// Called inside each `requestDownloads` (before it answers).
    var onRequest: (@Sendable ([String]) async -> Void)?

    var signals: [(domain: String, containers: [String])] { lock.withLock { _signals } }
    var ensured: [(domain: String, containers: [String])] { lock.withLock { _ensured } }
    var requested: [[String]] { lock.withLock { _requested } }
    var cancelledWalks: Int { lock.withLock { _cancelledWalks } }

    func requestDownloads(domain: NSFileProviderDomainIdentifier, ids: [String]) async -> [String] {
        await onRequest?(ids)
        return lock.withLock {
            _requested.append(ids)
            let failed = ids.filter { failOnce.contains($0) }
            failOnce.subtract(failed)
            return failed
        }
    }

    func signal(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async {
        lock.withLock { _signals.append((domain.rawValue, containers.map(\.rawValue))) }
    }

    func ensureDownloaded(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
        -> [NSFileProviderItemIdentifier: Int64] {
        let bytes = lock.withLock { () -> [String: Int64] in
            _ensured.append((domain.rawValue, containers.map(\.rawValue)))
            return self.bytes
        }
        if walkDuration > .zero {
            try? await Task.sleep(for: walkDuration)
            if Task.isCancelled {
                lock.withLock { _cancelledWalks += 1 }
                return [:]
            }
        }
        return Dictionary(containers.compactMap { id in bytes[id.rawValue].map { (id, $0) } }, uniquingKeysWith: { a, _ in a })
    }
}

final class PostedNames: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    var all: [String] { lock.withLock { names } }
    func record(_ name: String) { lock.withLock { names.append(name) } }
}

@MainActor
final class PinningModelTests: XCTestCase {
    var harness: Harness!
    var content: FakeOfflineContent!
    var posted: PostedNames!

    override func setUp() async throws {
        harness = Harness()
        content = FakeOfflineContent()
        posted = PostedNames()
    }

    override func tearDown() async throws {
        harness.cleanUp()
    }

    /// Stores an account directly (no login flow) with a token.
    @discardableResult
    private func addAccount(host: String, serverId: String, spaces: [SyncSpace] = [.personal()]) throws -> StoredAccount {
        let account = StoredAccount(key: "\(serverId):u1", serverURL: URL(string: "https://\(host)")!, userId: "u1",
                                    username: "jens", displayName: "Jens", spaces: spaces)
        try harness.manager.accounts.upsert(account)
        try harness.manager.credentials.save(token: "syd_\(serverId)", for: account.key)
        harness.accounts.reload()
        return account
    }

    private func makeModel() -> PinningModel {
        let directory = harness.manager.accounts
        let posted = posted!
        return PinningModel(accounts: harness.accounts, content: content,
                            makeStore: { PinStore(stateDir: directory.accountDirectory(key: $0.key), post: { posted.record($0) }) },
                            debounce: .zero, retryDelay: .zero)
    }

    private static func folder(_ id: String, _ name: String, parent: String = "root") -> String {
        """
        {"id":"\(id)","parentId":"\(parent)","type":"folder","kind":"folder","name":"\(name)","size":0,"mime":null,
         "version":null,"sha256":null,"etag":"t1","contentEtag":null,"createdAt":"2026-09-01T08:00:00.000Z",
         "modifiedAt":"2026-10-02T12:30:15.123Z","documentId":null,
         "capabilities":{"read":true,"write":true,"rename":true,"move":true,"delete":true,"addChildren":true}}
        """
    }

    private static func file(_ id: String, _ name: String, size: Int64) -> String {
        """
        {"id":"\(id)","parentId":"root","type":"file","kind":"file","name":"\(name)","size":\(size),"mime":"text/plain",
         "version":1,"sha256":null,"etag":"v1","contentEtag":"v1","createdAt":"2026-09-01T08:00:00.000Z",
         "modifiedAt":"2026-10-02T12:30:15.123Z","documentId":"\(id)",
         "capabilities":{"read":true,"write":true,"rename":true,"move":true,"delete":true,"addChildren":false}}
        """
    }

    /// Root children per host.
    private func serveRoots(_ roots: [String: [String]]) {
        MockURLProtocol.reset { request in
            guard request.path == "/api/sync/v1/items/root/children", let items = roots[request.host] else {
                return .json(404, #"{"statusCode":404,"message":"not found","code":"not_found"}"#)
            }
            return .json(200, #"{"items":[\#(items.joined(separator: ","))],"nextPageToken":null,"cursor":"1"}"#)
        }
    }

    func testLoadsFirstLevelFoldersSortedAndOnlyFolders() async throws {
        try addAccount(host: "a.test", serverId: "srvA")
        serveRoots(["a.test": [Self.folder("d_z", "Zeug"), Self.file("f_1", "readme.txt", size: 5),
                               Self.folder("d_f", "Fotos"), Self.folder("d_10", "Ordner 10"), Self.folder("d_9", "Ordner 9")]])
        let model = makeModel()
        await model.loadAll()

        let space = try XCTUnwrap(model.accounts.first?.spaces.first)
        XCTAssertEqual(space.folders.map(\.name), ["Fotos", "Ordner 9", "Ordner 10", "Zeug"])
        XCTAssertFalse(space.isLoading)
        XCTAssertNil(space.error)
        XCTAssertTrue(content.ensured.isEmpty)   // nothing pinned ⇒ no walk
    }

    func testFolderToggleWritesTheStorePostsAndSignals() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        serveRoots(["a.test": [Self.folder("d_f", "Fotos"), Self.folder("d_d", "Docs")]])
        content.bytes = ["d_f": 4096]
        let model = makeModel()
        await model.loadAll()

        await model.setFolder("d_f", pinned: true, key: account.key, space: "personal")
        await model.waitForRefreshes()

        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))
        XCTAssertEqual(store.pins(space: "personal"), PinSet(wholeSpace: false, folders: ["d_f"]))
        XCTAssertEqual(posted.all, ["tech.jensk.synclet.pinsChanged.\(account.key16)"])
        XCTAssertEqual(content.signals.map(\.containers), [[NSFileProviderItemIdentifier.workingSet.rawValue]])
        XCTAssertEqual(content.signals.first?.domain, account.key16)
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])
        let state = try XCTUnwrap(model.account(key: account.key))
        XCTAssertTrue(state.spaces[0].isPinned("d_f"))
        XCTAssertEqual(state.spaces[0].sizeHint("d_f"), 4096)
        XCTAssertEqual(state.offlineBytes, 4096)

        // Unpin: back to inherited via the store; the walk is not repeated for nothing.
        await model.setFolder("d_f", pinned: false, key: account.key, space: "personal")
        await model.waitForRefreshes()
        XCTAssertTrue(store.pins(space: "personal").isEmpty)
        XCTAssertEqual(posted.all.count, 2)
        XCTAssertEqual(content.ensured.count, 1)
        XCTAssertEqual(model.account(key: account.key)?.offlineBytes, 0)
    }

    func testWholeSpaceToggleSignalsTheRootContainerAndWalksTheSpace() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        serveRoots(["a.test": [Self.folder("d_f", "Fotos")]])
        content.bytes = ["space:personal": 1_000_000]
        let model = makeModel()
        await model.loadAll()

        await model.setWholeSpace(true, key: account.key, space: "personal")
        await model.waitForRefreshes()

        XCTAssertTrue(PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key)).pins(space: "personal").wholeSpace)
        XCTAssertEqual(content.signals.map(\.containers), [[NSFileProviderItemIdentifier.workingSet.rawValue]])
        XCTAssertEqual(content.ensured.map(\.containers), [["space:personal"]])
        XCTAssertEqual(model.account(key: account.key)?.offlineBytes, 1_000_000)
    }

    func testTwoAccountsWithTheSameFolderStayIndependent() async throws {
        let a = try addAccount(host: "a.test", serverId: "srvA")
        let b = try addAccount(host: "b.test", serverId: "srvB")
        serveRoots(["a.test": [Self.folder("d_f", "Fotos")], "b.test": [Self.folder("d_f", "Fotos")]])
        let model = makeModel()
        await model.loadAll()

        await model.setFolder("d_f", pinned: true, key: a.key, space: "personal")
        await model.waitForRefreshes()

        let directory = harness.manager.accounts
        XCTAssertEqual(PinStore(stateDir: directory.accountDirectory(key: a.key)).pins(space: "personal").folders, ["d_f"])
        XCTAssertTrue(PinStore(stateDir: directory.accountDirectory(key: b.key)).pins(space: "personal").isEmpty)
        XCTAssertEqual(model.account(key: b.key)?.spaces[0].isPinned("d_f"), false)
        XCTAssertEqual(content.signals.map(\.domain), [a.key16])
    }

    func testLoadDropsPinsOfVanishedFolders() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))
        try store.setFolder("d_gone", pinned: true, space: "personal")
        try store.setFolder("d_f", pinned: true, space: "personal")
        serveRoots(["a.test": [Self.folder("d_f", "Fotos (umbenannt)")]])
        let model = makeModel()
        await model.loadAll()
        await model.waitForRefreshes()

        XCTAssertEqual(store.pins(space: "personal").folders, ["d_f"])   // the rename keeps the pin (same id)
        XCTAssertEqual(model.account(key: account.key)?.spaces[0].pins.folders, ["d_f"])
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])     // pinned content is caught up on load
    }

    func testLoadErrorIsShownAndKeepsThePins() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))
        try store.setFolder("d_f", pinned: true, space: "personal")
        MockURLProtocol.reset { _ in .json(500, #"{"statusCode":500,"message":"boom"}"#) }
        let model = makeModel()
        await model.loadAll()

        XCTAssertNotNil(model.account(key: account.key)?.spaces[0].error)
        XCTAssertEqual(store.pins(space: "personal").folders, ["d_f"])
    }

    func testSignalsOfTheExtensionRefreshPinsAndContent() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        serveRoots(["a.test": [Self.folder("d_f", "Fotos")]])
        let model = makeModel()
        await model.loadAll()
        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))

        // The extension (or another writer) pinned/unpinned: re-read without network.
        try store.setFolder("d_f", pinned: true, space: "personal")
        model.handle(notification: PinStore.notificationName(key16: account.key16))
        XCTAssertEqual(model.account(key: account.key)?.spaces[0].isPinned("d_f"), true)

        // New content under a pin ⇒ (debounced) requests of exactly the announced ids, no walk.
        let queue = PinnedDownloadQueue(accountDirectory: harness.manager.accounts.accountDirectory(key: account.key))
        try queue.append(["f_new1"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        try queue.append(["f_new2"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        await model.waitForRefreshes()
        XCTAssertEqual(content.requested, [["f_new1", "f_new2"]])
        XCTAssertTrue(content.ensured.isEmpty)

        // An announcement without queued ids (nothing new) requests nothing.
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        XCTAssertEqual(content.requested.count, 1)

        // An overflowed queue falls back to one walk.
        try queue.append((0...PinnedDownloadQueue.maxEntries).map { "f_\($0)" })
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        await model.waitForRefreshes()
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])
    }

    func testFallbackWorksAtLaunchWithoutOpeningTheOfflineTab() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))
        try store.setFolder("d_f", pinned: true, space: "personal")
        MockURLProtocol.reset { request in
            XCTFail("no network expected: \(request.path)")
            return .json(500, "{}")
        }
        content.bytes = ["d_f": 10]
        let model = makeModel()   // no loadAll()
        model.start()
        await model.waitForRefreshes()
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])
        XCTAssertEqual(model.account(key: account.key)?.offlineBytes, 10)

        try PinnedDownloadQueue(accountDirectory: harness.manager.accounts.accountDirectory(key: account.key)).append(["f_1"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        XCTAssertEqual(content.requested, [["f_1"]])
    }

    /// M7: the launch walks only when the pins changed since the last finished walk (or the
    /// download queue overflowed); otherwise it restores the measured size and only drains
    /// announced ids.
    func testLaunchWalksOnlyWhenThePinsChangedOrTheQueueOverflowed() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let directory = harness.manager.accounts.accountDirectory(key: account.key)
        let store = PinStore(stateDir: directory)
        try store.setFolder("d_f", pinned: true, space: "personal")
        content.bytes = ["d_f": 10, "d_g": 5]
        let first = makeModel()
        first.start()
        await first.waitForRefreshes()
        XCTAssertEqual(content.ensured.count, 1)

        // Same pins: no walk, size restored, queued ids requested.
        try PinnedDownloadQueue(accountDirectory: directory).append(["f_1"])
        let second = makeModel()
        second.start()
        await second.waitForRefreshes()
        await second.waitForAnnouncements()
        XCTAssertEqual(content.ensured.count, 1, "no launch walk")
        XCTAssertEqual(second.account(key: account.key)?.offlineBytes, 10)
        XCTAssertEqual(content.requested, [["f_1"]])

        // Overflowed queue: walk.
        try PinnedDownloadQueue(accountDirectory: directory).append((0...PinnedDownloadQueue.maxEntries).map { "f_\($0)" })
        let third = makeModel()
        third.start()
        await third.waitForAnnouncements()
        await third.waitForRefreshes()
        XCTAssertEqual(content.ensured.count, 2)

        // Changed pins: walk.
        try store.setFolder("d_g", pinned: true, space: "personal")
        let fourth = makeModel()
        fourth.start()
        await fourth.waitForRefreshes()
        XCTAssertEqual(content.ensured.count, 3)
        XCTAssertEqual(content.ensured.last?.containers, ["d_f", "d_g"])
    }

    func testFailedDownloadRequestsAreRetriedOnce() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let model = makeModel()
        content.failOnce = ["f_2"]
        try PinnedDownloadQueue(accountDirectory: harness.manager.accounts.accountDirectory(key: account.key)).append(["f_1", "f_2"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        XCTAssertEqual(content.requested, [["f_1", "f_2"], ["f_2"]])
    }

    func testAnAnnouncementDuringARunningBatchLosesNoIds() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let model = makeModel()
        let queue = PinnedDownloadQueue(accountDirectory: harness.manager.accounts.accountDirectory(key: account.key))
        content.failOnce = ["f_1"]
        let key16 = account.key16
        let posted = PostedNames()
        // While the first batch is being requested, new content is announced.
        content.onRequest = { @MainActor ids in
            guard posted.all.isEmpty else { return }
            posted.record("second")
            try? queue.append(["f_3"])
            model.handle(notification: PinStore.pinnedContentNotificationName(key16: key16))
        }
        try queue.append(["f_1", "f_2"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()

        // f_1 failed once and was retried; f_2 was not dropped; f_3 came in a follow-up batch.
        XCTAssertEqual(content.requested, [["f_1", "f_2"], ["f_1"], ["f_3"]])
    }

    func testSignOutCancelsTheWalkAndPendingAnnouncements() async throws {
        let account = try addAccount(host: "a.test", serverId: "srvA")
        let store = PinStore(stateDir: harness.manager.accounts.accountDirectory(key: account.key))
        try store.setFolder("d_f", pinned: true, space: "personal")
        content.walkDuration = .seconds(30)
        let model = PinningModel(accounts: harness.accounts, content: content, debounce: .seconds(30), retryDelay: .zero)
        model.start()
        XCTAssertTrue(model.isRefreshing(key: account.key))
        try PinnedDownloadQueue(accountDirectory: harness.manager.accounts.accountDirectory(key: account.key)).append(["f_1"])
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        try await Task.sleep(for: .milliseconds(50))   // the walk is running

        await harness.accounts.signOut(key: account.key)
        model.reload()

        let deadline = Date().addingTimeInterval(5)
        while content.cancelledWalks == 0, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(content.cancelledWalks, 1)
        XCTAssertFalse(model.isRefreshing(key: account.key))
        await model.waitForAnnouncements()
        await model.waitForRefreshes()
        XCTAssertTrue(content.requested.isEmpty)   // the debounced announcement never fired
        XCTAssertNil(model.account(key: account.key))
    }

    func testScanStopsWhenCancelled() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "synclet-scan-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appending(path: "sub"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data(count: 100).write(to: dir.appending(path: "a.bin"))
        try Data(count: 50).write(to: dir.appending(path: "sub/b.bin"))
        XCTAssertEqual(SystemOfflineContent.scan(dir).bytes, 150)
        let stopped = SystemOfflineContent.scan(dir, isCancelled: { true })
        XCTAssertEqual(stopped.bytes, 0)
        XCTAssertTrue(stopped.missing.isEmpty)
    }

    func testRealDarwinNotificationReachesAnObserver() async throws {
        let name = "tech.jensk.synclet.pinsChanged.test-\(UUID().uuidString)"
        let received = expectation(description: "notification")
        let observer = DarwinNotificationObserver(name: name) { got in
            if got == name { received.fulfill() }
        }
        PinStore.postDarwinNotification(name)
        await fulfillment(of: [received], timeout: 2)
        _ = observer
    }
}
