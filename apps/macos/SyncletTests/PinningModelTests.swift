import FileProvider
import XCTest
import SyncletKit
@testable import Synclet

/// Records what the model asks the system for.
final class FakeOfflineContent: OfflineContentManaging, @unchecked Sendable {
    private let lock = NSLock()
    private var _signals: [(domain: String, containers: [String])] = []
    private var _ensured: [(domain: String, containers: [String])] = []
    /// Bytes reported per container id.
    var bytes: [String: Int64] = [:]

    var signals: [(domain: String, containers: [String])] { lock.withLock { _signals } }
    var ensured: [(domain: String, containers: [String])] { lock.withLock { _ensured } }

    func signal(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async {
        lock.withLock { _signals.append((domain.rawValue, containers.map(\.rawValue))) }
    }

    func ensureDownloaded(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
        -> [NSFileProviderItemIdentifier: Int64] {
        let bytes = lock.withLock { () -> [String: Int64] in
            _ensured.append((domain.rawValue, containers.map(\.rawValue)))
            return self.bytes
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
                            debounce: .zero)
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
        XCTAssertEqual(content.signals.map(\.containers), [[NSFileProviderItemIdentifier.workingSet.rawValue, "d_f"]])
        XCTAssertEqual(content.signals.first?.domain, account.key16)
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])
        let state = try XCTUnwrap(model.account(key: account.key))
        XCTAssertEqual(state.spaces[0].folders.first { $0.id == "d_f" }?.pinned, true)
        XCTAssertEqual(state.spaces[0].folders.first { $0.id == "d_f" }?.sizeHint, 4096)
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
        XCTAssertEqual(content.signals.map(\.containers),
                       [[NSFileProviderItemIdentifier.workingSet.rawValue, NSFileProviderItemIdentifier.rootContainer.rawValue]])
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
        XCTAssertEqual(model.account(key: b.key)?.spaces[0].folders[0].pinned, false)
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
        XCTAssertEqual(model.account(key: account.key)?.spaces[0].folders.map(\.pinned), [true])
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
        XCTAssertEqual(model.account(key: account.key)?.spaces[0].folders[0].pinned, true)

        // New content under a pin ⇒ (debounced) download walk.
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        model.handle(notification: PinStore.pinnedContentNotificationName(key16: account.key16))
        await model.waitForAnnouncements()
        await model.waitForRefreshes()
        XCTAssertEqual(content.ensured.map(\.containers), [["d_f"]])
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
