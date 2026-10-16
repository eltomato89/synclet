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
        harness.cleanUp()
    }

    func testSameKeyTwiceReplacesTheTokenAndKeepsOneAccountAndDomain() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let origin = URL(string: "https://files.example.test")!
        var firstAccountCalls = 0
        harness.accounts.onFirstAccountAdded = { firstAccountCalls += 1 }

        let first = try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        XCTAssertEqual(harness.manager.credentials.token(for: first.key), "syd_srv1_1")
        let second = try await harness.accounts.add(server: origin, tokens: harness.tokens(server))

        XCTAssertEqual(first.key, second.key)
        XCTAssertEqual(harness.accounts.entries.count, 1)
        XCTAssertEqual(harness.manager.accounts.all().count, 1)
        XCTAssertEqual(harness.manager.credentials.token(for: first.key), "syd_srv1_2")
        XCTAssertEqual(harness.domains.addCalls.count, 1)
        XCTAssertEqual(harness.domains.current, [first.key16])
        XCTAssertEqual(firstAccountCalls, 1)
    }

    func testTwoHostsWithTheSameUsernameAreTwoAccounts() async throws {
        let a = FakeSynclet(serverId: "srvA")
        let b = FakeSynclet(serverId: "srvB")
        Harness.serve(["a.example.test": a, "b.example.test": b])

        try await harness.accounts.add(server: URL(string: "https://a.example.test")!, tokens: harness.tokens(a))
        try await harness.accounts.add(server: URL(string: "https://b.example.test")!, tokens: harness.tokens(b))

        XCTAssertEqual(harness.accounts.entries.map(\.id), ["srvA:u1", "srvB:u1"])
        XCTAssertEqual(harness.accounts.entries.map(\.title), ["jens@a.example.test", "jens@b.example.test"])
        XCTAssertEqual(Set(harness.domains.current).count, 2)
        XCTAssertEqual(harness.domains.addCalls.map(\.displayName),
                       ["Synclet – jens@a.example.test", "Synclet – jens@b.example.test"])
        XCTAssertEqual(harness.manager.credentials.token(for: "srvA:u1"), "syd_srvA_1")
        XCTAssertEqual(harness.manager.credentials.token(for: "srvB:u1"), "syd_srvB_1")
    }

    func testAuthFailureMarksTheAccountAndReLoginClearsItKeepingTheDomain() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let origin = URL(string: "https://files.example.test")!
        let stored = try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        XCTAssertEqual(harness.accounts.entries.first?.status, .ok)
        XCTAssertFalse(harness.accounts.hasProblem)

        // The extension reports a rejected token.
        XCTAssertTrue(AuthFailureSignal.report(container: harness.accounts.container, key16: stored.key16, post: false))
        harness.accounts.processAuthFailures()
        XCTAssertEqual(harness.accounts.entries.first?.status, .needsLogin)
        XCTAssertTrue(harness.accounts.hasProblem)

        // Signing in again clears the marker, reuses the domain and lifts the `.notAuthenticated`
        // throttling (signalErrorResolved + working set) – once per add.
        try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        XCTAssertEqual(harness.accounts.entries.first?.status, .ok)
        XCTAssertNil(AuthFailureSignal.pending(container: harness.accounts.container, key16: stored.key16))
        XCTAssertEqual(harness.domains.addCalls.count, 1)
        XCTAssertEqual(harness.domains.removeCalls, [])
        XCTAssertEqual(harness.finder.resolvedAuthentication, [stored.key16, stored.key16])
    }

    func testMissingTokenNeedsLogin() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        harness.manager.credentials.delete(for: stored.key)
        harness.accounts.reload()
        XCTAssertEqual(harness.accounts.entries.first?.status, .needsLogin)
    }

    func testSignOutRemovesAccountDomainTokenAndMarker() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        AuthFailureSignal.report(container: harness.accounts.container, key16: stored.key16, post: false)

        await harness.accounts.signOut(key: stored.key)

        XCTAssertTrue(harness.accounts.isEmpty)
        XCTAssertEqual(harness.domains.removeCalls, [stored.key16])
        XCTAssertNil(harness.manager.credentials.token(for: stored.key))
        XCTAssertNil(AuthFailureSignal.pending(container: harness.accounts.container, key16: stored.key16))
        XCTAssertTrue(MockURLProtocol.requests.contains { $0.method == "DELETE" && $0.path == "/api/sync/v1/devices/current" })
    }

    func testPendingChangesForTheSignOutWarning() async {
        harness.finder.pending = nil
        let unknown = await harness.accounts.pendingChanges(key: "srv1:u1")
        XCTAssertEqual(unknown, .unknown)
        harness.finder.pending = 0
        let none = await harness.accounts.pendingChanges(key: "srv1:u1")
        XCTAssertEqual(none, PendingChanges.none)
        harness.finder.pending = 3
        let some = await harness.accounts.pendingChanges(key: "srv1:u1")
        XCTAssertEqual(some, .some(3))
    }

    func testOpenWebOpensTheServer() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        var opened: [URL] = []
        harness.accounts.openURL = { opened.append($0) }
        harness.accounts.openWeb(key: stored.key)
        await harness.accounts.openInFinder(key: stored.key)
        XCTAssertEqual(opened.map(\.absoluteString),
                       ["https://files.example.test", "file:///tmp/CloudStorage/\(stored.key16)"])
    }
}

