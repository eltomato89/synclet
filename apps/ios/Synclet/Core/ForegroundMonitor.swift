import FileProvider
import Foundation
import Observation
import os
import SyncletKit

/// Live changes of one account while the app is in the foreground (spec §2.4). Ported from
/// the macOS `ChangeMonitor` without the wake-up observation (the app stops all monitors
/// when it leaves the foreground and starts them again when it becomes active).
///
/// Cursors are tracked per space (Phase 4): `hello` carries `cursors` (space id → cursor),
/// `changes` the space it belongs to; a space's cursor is only compared with its own.
///
/// - `.connected` (`hello`): the extension catches up (`.workingSet`); a space whose cursor
///   moved since the last known one also counts as a change (missed while disconnected).
/// - `.changes`: ``onChange`` with the account key (the browser reloads), then `.workingSet`.
///   Both are coalesced: at most one per 500 ms (leading edge plus one trailing call).
/// - `.account` (spaces or rights changed): `GET /account`, changed spaces are stored
///   (``onSpacesChanged``, `.rootContainer`), then ``onChange`` + `.workingSet`.
/// - Stream down (connecting / offline): `GET /account` (personal cursor) plus
///   `GET /cursor?space=` per other space every 60 s; a moved cursor ⇒ ``onChange`` +
///   `.workingSet`.
/// - After `hello`: one `GET /account` refresh; changed spaces are stored and
///   `.rootContainer` is signalled. The server is reachable again ⇒
///   ``Dependencies/resolveErrors`` once per connection.
/// - 401/403 ⇒ ``State/authFailed``, ``Dependencies/reportAuthFailure``; nothing runs until
///   ``restart()`` (signed in again).
@MainActor
@Observable
final class ForegroundMonitor {
    enum State: Equatable, Sendable {
        case connecting
        case connected
        case offline
        case authFailed
    }

    /// Everything the monitor touches outside itself (replaced in tests).
    struct Dependencies {
        /// A fresh event stream (one per (re)connect); it reconnects by itself and only ends
        /// on a rejected token or cancellation.
        var events: @Sendable () -> AsyncThrowingStream<StreamSignal, Error>
        /// `NSFileProviderManager(for: domain).signalEnumerator(for:)`.
        var signal: @Sendable (NSFileProviderItemIdentifier) async -> Void
        /// `GET /account` (cursor and spaces).
        var fetchAccount: @Sendable () async throws -> SyncAccount
        /// `GET /cursor?space=<id>` (polling of the spaces other than `personal`).
        var fetchCursor: @Sendable (String) async throws -> String = { _ in throw CancellationError() }
        /// Stores the spaces; `true` when they changed.
        var updateSpaces: @MainActor ([SyncSpace]) -> Bool
        /// The stream ended with 401/403 (write the marker, update the account list).
        var reportAuthFailure: @MainActor () -> Void
        /// Waits between two polls (a manual clock in tests).
        var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
        /// Lifts the system's throttling of `.serverUnreachable` / `.insufficientQuota` items.
        var resolveErrors: @Sendable () async -> Void = {}
    }

    struct Timing {
        /// Minimum distance of two change notifications / working-set signals.
        var coalesce: Duration = .milliseconds(500)
        /// Polling interval while the stream is down.
        var poll: Duration = .seconds(60)
        /// First delay before reopening a stream that ended by itself (doubles up to `reconnectMax`).
        var reconnectBase: Duration = .seconds(1)
        var reconnectMax: Duration = .seconds(60)
    }

    private(set) var state: State = .connecting
    let accountKey: String
    /// Called with ``accountKey`` when something changed on the server (before the working
    /// set is signalled). Set by ``AccountsModel``.
    @ObservationIgnored var onChange: @MainActor (String) -> Void = { _ in }
    /// Called after the stored spaces changed (SSE `account`, refresh after `hello`); the
    /// account list reloads them. Set by ``AccountsModel``.
    @ObservationIgnored var onSpacesChanged: @MainActor () -> Void = {}

    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private var isRunning = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var accountTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var trailingSignal: Task<Void, Never>?
    @ObservationIgnored private var reconnectAttempt = 0
    /// Last cursor seen per space id (hello, changes, poll); empty until the first one.
    @ObservationIgnored private var lastCursors: [String: String] = [:]
    @ObservationIgnored private var hasCursors = false
    @ObservationIgnored private var lastSignal: ContinuousClock.Instant?
    /// A change is waiting for the trailing signal (its `onChange` is still due).
    @ObservationIgnored private var trailingIsChange = false
    /// Identifies the current stream task (an old task's late signals are ignored).
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var resolvedThisConnection = false

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "changes")

    init(accountKey: String, dependencies: Dependencies, timing: Timing = Timing()) {
        self.accountKey = accountKey
        self.dependencies = dependencies
        self.timing = timing
    }

    // MARK: - Lifecycle

    /// Opens the stream (idempotent). Polling runs while it is not connected.
    func start() {
        guard !isRunning else { return }
        isRunning = true
        connect()
    }

    /// Stops everything (app in the background, sign-out).
    func stop() {
        isRunning = false
        generation += 1
        for task in [streamTask, pollTask, accountTask, reconnectTask, trailingSignal] { task?.cancel() }
        streamTask = nil
        pollTask = nil
        accountTask = nil
        reconnectTask = nil
        trailingSignal = nil
        trailingIsChange = false
    }

    /// Reconnects at once (new token after a sign-in), also out of `.authFailed`.
    func restart() {
        if isRunning {
            connect()
        } else {
            start()
        }
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
        case .connected(let cursor, let cursors):
            reconnectAttempt = 0
            setState(.connected)
            // Servers before Phase 4 send only the personal cursor.
            var all = cursors
            if all[Self.personal] == nil { all[Self.personal] = cursor }
            let moved = advance(to: all, complete: true)
            notify(change: moved)
            if !resolvedThisConnection {
                resolvedThisConnection = true
                let resolve = dependencies.resolveErrors
                Task { await resolve() }
            }
            accountTask?.cancel()
            accountTask = Task { [weak self] in await self?.refreshSpaces() }
        case .changes(let space, let cursor):
            if state != .connected { setState(.connected) }
            _ = advance(to: [space: cursor], complete: false)
            notify(change: true)
        case .account:
            // The spaces or rights changed: reload them first (account list, root container),
            // then let the browser and the extension catch up.
            if state != .connected { setState(.connected) }
            accountTask?.cancel()
            accountTask = Task { [weak self] in
                await self?.refreshSpaces()
                guard !Task.isCancelled, let self, self.isRunning, self.state != .authFailed else { return }
                self.notify(change: true)
            }
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

    private func setState(_ newState: State) {
        if state != newState { state = newState }
        if newState != .connected { resolvedThisConnection = false }
        // Polling runs exactly while the stream is down (and the sign-in is fine).
        let wantsPolling = isRunning && (newState == .connecting || newState == .offline)
        if wantsPolling, pollTask == nil {
            let interval = timing.poll
            let sleep = dependencies.sleep
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await sleep(interval) } catch { return }
                    guard !Task.isCancelled, let self else { return }
                    await self.poll()
                }
            }
        } else if !wantsPolling {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: - Polling

    /// `GET /account` (the personal cursor) and the cursor of every other available space;
    /// a moved cursor is a change.
    private func poll() async {
        do {
            let account = try await dependencies.fetchAccount()
            var cursors = [Self.personal: account.cursor]
            for space in account.spaces where space.id != Self.personal && space.isAvailable {
                if let cursor = try? await dependencies.fetchCursor(space.id) { cursors[space.id] = cursor }
            }
            guard isRunning, state != .authFailed, state != .connected, !Task.isCancelled else { return }
            if advance(to: cursors, complete: false) { notify(change: true) }
        } catch {
            Self.log.debug("poll failed: \(String(describing: error), privacy: .public)")
        }
    }

    private static let personal = SyncAPIClient.personalSpaceID

    /// Records the cursors of the spaces in `cursors`; `true` when a known cursor of the same
    /// space moved. `complete` (a `hello`) replaces the whole map: a space that appeared or
    /// went away since the last `hello` also counts as a change.
    private func advance(to cursors: [String: String], complete: Bool) -> Bool {
        let known = hasCursors
        let previous = lastCursors
        hasCursors = true
        if complete {
            lastCursors = cursors
        } else {
            lastCursors.merge(cursors) { _, new in new }
        }
        guard known else { return false }
        if cursors.contains(where: { space, cursor in previous[space].map { $0 != cursor } ?? false }) { return true }
        return complete && Set(cursors.keys) != Set(previous.keys)
    }

    /// `GET /account` (after `hello`, on `account`): changed spaces ⇒ ``onSpacesChanged``
    /// and the root container.
    private func refreshSpaces() async {
        do {
            let account = try await dependencies.fetchAccount()
            guard isRunning, state != .authFailed, !Task.isCancelled else { return }
            if dependencies.updateSpaces(account.spaces) {
                Self.log.info("spaces changed: signalling the root container")
                onSpacesChanged()
                await dependencies.signal(.rootContainer)
            }
        } catch {
            Self.log.debug("account refresh failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Signals

    /// `onChange` (when `change`) and the working set, at most once per `coalesce`.
    private func notify(change: Bool) {
        let now = ContinuousClock.now
        if let last = lastSignal, now < last + timing.coalesce {
            trailingIsChange = trailingIsChange || change
            guard trailingSignal == nil else { return }
            let due = last + timing.coalesce
            trailingSignal = Task { [weak self] in
                try? await Task.sleep(until: due, clock: .continuous)
                guard !Task.isCancelled, let self else { return }
                self.trailingSignal = nil
                let pending = self.trailingIsChange
                self.trailingIsChange = false
                self.fire(change: pending)
            }
            return
        }
        fire(change: change)
    }

    private func fire(change: Bool) {
        lastSignal = ContinuousClock.now
        if change { onChange(accountKey) }
        let signal = dependencies.signal
        Task { await signal(.workingSet) }
    }
}

// MARK: - Production

extension ForegroundMonitor {
    /// Session of the event streams (no cache, fails fast while offline).
    private static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// The monitor of a stored account, wired to the system (`NSFileProviderManager`, keychain).
    static func live(account: StoredAccount, manager: AccountManager, resolver: FileProviderResolving,
                     domains: FileProviderDomainControlling = SystemFileProviderDomains(),
                     onAuthFailure: @escaping @MainActor () -> Void) -> ForegroundMonitor {
        let key = account.key
        let key16 = account.key16
        let container = manager.accounts.directory
        let credentials = manager.credentials
        let stream = EventStream(url: EventStream.url(origin: account.serverURL), token: {
            guard let token = credentials.token(for: key) else { throw SyncAPIError.unauthorized(message: "no device token") }
            return token
        }, session: streamSession)
        let dependencies = Dependencies(
            events: { stream.events() },
            signal: { item in await domains.signalEnumerator(domainIdentifier: key16, container: item) },
            fetchAccount: {
                guard let client = manager.client(for: key) else { throw SyncAPIError.unauthorized(message: "account removed") }
                return try await client.account()
            },
            fetchCursor: { space in
                guard let client = manager.client(for: key) else { throw SyncAPIError.unauthorized(message: "account removed") }
                return try await client.cursor(space: space)
            },
            updateSpaces: { spaces in (try? manager.updateSpaces(key: key, spaces: spaces)) ?? false },
            reportAuthFailure: {
                AuthFailureSignal.report(container: container, key16: key16, post: false)
                onAuthFailure()
            },
            resolveErrors: { await resolver.resolveTransientErrors(domain: manager.domain(for: key)) }
        )
        return ForegroundMonitor(accountKey: key, dependencies: dependencies)
    }
}
