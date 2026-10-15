import AppKit
import FileProvider
import Foundation
import Network
import Observation
import os
import SyncletKit

/// Live changes of one account (spec §2.4): holds the account's SSE stream
/// (`GET /sync/v1/events`) and lets the File Provider extension drain `/changes` by
/// signalling the working set.
///
/// - `.connected` / `.changes` → signal `.workingSet` (coalesced: at most one per 500 ms).
/// - Not connected → signal `.workingSet` every 60 s (fallback polling).
/// - Network path becomes satisfied, or the Mac wakes → reconnect at once and signal.
/// - On every `.connected` and every 15 min → `GET /account`; changed `spaces` are stored
///   and `.rootContainer` is signalled.
/// - 401/403 → ``State/authFailed``, the auth-failure marker is written, the stream stops.
///
/// Owned by ``AccountsModel`` (one per account). The state feeds the menu (T8).
@MainActor
@Observable
final class ChangeMonitor {
    enum State: Equatable, Sendable {
        /// Opening the stream (start, reconnect after wake / network change).
        case connecting
        /// The stream is open (`hello` received).
        case connected
        /// The stream is down; it reconnects with backoff and the fallback timer polls.
        case offline
        /// The server rejected the device token – sign in again (nothing runs).
        case authFailed
    }

    /// Everything the monitor touches outside itself (replaced in tests).
    struct Dependencies {
        /// A fresh event stream (one per (re)connect).
        var events: @Sendable () -> AsyncThrowingStream<StreamSignal, Error>
        /// `NSFileProviderManager(for: domain).signalEnumerator(for:)`.
        var signal: @Sendable (NSFileProviderItemIdentifier) async -> Void
        /// `GET /account`.
        var fetchAccount: @Sendable () async throws -> SyncAccount
        /// Stores the spaces; `true` when they changed.
        var updateSpaces: @MainActor ([SyncSpace]) -> Bool
        /// The stream ended with 401/403 (write the marker, update the account list).
        var reportAuthFailure: @MainActor () -> Void
        /// Fires when the network path becomes satisfied or the Mac wakes.
        var wakeUps: @Sendable () -> AsyncStream<Void>
        var now: @Sendable () -> Date = { Date() }
    }

    struct Timing {
        /// Minimum distance of two working-set signals.
        var coalesce: Duration = .milliseconds(500)
        /// Polling interval while the stream is not connected.
        var fallback: Duration = .seconds(60)
        /// `GET /account` interval (spaces).
        var accountRefresh: Duration = .seconds(15 * 60)
        /// First delay before reopening a stream that ended by itself (doubles up to `reconnectMax`).
        var reconnectBase: Duration = .seconds(1)
        var reconnectMax: Duration = .seconds(60)
    }

    private(set) var state: State = .connecting
    /// Last time the working set was signalled because of the open stream (`hello` /
    /// `changes`), i.e. the extension was told to catch up with a reachable server.
    private(set) var lastSync: Date?

    let accountKey: String
    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private var isRunning = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var fallbackTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var wakeTask: Task<Void, Never>?
    @ObservationIgnored private var trailingSignal: Task<Void, Never>?
    /// One-shot `/account` refresh after `hello`.
    @ObservationIgnored private var accountTask: Task<Void, Never>?
    /// Reopens a stream that ended by itself.
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectAttempt = 0
    @ObservationIgnored private var lastWorkingSetSignal: ContinuousClock.Instant?
    /// Identifies the current stream task (an old task's late signals are ignored).
    @ObservationIgnored private var generation = 0

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "changes")

    init(accountKey: String, dependencies: Dependencies, timing: Timing = Timing()) {
        self.accountKey = accountKey
        self.dependencies = dependencies
        self.timing = timing
    }

    // MARK: - Lifecycle

    /// Opens the stream and starts the timers and the wake-up observation (idempotent).
    func start() {
        guard !isRunning else { return }
        isRunning = true
        let wakeUps = dependencies.wakeUps
        wakeTask = Task { [weak self] in
            for await _ in wakeUps() {
                guard let self else { return }
                self.wake()
            }
        }
        refreshTask = Task { [weak self, timing] in
            while !Task.isCancelled {
                try? await Task.sleep(for: timing.accountRefresh)
                guard !Task.isCancelled, let self else { return }
                if self.state != .authFailed { await self.refreshAccount() }
            }
        }
        connect()
    }

    /// Stops everything (sign-out, app end).
    func stop() {
        isRunning = false
        generation += 1
        for task in [streamTask, fallbackTask, refreshTask, wakeTask, trailingSignal, accountTask, reconnectTask] {
            task?.cancel()
        }
        accountTask = nil
        reconnectTask = nil
        streamTask = nil
        fallbackTask = nil
        refreshTask = nil
        wakeTask = nil
        trailingSignal = nil
    }

    /// Reconnects at once (new token after a sign-in, network change, wake) and signals.
    func restart() {
        if !isRunning {
            start()
        } else {
            connect()
        }
        signalWorkingSet()
    }

    /// The account needs a new sign-in: nothing runs until ``restart()``.
    func suspendForSignIn() {
        streamTask?.cancel()
        streamTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        generation += 1
        setState(.authFailed)
    }

    // MARK: - Stream

    private func connect() {
        streamTask?.cancel()
        reconnectTask?.cancel()
        reconnectTask = nil
        generation += 1
        let current = generation
        setState(.connecting)
        let events = dependencies.events
        streamTask = Task { [weak self] in
            do {
                for try await signal in events() {
                    guard let self, self.generation == current else { return }
                    self.handle(signal)
                }
                // Ended without an error and without our cancellation (e.g. a system cancel).
                guard !Task.isCancelled, let self, self.generation == current else { return }
                self.streamEnded("stream finished")
            } catch {
                guard !Task.isCancelled, let self, self.generation == current else { return }
                self.streamFailed(error)
            }
        }
    }

    private func handle(_ signal: StreamSignal) {
        switch signal {
        case .connected:
            reconnectAttempt = 0
            setState(.connected)
            signalWorkingSet()
            accountTask?.cancel()
            accountTask = Task { [weak self] in await self?.refreshAccount() }
        case .changes:
            if state != .connected { setState(.connected) }
            signalWorkingSet()
        case .disconnected(let reason):
            Self.log.debug("stream disconnected: \(String(describing: reason), privacy: .public)")
            setState(.offline)
        }
    }

    private func streamFailed(_ error: Error) {
        let isAuth: Bool
        if let apiError = error as? SyncAPIError {
            if case .forbidden = apiError { isAuth = true } else { isAuth = apiError.isAuthenticationFailure }
        } else {
            isAuth = false
        }
        if isAuth {
            Self.log.notice("event stream: device token rejected")
            suspendForSignIn()
            dependencies.reportAuthFailure()
        } else {
            streamEnded(String(describing: error))
        }
    }

    /// The stream ended although nobody stopped it: poll while offline and reopen it with
    /// backoff (1, 2, 4 … 60 s; reset by the next `hello`).
    private func streamEnded(_ why: String) {
        Self.log.error("event stream ended: \(why, privacy: .public); reconnecting")
        streamTask = nil
        generation += 1
        setState(.offline)
        let exponent = min(reconnectAttempt, 16)
        reconnectAttempt += 1
        let delay = min(timing.reconnectMax, timing.reconnectBase * (1 << exponent))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.isRunning, self.state == .offline else { return }
            self.reconnectTask = nil
            self.connect()
        }
    }

    private func wake() {
        guard isRunning, state != .authFailed else { return }
        Self.log.info("network or wake: reconnecting")
        restart()
    }

    private func setState(_ newState: State) {
        if state != newState { state = newState }
        // Fallback polling runs exactly while the stream is not connected (and sign-in is fine).
        let wantsFallback = isRunning && (newState == .connecting || newState == .offline)
        if wantsFallback, fallbackTask == nil {
            let interval = timing.fallback
            fallbackTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: interval)
                    guard !Task.isCancelled, let self else { return }
                    self.signalWorkingSet()
                }
            }
        } else if !wantsFallback {
            fallbackTask?.cancel()
            fallbackTask = nil
        }
    }

    // MARK: - Signals

    /// Signals `.workingSet`, at most once per `coalesce` (leading edge plus one trailing signal).
    private func signalWorkingSet() {
        let now = ContinuousClock.now
        if let last = lastWorkingSetSignal, now < last + timing.coalesce {
            guard trailingSignal == nil else { return }
            let due = last + timing.coalesce
            trailingSignal = Task { [weak self] in
                try? await Task.sleep(until: due, clock: .continuous)
                guard !Task.isCancelled, let self else { return }
                self.trailingSignal = nil
                self.fireWorkingSet()
            }
            return
        }
        fireWorkingSet()
    }

    private func fireWorkingSet() {
        lastWorkingSetSignal = ContinuousClock.now
        if state == .connected { lastSync = dependencies.now() }
        let signal = dependencies.signal
        Task { await signal(.workingSet) }
    }

    /// `GET /account`; changed spaces are stored and the root container is signalled.
    private func refreshAccount() async {
        do {
            let account = try await dependencies.fetchAccount()
            // Stopped (signed out) or rejected meanwhile: do not touch the account any more.
            guard isRunning, state != .authFailed, !Task.isCancelled else { return }
            if dependencies.updateSpaces(account.spaces) {
                Self.log.info("spaces changed: signalling the root container")
                await dependencies.signal(.rootContainer)
            }
        } catch {
            Self.log.debug("account refresh failed: \(String(describing: error), privacy: .public)")
        }
    }
}

// MARK: - Production

extension ChangeMonitor {
    /// Session of the event streams (no cache, fails fast while offline).
    private static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// The monitor of a stored account, wired to the system (`NSFileProviderManager`,
    /// keychain, `NWPathMonitor`, `NSWorkspace`).
    static func live(account: StoredAccount, manager: AccountManager, container: URL,
                     onAuthFailure: @escaping @MainActor () -> Void) -> ChangeMonitor {
        let key = account.key
        let key16 = account.key16
        let credentials = manager.credentials
        let stream = EventStream(url: EventStream.url(origin: account.serverURL), token: {
            guard let token = credentials.token(for: key) else { throw SyncAPIError.unauthorized(message: "no device token") }
            return token
        }, session: streamSession)
        let domains = SystemFileProviderDomains()
        let dependencies = Dependencies(
            events: { stream.events() },
            signal: { container in await domains.signalEnumerator(domainIdentifier: key16, container: container) },
            fetchAccount: {
                guard let client = manager.client(for: key) else { throw SyncAPIError.unauthorized(message: "account removed") }
                return try await client.account()
            },
            updateSpaces: { spaces in (try? manager.updateSpaces(key: key, spaces: spaces)) ?? false },
            reportAuthFailure: {
                AuthFailureSignal.report(container: container, key16: key16, post: false)
                onAuthFailure()
            },
            wakeUps: { SystemWakeUps.stream() }
        )
        return ChangeMonitor(accountKey: key, dependencies: dependencies)
    }
}

/// Network path becomes satisfied (or switches interface) / `NSWorkspace.didWakeNotification`.
enum SystemWakeUps {
    static func stream() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let monitor = NWPathMonitor()
            let last = PathState()
            monitor.pathUpdateHandler = { path in
                if last.update(path) { continuation.yield() }
            }
            monitor.start(queue: DispatchQueue(label: "tech.jensk.synclet.path"))
            let center = NSWorkspace.shared.notificationCenter
            let observer = ObserverToken(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                            queue: nil) { _ in continuation.yield() })
            continuation.onTermination = { _ in
                monitor.cancel()
                center.removeObserver(observer.token)
            }
        }
    }

    /// Remembers the previous path; `update` is `true` when the path became satisfied or
    /// its primary interface changed while satisfied. The first update only records.
    private final class PathState: @unchecked Sendable {
        private let lock = NSLock()
        private var satisfied: Bool?
        private var interface: String?

        func update(_ path: NWPath) -> Bool {
            let isSatisfied = path.status == .satisfied
            let primary = path.availableInterfaces.first?.name
            return lock.withLock {
                defer {
                    satisfied = isSatisfied
                    interface = primary
                }
                guard let wasSatisfied = satisfied, isSatisfied else { return false }
                return !wasSatisfied || primary != interface
            }
        }
    }

    private final class ObserverToken: @unchecked Sendable {
        let token: NSObjectProtocol
        init(_ token: NSObjectProtocol) { self.token = token }
    }
}

extension ChangeMonitor: AccountStatusProviding {
    /// The menu's view of the monitor's connection state.
    var connectionState: SyncConnectionState {
        switch state {
        case .connecting: .connecting
        case .connected: .connected
        case .offline: .offline
        case .authFailed: .authFailed
        }
    }
}
