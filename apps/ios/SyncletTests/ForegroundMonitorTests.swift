import FileProvider
import SyncletKit
import XCTest
@testable import Synclet

/// A sleeper the test advances by hand (the 60 s polling interval without waiting).
final class ManualSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [(id: UUID, continuation: CheckedContinuation<Void, Error>)] = []
    private var durations: [Duration] = []

    /// Durations of every `sleep` call so far.
    var requested: [Duration] { lock.withLock { durations } }
    /// Sleeps currently waiting.
    var pending: Int { lock.withLock { waiters.count } }

    func sleep(_ duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.withLock {
                    durations.append(duration)
                    waiters.append((id, continuation))
                }
            }
        } onCancel: {
            let waiter = lock.withLock { () -> CheckedContinuation<Void, Error>? in
                guard let index = waiters.firstIndex(where: { $0.id == id }) else { return nil }
                return waiters.remove(at: index).continuation
            }
            waiter?.resume(throwing: CancellationError())
        }
    }

    /// Ends the oldest pending sleep.
    func fire() {
        let waiter = lock.withLock { waiters.isEmpty ? nil : waiters.removeFirst() }
        waiter?.continuation.resume()
    }
}

/// Scripted event streams, signals and account answers for a ``ForegroundMonitor``.
final class FakeMonitorWorld: @unchecked Sendable {
    private let lock = NSLock()
    private var streams: [AsyncThrowingStream<StreamSignal, Error>.Continuation] = []
    private var terminated: Set<Int> = []
    private var log: [String] = []
    private var fetches = 0
    private var authFailures = 0
    /// Cursor `GET /account` answers with.
    var cursor = "7"
    var spaces: [SyncSpace] = [SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien", rootId: "root", canWrite: true)]
    /// Cursors of the other spaces (`GET /cursor?space=`).
    var spaceCursors: [String: String] = [:]
    /// What `updateSpaces` answers (`true` = the spaces changed).
    var spacesChange = false
    private var updates: [[SyncSpace]] = []
    let sleeper = ManualSleeper()

    /// Every list handed to `updateSpaces`.
    var updatedSpaces: [[SyncSpace]] { lock.withLock { updates } }

    var streamCount: Int { lock.withLock { streams.count } }
    var terminatedStreams: Set<Int> { lock.withLock { terminated } }
    /// `change:<key>` (onChange) and `signal:<container>` entries in call order.
    var events: [String] { lock.withLock { log } }
    var accountFetches: Int { lock.withLock { fetches } }
    var authFailureReports: Int { lock.withLock { authFailures } }

    func record(_ entry: String) { lock.withLock { log.append(entry) } }

    /// Sends a signal on the newest stream.
    func send(_ signal: StreamSignal) {
        _ = lock.withLock { streams.last }?.yield(signal)
    }

    func fail(_ error: Error) {
        lock.withLock { streams.last }?.finish(throwing: error)
    }

    @MainActor
    func dependencies() -> ForegroundMonitor.Dependencies {
        ForegroundMonitor.Dependencies(
            events: {
                AsyncThrowingStream { continuation in
                    let index = self.lock.withLock { () -> Int in
                        self.streams.append(continuation)
                        return self.streams.count - 1
                    }
                    continuation.onTermination = { _ in _ = self.lock.withLock { self.terminated.insert(index) } }
                }
            },
            signal: { container in self.record("signal:\(container.rawValue)") },
            fetchAccount: {
                let (cursor, spaces) = self.lock.withLock { () -> (String, [SyncSpace]) in
                    self.fetches += 1
                    return (self.cursor, self.spaces)
                }
                return SyncAccount(userId: "u1", email: nil, displayName: "Jens", organizationId: "srv1:u1",
                                   slug: "jens", cursor: cursor, spaces: spaces)
            },
            fetchCursor: { space in
                guard let cursor = self.lock.withLock({ self.spaceCursors[space] }) else { throw SyncAPIError.notFound }
                return cursor
            },
            updateSpaces: { spaces in
                self.lock.withLock {
                    self.updates.append(spaces)
                    return self.spacesChange
                }
            },
            reportAuthFailure: { self.lock.withLock { self.authFailures += 1 } },
            sleep: { duration in try await self.sleeper.sleep(duration) }
        )
    }
}

@MainActor
final class ForegroundMonitorTests: XCTestCase {
    private var world: FakeMonitorWorld!

    override func setUp() async throws {
        world = FakeMonitorWorld()
    }

    private func monitor() -> ForegroundMonitor {
        let monitor = ForegroundMonitor(accountKey: "srv1:u1", dependencies: world.dependencies(),
                                        timing: ForegroundMonitor.Timing(coalesce: .milliseconds(1),
                                                                         reconnectBase: .milliseconds(20)))
        monitor.onChange = { [world] key in world?.record("change:\(key)") }
        monitor.onSpacesChanged = { [world] in world?.record("spaces-changed") }
        return monitor
    }

    private var working: String { "signal:\(NSFileProviderItemIdentifier.workingSet.rawValue)" }
    private var rootSignal: String { "signal:\(NSFileProviderItemIdentifier.rootContainer.rawValue)" }
    private var changeCount: Int { world.events.filter { $0.hasPrefix("change:") }.count }

    private let team = SyncSpace(id: "s1", kind: .shared, name: "Team", rootId: "r_s1", canWrite: true)

    // MARK: - Spaces (Phase 4)

    func testCursorsAreTrackedPerSpace() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1", cursors: ["personal": "1", "s1": "5"]))
        _ = await eventually { monitor.state == .connected }

        world.send(.changes(space: "s1", cursor: "9"))
        let changed = await eventually { self.changeCount == 1 }
        XCTAssertTrue(changed)

        // Reconnect: nothing moved. The team cursor is never compared with the personal one.
        world.send(.disconnected(reason: .ended))
        _ = await eventually { monitor.state == .offline }
        world.send(.connected(cursor: "1", cursors: ["personal": "1", "s1": "9"]))
        _ = await eventually { monitor.state == .connected }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(changeCount, 1, "same cursors per space: nothing new")

        // The team space moved while disconnected.
        world.send(.disconnected(reason: .ended))
        _ = await eventually { monitor.state == .offline }
        world.send(.connected(cursor: "1", cursors: ["personal": "1", "s1": "10"]))
        let moved = await eventually { self.changeCount == 2 }
        XCTAssertTrue(moved, "a moved team cursor counts as a change")
    }

    func testPollingComparesTheCursorOfEverySpace() async throws {
        world.spaces = [world.spaces[0], team]
        world.spaceCursors = ["s1": "5"]
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "7", cursors: ["personal": "7", "s1": "5"]))
        _ = await eventually { monitor.state == .connected && self.world.accountFetches == 1 }
        world.send(.disconnected(reason: .network(.notConnectedToInternet)))
        _ = await eventually { monitor.state == .offline && self.world.sleeper.pending == 1 }

        world.sleeper.fire()
        _ = await eventually { self.world.accountFetches == 2 && self.world.sleeper.pending == 1 }
        XCTAssertEqual(changeCount, 0, "nothing moved")

        world.spaceCursors = ["s1": "6"]
        world.sleeper.fire()
        let changed = await eventually { self.changeCount == 1 }
        XCTAssertTrue(changed, "the team space moved while the stream was down")
    }

    func testAccountEventRefreshesTheSpacesThenSignals() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected && self.world.accountFetches == 1 }
        _ = await eventually { self.world.events == [self.working] }

        world.spaces = [world.spaces[0], team]
        world.spacesChange = true
        world.send(.account)

        let done = await eventually { self.world.events.count == 5 }
        XCTAssertTrue(done, "\(world.events)")
        XCTAssertEqual(world.accountFetches, 2)
        XCTAssertEqual(world.updatedSpaces.last?.map(\.id), ["personal", "s1"])
        XCTAssertEqual(Array(world.events.dropFirst()),
                       ["spaces-changed", rootSignal, "change:srv1:u1", working],
                       "account list first, then the browser and the working set")
    }

    func testAccountEventWithoutChangedSpacesStillSignalsTheWorkingSet() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected && self.world.accountFetches == 1 }
        _ = await eventually { self.world.events == [self.working] }

        world.send(.account)
        let done = await eventually { self.world.events.count == 3 }
        XCTAssertTrue(done)
        XCTAssertEqual(world.accountFetches, 2)
        XCTAssertEqual(Array(world.events.dropFirst()), ["change:srv1:u1", working])
    }

    func testSSEChangesCallOnChangeThenSignalTheWorkingSet() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }

        world.send(.connected(cursor: "1"))
        let connected = await eventually { monitor.state == .connected && self.world.events == [self.working] }
        XCTAssertTrue(connected, "hello signals the working set; nothing changed yet")

        world.send(.changes(space: "personal", cursor: "2"))
        let changed = await eventually { self.world.events.count == 3 }
        XCTAssertTrue(changed)
        XCTAssertEqual(world.events, [working, "change:srv1:u1", working])
    }

    func testReconnectWithAMovedCursorReportsAChange() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected }
        world.send(.disconnected(reason: .ended))
        _ = await eventually { monitor.state == .offline }
        world.send(.connected(cursor: "1"))
        _ = await eventually { monitor.state == .connected }
        XCTAssertFalse(world.events.contains("change:srv1:u1"), "same cursor: nothing new")

        world.send(.disconnected(reason: .ended))
        _ = await eventually { monitor.state == .offline }
        world.send(.connected(cursor: "5"))
        let changed = await eventually { self.world.events.contains("change:srv1:u1") }
        XCTAssertTrue(changed)
    }

    func testStreamDownPollsEvery60SecondsAndReportsMovedCursors() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.send(.connected(cursor: "7"))
        _ = await eventually { monitor.state == .connected && self.world.accountFetches == 1 }
        let fetchesWhileConnected = world.accountFetches
        let baseline = world.events

        world.send(.disconnected(reason: .network(.notConnectedToInternet)))
        let polling = await eventually { monitor.state == .offline && self.world.sleeper.pending == 1 }
        XCTAssertTrue(polling)
        XCTAssertEqual(world.sleeper.requested.last, .seconds(60))

        // Same cursor: polled, nothing reported.
        world.sleeper.fire()
        _ = await eventually { self.world.accountFetches == fetchesWhileConnected + 1 && self.world.sleeper.pending == 1 }
        XCTAssertEqual(world.accountFetches, fetchesWhileConnected + 1)
        XCTAssertEqual(world.events, baseline)

        // The cursor moved: onChange, then the working set.
        world.cursor = "8"
        world.sleeper.fire()
        let changed = await eventually { self.world.events.count == baseline.count + 2 }
        XCTAssertTrue(changed)
        XCTAssertEqual(Array(world.events.suffix(2)), ["change:srv1:u1", working])
        _ = await eventually { self.world.sleeper.pending == 1 }
        XCTAssertEqual(world.sleeper.requested.suffix(3), [.seconds(60), .seconds(60), .seconds(60)])

        // Unchanged again: no second report.
        world.sleeper.fire()
        _ = await eventually { self.world.accountFetches == fetchesWhileConnected + 3 && self.world.sleeper.pending == 1 }
        XCTAssertEqual(world.events.filter { $0.hasPrefix("change:") }.count, 1)

        // The stream is back: polling stops.
        world.send(.connected(cursor: "8"))
        let stopped = await eventually { monitor.state == .connected && self.world.sleeper.pending == 0 }
        XCTAssertTrue(stopped)
    }

    func testStopCancelsStreamAndPolling() async throws {
        let monitor = monitor()
        monitor.start()
        _ = await eventually { self.world.streamCount == 1 && self.world.sleeper.pending == 1 }
        XCTAssertEqual(world.sleeper.pending, 1, "polls while connecting")

        monitor.stop()
        let cancelled = await eventually { self.world.terminatedStreams.contains(0) && self.world.sleeper.pending == 0 }
        XCTAssertTrue(cancelled)
        let before = world.events
        world.send(.changes(space: "personal", cursor: "9"))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(world.events, before)
        XCTAssertEqual(world.streamCount, 1, "no reconnect after stop")

        // Starting again (app back in the foreground) opens a new stream.
        monitor.start()
        defer { monitor.stop() }
        let reopened = await eventually { self.world.streamCount == 2 }
        XCTAssertTrue(reopened)
    }

    func testRejectedTokenStopsAndReportsTheAuthFailure() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.fail(SyncAPIError.unauthorized(message: "device revoked"))
        let failed = await eventually { monitor.state == .authFailed }
        XCTAssertTrue(failed)
        XCTAssertEqual(world.authFailureReports, 1)
        let idle = await eventually { self.world.sleeper.pending == 0 }
        XCTAssertTrue(idle, "no polling while the sign-in is rejected")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(world.streamCount, 1, "no reconnect with a rejected token")
    }

    func testUnexpectedStreamErrorReconnects() async throws {
        let monitor = monitor()
        monitor.start()
        defer { monitor.stop() }
        _ = await eventually { self.world.streamCount == 1 }
        world.fail(URLError(.networkConnectionLost))
        let reopened = await eventually { self.world.streamCount == 2 }
        XCTAssertTrue(reopened)
        XCTAssertEqual(world.authFailureReports, 0)
    }
}
