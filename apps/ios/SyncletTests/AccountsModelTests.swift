import FileProvider
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class AccountsModelTests: XCTestCase {
    private var harness: Harness!

    override func setUp() async throws {
        harness = Harness()
    }

    override func tearDown() async throws {
        harness.accounts.stopMonitoring()
        harness.cleanUp()
    }

    private let originA = URL(string: "https://a.example.test")!
    private let originB = URL(string: "https://b.example.test")!

    /// Two accounts on two servers (`srvA:u1`, `srvB:u1`).
    private func addTwo() async throws -> (StoredAccount, StoredAccount) {
        let a = FakeSynclet(serverId: "srvA")
        let b = FakeSynclet(serverId: "srvB")
        Harness.serve(["a.example.test": a, "b.example.test": b])
        let first = try await harness.accounts.add(server: originA, tokens: harness.tokens(a))
        let second = try await harness.accounts.add(server: originB, tokens: harness.tokens(b))
        return (first, second)
    }

    // MARK: - Add / select

    func testAddCreatesAnEntryAndSelectsIt() async throws {
        XCTAssertNil(harness.accounts.selectedKey)
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])

        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!,
                                                    tokens: harness.tokens(server))

        XCTAssertEqual(harness.accounts.entries.map(\.id), ["srv1:u1"])
        XCTAssertEqual(harness.accounts.entries.first?.status, .ok)
        XCTAssertEqual(harness.accounts.entries.first?.title, "jens@files.example.test")
        XCTAssertEqual(harness.accounts.selectedKey, stored.key)
        XCTAssertEqual(harness.defaults.string(forKey: "selectedAccount"), stored.key)
        XCTAssertEqual(harness.manager.credentials.token(for: stored.key), "syd_srv1_1")
        XCTAssertEqual(harness.domains.current, [stored.key16])
    }

    func testTheLatestSignInIsSelectedAndTheSelectionSurvivesARelaunch() async throws {
        let (first, second) = try await addTwo()
        XCTAssertEqual(harness.accounts.selectedKey, second.key)

        harness.accounts.selectedKey = first.key
        XCTAssertEqual(harness.relaunch().selectedKey, first.key)
    }

    func testAStaleSelectionFallsBackToTheFirstAccount() async throws {
        let (first, _) = try await addTwo()
        harness.defaults.set("gone:u9", forKey: "selectedAccount")
        XCTAssertEqual(harness.relaunch().selectedKey, first.key)
    }

    // MARK: - Sign out

    func testSignOutRemovesDomainTokenAndMovesTheSelectionToTheNextAccount() async throws {
        let (first, second) = try await addTwo()
        harness.accounts.selectedKey = first.key
        AuthFailureSignal.report(container: harness.accounts.container, key16: first.key16, post: false)

        await harness.accounts.signOut(key: first.key)

        XCTAssertEqual(harness.accounts.entries.map(\.id), [second.key])
        XCTAssertEqual(harness.domains.removeCalls, [first.key16])
        XCTAssertEqual(harness.domains.current, [second.key16])
        XCTAssertNil(harness.manager.credentials.token(for: first.key))
        XCTAssertNil(AuthFailureSignal.pending(container: harness.accounts.container, key16: first.key16))
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.method == "DELETE" && $0.path == "/api/sync/v1/devices/current" })
        XCTAssertEqual(harness.accounts.selectedKey, second.key)
        XCTAssertEqual(harness.defaults.string(forKey: "selectedAccount"), second.key)
        XCTAssertEqual(harness.cacheClears.count, 1, "opened files and thumbnails are cleared on sign-out")

        await harness.accounts.signOut(key: second.key)
        XCTAssertTrue(harness.accounts.entries.isEmpty)
        XCTAssertNil(harness.accounts.selectedKey)
        XCTAssertNil(harness.defaults.string(forKey: "selectedAccount"))
    }

    func testSigningOutTheLastAccountInTheListSelectsThePreviousOne() async throws {
        let (first, second) = try await addTwo()
        XCTAssertEqual(harness.accounts.selectedKey, second.key)
        await harness.accounts.signOut(key: second.key)
        XCTAssertEqual(harness.accounts.selectedKey, first.key)
    }

    func testSigningOutAnotherAccountKeepsTheSelection() async throws {
        let (first, second) = try await addTwo()
        XCTAssertEqual(harness.accounts.selectedKey, second.key)
        await harness.accounts.signOut(key: first.key)
        XCTAssertEqual(harness.accounts.selectedKey, second.key)
    }

    // MARK: - Auth failures

    func testAuthFailureMarkerNeedsSignInAndSigningInAgainClearsIt() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let origin = URL(string: "https://files.example.test")!
        let stored = try await harness.accounts.add(server: origin, tokens: harness.tokens(server))

        // The extension reports a rejected token.
        XCTAssertTrue(AuthFailureSignal.report(container: harness.accounts.container, key16: stored.key16, post: false))
        harness.accounts.processAuthFailures()
        XCTAssertEqual(harness.accounts.entries.first?.status, .signInRequired)

        // Signing in again clears the marker, keeps the domain and lifts the `.notAuthenticated` throttling.
        try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        XCTAssertEqual(harness.accounts.entries.first?.status, .ok)
        XCTAssertNil(AuthFailureSignal.pending(container: harness.accounts.container, key16: stored.key16))
        XCTAssertEqual(harness.domains.addCalls.count, 1)
        XCTAssertEqual(harness.domains.removeCalls, [])
        XCTAssertEqual(harness.resolver.resolvedAuthentication, [stored.key16, stored.key16])
        XCTAssertEqual(harness.manager.credentials.token(for: stored.key), "syd_srv1_2")
    }

    func testMissingTokenNeedsSignIn() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        harness.manager.credentials.delete(for: stored.key)
        harness.accounts.reload()
        XCTAssertEqual(harness.accounts.entries.first?.status, .signInRequired)
    }

    // MARK: - Foreground monitors and change events

    private func monitorFactory(_ world: FakeMonitorWorld) -> (StoredAccount) -> ForegroundMonitor {
        { account in
            ForegroundMonitor(accountKey: account.key, dependencies: world.dependencies(),
                              timing: ForegroundMonitor.Timing(coalesce: .milliseconds(1)))
        }
    }

    func testChangeEventsReachEverySubscriber() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))

        // Two independent subscribers (e.g. the browser and the recents list).
        let first = harness.accounts.changeEvents
        let second = harness.accounts.changeEvents
        let firstTask = Task { () -> String? in
            for await key in first { return key }
            return nil
        }
        let secondTask = Task { () -> String? in
            for await key in second { return key }
            return nil
        }

        let world = FakeMonitorWorld()
        harness.accounts.startMonitoring(factory: monitorFactory(world))
        _ = await eventually { world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        world.send(.changes(space: "personal", cursor: "2"))

        let firstKey = await firstTask.value
        let secondKey = await secondTask.value
        XCTAssertEqual(firstKey, stored.key)
        XCTAssertEqual(secondKey, stored.key)
    }

    func testEndedSubscribersAreDropped() async throws {
        var stream: AsyncStream<String>? = harness.accounts.changeEvents
        XCTAssertEqual(harness.accounts.subscriberCount, 1)
        stream = nil
        _ = stream
        let dropped = await eventually { self.harness.accounts.subscriberCount == 0 }
        XCTAssertTrue(dropped)
    }

    func testMonitoringRunsForSignedInAccountsAndStopsInTheBackground() async throws {
        let (first, second) = try await addTwo()
        AuthFailureSignal.report(container: harness.accounts.container, key16: first.key16, post: false)
        harness.accounts.processAuthFailures()

        let world = FakeMonitorWorld()
        harness.accounts.startMonitoring(factory: monitorFactory(world))
        _ = await eventually { world.streamCount == 1 }
        XCTAssertEqual(world.streamCount, 1, "only the signed-in account streams")
        XCTAssertEqual(harness.accounts.monitors[second.key]?.state, .connecting)
        XCTAssertEqual(harness.accounts.monitors[first.key]?.state, .authFailed)

        harness.accounts.stopMonitoring()
        XCTAssertTrue(harness.accounts.monitors.isEmpty)
        let ended = await eventually { world.terminatedStreams.contains(0) }
        XCTAssertTrue(ended)
    }

    // MARK: - DEBUG test login

    func testTestLoginStoresAPreregisteredTokenAndSelectsTheAccount() async throws {
        Harness.serve(["localhost": FakeSynclet(serverId: "srv1")])
        await TestLogin.run(arguments: ["Synclet", "-SyncletTestServer", "http://localhost:18140",
                                        "-SyncletTestToken", "syd_given"], accounts: harness.accounts)

        XCTAssertEqual(harness.accounts.entries.map(\.id), ["srv1:u1"])
        XCTAssertEqual(harness.accounts.selectedKey, "srv1:u1")
        XCTAssertEqual(harness.manager.credentials.token(for: "srv1:u1"), "syd_given")
        XCTAssertEqual(harness.domains.current, [AccountStore.key16(for: "srv1:u1")])
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/sync/v1/devices" }, "no registration")
    }

    func testTestLoginNeedsBothArguments() {
        XCTAssertNil(TestLogin.request(from: ["Synclet", "-SyncletTestServer", "http://localhost:18140"]))
        XCTAssertNil(TestLogin.request(from: ["Synclet", "-SyncletTestToken", "syd_x"]))
        XCTAssertEqual(TestLogin.request(from: ["Synclet", "-SyncletTestToken", "syd_x", "-SyncletTestServer", "localhost:18140"]),
                       TestLogin.Request(server: URL(string: "https://localhost:18140")!, token: "syd_x"))
    }
}
