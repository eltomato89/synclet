import FileProvider
import SyncletKit
import XCTest
@testable import Synclet

/// Scripted event streams, signals and account answers for a ``ChangeMonitor``.
final class FakeMonitorWorld: @unchecked Sendable {
    private let lock = NSLock()
    private var streams: [AsyncThrowingStream<StreamSignal, Error>.Continuation] = []
    private var signals: [NSFileProviderItemIdentifier] = []
    private var wakeContinuation: AsyncStream<Void>.Continuation?
    var spaces: [SyncSpace] = [SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien", rootId: "root", canWrite: true)]
    private(set) var accountFetches = 0

    var streamCount: Int { lock.withLock { streams.count } }
    var signalled: [NSFileProviderItemIdentifier] { lock.withLock { signals } }
    var workingSetSignals: Int { signalled.filter { $0 == .workingSet }.count }
    var rootSignals: Int { signalled.filter { $0 == .rootContainer }.count }

    /// Sends a signal on the newest stream.
    func send(_ signal: StreamSignal) {
        _ = lock.withLock { streams.last }?.yield(signal)
    }

    func fail(_ error: Error) {
        lock.withLock { streams.last }?.finish(throwing: error)
    }

    func wake() {
        _ = lock.withLock { wakeContinuation }?.yield()
    }

    @MainActor
    func dependencies(storedSpaces: SpacesBox, authFailures: Counter) -> ChangeMonitor.Dependencies {
        ChangeMonitor.Dependencies(
            events: {
                AsyncThrowingStream { continuation in
                    self.lock.withLock { self.streams.append(continuation) }
                }
            },
            signal: { container in self.lock.withLock { self.signals.append(container) } },
            fetchAccount: {
                let spaces = self.lock.withLock { () -> [SyncSpace] in
                    self.accountFetches += 1
                    return self.spaces
                }
                return SyncAccount(userId: "u1", email: nil, displayName: "Jens", organizationId: "srv1:u1",
                                   slug: "jens", cursor: "7", spaces: spaces)
            },
            updateSpaces: { spaces in
                guard storedSpaces.value != spaces else { return false }
                storedSpaces.value = spaces
                return true
            },
            reportAuthFailure: { authFailures.increment() },
            wakeUps: {
                AsyncStream { continuation in self.lock.withLock { self.wakeContinuation = continuation } }
            }
        )
    }
}

@MainActor
final class SpacesBox {
    var value: [SyncSpace]
    init(_ value: [SyncSpace]) { self.value = value }
}

@MainActor
final class Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

/// Polls `condition` until it holds or `timeout` passes.
@MainActor
func eventually(timeout: Duration = .seconds(3), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@MainActor
final class ChangeMonitorTests: XCTestCase {
    private var world: FakeMonitorWorld!
    private var stored: SpacesBox!
    private var authFailures: Counter!

    override func setUp() async throws {
        world = FakeMonitorWorld()
        stored = SpacesBox(world.spaces)
        authFailures = Counter()
    }

    private func monitor(coalesce: Duration = .milliseconds(300), fallback: Duration = .seconds(60),
                         refresh: Duration = .seconds(3600)) -> ChangeMonitor {
        ChangeMonitor(accountKey: "srv1:u1", dependencies: world.dependencies(storedSpaces: stored, authFailures: authFailures),
                      timing: ChangeMonitor.Timing(coalesce: coalesce, fallback: fallback, accountRefresh: refresh))
    }

    func testConnectedAndChangesSignalTheWorkingSet() async throws {
        let monitor = monitor(coalesce: .milliseconds(1))
        monitor.start()
        defer { monitor.stop() }
        XCTAssertEqual(monitor.state, .connecting)
        XCTAssertNil(monitor.lastSync)
        let ready = await eventually { self.world.streamCount == 1 }
        XCTAssertTrue(ready)

        world.send(.connected(cursor: "1"))
        let connected = await eventually { monitor.state == .connected && self.world.workingSetSignals == 1 }
        XCTAssertTrue(connected)
        XCTAssertNotNil(monitor.lastSync)

        try await Task.sleep(for: .milliseconds(20))
        world.send(.changes(space: "personal", cursor: "2"))
        let changed = await eventually { self.world.workingSetSignals == 2 }
        XCTAssertTrue(changed)
    }

    func testSignalsAreCoalescedToOnePer500ms() async throws {
        let monitor = monitor(coalesce: .milliseconds(500))
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }

        let started = ContinuousClock.now
        world.send(.connected(cursor: "1"))
        for index in 0..<10 { world.send(.changes(space: "personal", cursor: "\(index)")) }
        // Leading signal at once …
        let leading = await eventually { self.world.workingSetSignals == 1 }
        XCTAssertTrue(leading)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(world.workingSetSignals, 1, "no second signal inside the window")
        // … and exactly one trailing signal when the window ends.
        let trailing = await eventually { self.world.workingSetSignals == 2 }
        XCTAssertTrue(trailing)
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - started, .milliseconds(450))
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(world.workingSetSignals, 2)
    }

    func testFallbackTimerRunsOnlyWhileDisconnected() async throws {
        let monitor = monitor(coalesce: .milliseconds(1), fallback: .milliseconds(100))
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected }

        // Connected: no polling.
        let afterConnect = world.workingSetSignals
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(world.workingSetSignals, afterConnect)

        // Disconnected: polls every interval.
        world.send(.disconnected(reason: .network(.notConnectedToInternet)))
        let offline = await eventually { monitor.state == .offline }
        XCTAssertTrue(offline)
        let polled = await eventually { self.world.workingSetSignals >= afterConnect + 3 }
        XCTAssertTrue(polled)

        // Connected again: polling stops.
        world.send(.connected(cursor: "2"))
        _ = await eventually { monitor.state == .connected }
        try await Task.sleep(for: .milliseconds(50))
        let reconnected = world.workingSetSignals
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(world.workingSetSignals, reconnected)
    }

    func testFallbackPollingDoesNotCountAsSync() async throws {
        let monitor = monitor(coalesce: .milliseconds(1), fallback: .milliseconds(50))
        monitor.start()
        defer { monitor.stop() }
        let polled = await eventually { self.world.workingSetSignals >= 2 }
        XCTAssertTrue(polled, "the timer also runs while the first connection is pending")
        XCTAssertNil(monitor.lastSync)
    }

    func testSpacesChangeSignalsTheRootContainer() async throws {
        let monitor = monitor(coalesce: .milliseconds(1))
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }

        world.send(.connected(cursor: "1"))
        _ = await eventually { self.world.accountFetches == 1 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(world.rootSignals, 0, "unchanged spaces")

        world.spaces.append(SyncSpace(id: "s1", kind: .shared, name: "Team", rootId: "f1", canWrite: true))
        world.send(.disconnected(reason: .ended))
        world.send(.connected(cursor: "2"))
        let signalled = await eventually { self.world.rootSignals == 1 }
        XCTAssertTrue(signalled)
        XCTAssertEqual(stored.value.map(\.id), ["personal", "s1"])
    }

    func testAccountIsRefreshedPeriodically() async throws {
        let monitor = monitor(refresh: .milliseconds(100))
        monitor.start()
        defer { monitor.stop() }
        world.spaces = []
        let refreshed = await eventually { self.world.rootSignals == 1 }
        XCTAssertTrue(refreshed, "refresh without a connection")
        XCTAssertGreaterThanOrEqual(world.accountFetches, 1)
    }

    func testAuthFailureStopsEverything() async throws {
        let monitor = monitor(coalesce: .milliseconds(1), fallback: .milliseconds(50))
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }

        world.fail(SyncAPIError.deviceRevoked)
        let failed = await eventually { monitor.state == .authFailed }
        XCTAssertTrue(failed)
        XCTAssertEqual(authFailures.value, 1)
        let signals = world.workingSetSignals
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(world.workingSetSignals, signals, "no polling while sign-in is required")

        // Waking does not reconnect a rejected token.
        world.wake()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(world.streamCount, 1)

        // A new sign-in restarts it.
        monitor.restart()
        let restarted = await eventually { self.world.streamCount == 2 && monitor.state == .connecting }
        XCTAssertTrue(restarted)
    }

    func testForbiddenIsAnAuthFailure() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.fail(SyncAPIError.forbidden(message: nil))
        let failed = await eventually { monitor.state == .authFailed }
        XCTAssertTrue(failed)
        XCTAssertEqual(authFailures.value, 1)
    }

    func testWakeReconnectsAtOnceAndSignals() async throws {
        let monitor = monitor(coalesce: .milliseconds(1))
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected }
        try await Task.sleep(for: .milliseconds(20))
        let before = world.workingSetSignals

        world.wake()
        let reconnected = await eventually { self.world.streamCount == 2 }
        XCTAssertTrue(reconnected)
        XCTAssertEqual(monitor.state, .connecting)
        let signalled = await eventually { self.world.workingSetSignals == before + 1 }
        XCTAssertTrue(signalled)

        // Signals of the replaced stream are ignored.
        world.send(.connected(cursor: "2"))
        let connected = await eventually { monitor.state == .connected }
        XCTAssertTrue(connected)
    }

    func testStopEndsTheStreamAndTheTimers() async throws {
        let monitor = monitor(coalesce: .milliseconds(1), fallback: .milliseconds(50))
        monitor.start()
        _ = await eventually { self.world.streamCount == 1 }
        monitor.stop()
        let signals = world.workingSetSignals
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(world.workingSetSignals, signals)
    }
}

@MainActor
final class AccountsMonitoringTests: XCTestCase {
    private var harness: Harness!
    private var created: [String: ChangeMonitor] = [:]
    private var world: FakeMonitorWorld!

    override func setUp() async throws {
        harness = Harness()
        world = FakeMonitorWorld()
        created = [:]
    }

    override func tearDown() async throws {
        harness.accounts.stopMonitoring()
        harness.cleanUp()
    }

    private func startMonitoring() {
        let world = world!
        harness.accounts.startMonitoring { [unowned self] account in
            let monitor = ChangeMonitor(accountKey: account.key,
                                        dependencies: world.dependencies(storedSpaces: SpacesBox([]), authFailures: Counter()))
            created[account.key] = monitor
            return monitor
        }
    }

    func testOneMonitorPerAccountAndSignOutStopsIt() async throws {
        let a = FakeSynclet(serverId: "srvA")
        let b = FakeSynclet(serverId: "srvB")
        Harness.serve(["a.example.test": a, "b.example.test": b])
        try await harness.accounts.add(server: URL(string: "https://a.example.test")!, tokens: harness.tokens(a))
        XCTAssertTrue(harness.accounts.monitors.isEmpty, "no monitors before startMonitoring")

        startMonitoring()
        XCTAssertEqual(Set(harness.accounts.monitors.keys), ["srvA:u1"])
        try await harness.accounts.add(server: URL(string: "https://b.example.test")!, tokens: harness.tokens(b))
        XCTAssertEqual(Set(harness.accounts.monitors.keys), ["srvA:u1", "srvB:u1"])
        let streams = await eventually { self.world.streamCount == 2 }
        XCTAssertTrue(streams)

        await harness.accounts.signOut(key: "srvA:u1")
        XCTAssertEqual(Set(harness.accounts.monitors.keys), ["srvB:u1"])
        XCTAssertNotNil(harness.accounts.monitor(key: "srvB:u1"))
    }

    func testNeedsLoginSuspendsAndReLoginRestarts() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let origin = URL(string: "https://files.example.test")!
        let stored = try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        startMonitoring()
        let monitor = try XCTUnwrap(harness.accounts.monitor(key: stored.key))
        _ = await eventually { self.world.streamCount == 1 }

        AuthFailureSignal.report(container: harness.accounts.container, key16: stored.key16, post: false)
        harness.accounts.processAuthFailures()
        XCTAssertEqual(monitor.state, .authFailed)
        harness.accounts.reload()
        XCTAssertEqual(monitor.state, .authFailed, "a reload never restarts a rejected token")

        try await harness.accounts.add(server: origin, tokens: harness.tokens(server))
        XCTAssertTrue(harness.accounts.monitor(key: stored.key) === monitor, "same monitor kept")
        XCTAssertEqual(monitor.state, .connecting)
        let reconnected = await eventually { self.world.streamCount == 2 }
        XCTAssertTrue(reconnected)
    }
}
