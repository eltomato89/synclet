import Foundation
import os

/// What ``EventStream`` reports to its consumer (SYNC_API.md §5a).
public enum StreamSignal: Sendable, Hashable {
    /// The stream is open (`hello`); `cursor` is the head of the personal space, `cursors`
    /// the head of every space (space id → cursor; empty on servers before Phase 4). Drain
    /// `/changes` now.
    case connected(cursor: String, cursors: [String: String] = [:])
    /// New journal entries were committed in `space` (`changes`). Drain `/changes`.
    case changes(space: String, cursor: String)
    /// The user's spaces or rights changed (`account`): reload `/account`.
    case account
    /// The connection ended or could not be opened; the stream reconnects by itself.
    case disconnected(reason: StreamDisconnectReason)
}

/// Why a connection ended (for logs and the menu; the stream reconnects in every case).
public enum StreamDisconnectReason: Sendable, Hashable {
    /// The server ended the stream with `bye` (`too_many_streams`, `unauthorized`,
    /// `server_shutdown` or any other reason).
    case bye(String)
    /// The server closed the stream without `bye`.
    case ended
    /// Nothing (no event, no ping) arrived for the idle timeout.
    case idleTimeout
    /// Network error (offline, connection refused, timeout …).
    case network(URLError.Code)
    /// The device token could not be read (keychain error, no token stored) – normal
    /// backoff; not a sign-in failure (the account list shows a missing token itself).
    case tokenUnavailable
    /// Any other HTTP error (5xx, 400 …) – normal backoff.
    case http(status: Int)
    /// 404, 429, a 401/403 without a Sync API error body (a proxy's page), a response that
    /// is not `text/event-stream` (an HTML page of a misconfigured proxy, a server without
    /// events) or an over-long line (status 200) – reconnect at the maximum delay.
    case unavailable(status: Int)
}

/// Timing of ``EventStream``.
public struct EventStreamTiming: Sendable, Hashable {
    /// First reconnect delay (seconds); doubled on every failed attempt.
    public var initialDelay: Double
    /// Upper bound of the reconnect delay (seconds); also the delay after 404/429/non-SSE.
    public var maxDelay: Double
    /// Relative jitter applied to every delay (0.2 = ±20 %).
    public var jitter: Double
    /// A connection open at least this long (seconds) resets the backoff.
    public var healthyAfter: Double
    /// No bytes (event or `: ping`, sent every 25 s) for this long ⇒ the connection is dead.
    public var idleTimeout: Duration
    /// Limit of one SSE line / one event's data; beyond it the connection is reset.
    public var maxLineBytes: Int

    public init(initialDelay: Double = 1, maxDelay: Double = 60, jitter: Double = 0.2,
                healthyAfter: Double = 60, idleTimeout: Duration = .seconds(60),
                maxLineBytes: Int = SSEParser.defaultMaxLineBytes) {
        self.initialDelay = initialDelay
        self.maxDelay = maxDelay
        self.jitter = jitter
        self.healthyAfter = healthyAfter
        self.idleTimeout = idleTimeout
        self.maxLineBytes = maxLineBytes
    }
}

/// Client of `GET /sync/v1/events` (Server-Sent Events, SYNC_API.md §5a): a wake-up
/// signal per account. It never carries changes; on `.connected` and `.changes` the
/// consumer lets the File Provider extension drain `/changes`; on `.account` it reloads
/// `/account` (the space list).
///
/// - Reconnects by itself: exponential backoff 1, 2, 4 … 60 s with ±20 % jitter, reset
///   once a connection stayed open for 60 s; a `retry:` field of the server is a lower
///   bound of the next delay.
/// - 404, 429 (or its `Retry-After`, if longer) and responses that are not
///   `text/event-stream` back off at the maximum delay right away and log once.
/// - 401/403 with a Sync API error body (`{"code": …}`) end the stream with the
///   ``SyncAPIError`` (`unauthorized`, `deviceRevoked`, `forbidden`) – sign-in required, no
///   reconnect. A 401/403 without such a body (a proxy) backs off at the maximum delay; a
///   token closure that throws is reported as ``StreamDisconnectReason/tokenUnavailable``
///   and retried with the normal backoff.
/// - A `retry:` above the maximum delay is capped at the maximum delay.
/// - Cancelling the consuming task (or dropping the stream) closes the connection.
public final class EventStream: Sendable {
    public let url: URL
    private let token: @Sendable () async throws -> String
    private let session: URLSession
    private let timing: EventStreamTiming
    private let sleep: @Sendable (Duration) async throws -> Void
    private let random: @Sendable (ClosedRange<Double>) -> Double
    private let uptime: @Sendable () -> TimeInterval

    private static let log = Logger(subsystem: Log.subsystem, category: "events")

    /// - Parameters:
    ///   - url: `<origin>/api/sync/v1/events` (see ``url(origin:)``).
    ///   - token: the device token, read before every connection attempt.
    ///   - sleep, random, uptime: replaceable in tests (backoff sleeper, jitter source,
    ///     monotonic clock in seconds).
    public init(url: URL, token: @escaping @Sendable () async throws -> String, session: URLSession = .shared,
                timing: EventStreamTiming = EventStreamTiming(),
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
                random: @escaping @Sendable (ClosedRange<Double>) -> Double = { Double.random(in: $0) },
                uptime: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.url = url
        self.token = token
        self.session = session
        self.timing = timing
        self.sleep = sleep
        self.random = random
        self.uptime = uptime
    }

    /// `<origin>/api/sync/v1/events`.
    public static func url(origin: URL) -> URL {
        SyncAPIClient.apiBaseURL(origin: origin).appending(path: "sync").appending(path: "v1").appending(path: "events")
    }

    /// Connects and keeps reconnecting until the consumer stops iterating (or the task is
    /// cancelled). Finishes with an error only when sign-in is required.
    public func events() -> AsyncThrowingStream<StreamSignal, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { await self.run(continuation) }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Loop

    /// Result of one connection attempt.
    enum Outcome: Sendable, Equatable {
        case cancelled
        case authenticationFailed(SyncAPIError)
        case disconnected(StreamDisconnectReason, openFor: TimeInterval?, retryAfter: TimeInterval?, serverRetry: Int?)
    }

    private func run(_ continuation: AsyncThrowingStream<StreamSignal, Error>.Continuation) async {
        var attempt = 0
        var lastLogged: StreamDisconnectReason?
        while !Task.isCancelled {
            let outcome = await connect(continuation)
            switch outcome {
            case .cancelled:
                continuation.finish()
                return
            case .authenticationFailed(let error):
                Self.log.notice("event stream: sign-in required (\(String(describing: error), privacy: .public))")
                continuation.finish(throwing: error)
                return
            case .disconnected(let reason, let openFor, let retryAfter, let serverRetry):
                if let openFor, openFor >= timing.healthyAfter { attempt = 0 }
                let delay = nextDelay(reason: reason, attempt: &attempt, retryAfter: retryAfter, serverRetry: serverRetry)
                // One line per change of the reason (a dead server must not fill the log).
                if reason != lastLogged {
                    Self.log.info("event stream disconnected: \(String(describing: reason), privacy: .public); retry in \(delay, format: .fixed(precision: 1), privacy: .public) s")
                    lastLogged = reason
                }
                continuation.yield(.disconnected(reason: reason))
                do {
                    try await sleep(.milliseconds(Int64((delay * 1000).rounded())))
                } catch {
                    continuation.finish()
                    return
                }
            }
        }
        continuation.finish()
    }

    /// Delay before the next attempt (seconds).
    func nextDelay(reason: StreamDisconnectReason, attempt: inout Int,
                   retryAfter: TimeInterval?, serverRetry: Int?) -> TimeInterval {
        var delay: TimeInterval
        let slow: Bool
        switch reason {
        case .unavailable: slow = true
        case .bye(let why): slow = why == "too_many_streams"   // another stream of the user is open
        default: slow = false
        }
        if slow {
            delay = jittered(timing.maxDelay)
            attempt = max(attempt, Self.maxExponent)
        } else {
            let exponent = min(attempt, Self.maxExponent)
            delay = jittered(min(timing.maxDelay, timing.initialDelay * pow(2, Double(exponent))))
            attempt = min(attempt + 1, Self.maxExponent)
        }
        if let retryAfter { delay = max(delay, retryAfter) }
        if let serverRetry { delay = max(delay, min(Double(serverRetry) / 1000, timing.maxDelay)) }
        return delay
    }

    private static let maxExponent = 16

    private func jittered(_ base: TimeInterval) -> TimeInterval {
        guard timing.jitter > 0 else { return base }
        let value = base * random((1 - timing.jitter)...(1 + timing.jitter))
        return min(value, timing.maxDelay)
    }

    // MARK: - One connection

    private func connect(_ continuation: AsyncThrowingStream<StreamSignal, Error>.Continuation) async -> Outcome {
        let bearer: String
        do {
            bearer = try await token()
        } catch is CancellationError {
            return .cancelled
        } catch {
            // Keychain error or no token: transient here – a sign-in is only required when the
            // server says so (a missing token is shown by the account list on its own).
            Self.log.error("event stream: no device token (\(String(describing: error), privacy: .public))")
            return .disconnected(.tokenUnavailable, openFor: nil, retryAfter: nil, serverRetry: nil)
        }
        if Task.isCancelled { return .cancelled }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                                 timeoutInterval: timing.idleTimeout.seconds + 30)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if !bearer.isEmpty { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }

        let bytes: URLSession.AsyncBytes
        let http: HTTPURLResponse
        do {
            let (stream, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse else {
                return .disconnected(.http(status: 0), openFor: nil, retryAfter: nil, serverRetry: nil)
            }
            bytes = stream
            http = response
        } catch {
            return transportOutcome(error)
        }

        switch http.statusCode {
        case 200:
            break
        case 401, 403:
            let body = await Self.readBody(bytes)
            // Only the server's own rejection (Sync API error JSON) means "sign in again".
            guard let error = try? JSONDecoder().decode(SyncErrorBody.self, from: body), error.code != nil else {
                return .disconnected(.unavailable(status: http.statusCode), openFor: nil, retryAfter: nil, serverRetry: nil)
            }
            return .authenticationFailed(SyncAPIClient.error(http, data: body))
        case 404:
            return .disconnected(.unavailable(status: 404), openFor: nil, retryAfter: nil, serverRetry: nil)
        case 429:
            let retryAfter = SyncAPIError.retryAfter(header: http.value(forHTTPHeaderField: "Retry-After"))
            return .disconnected(.unavailable(status: 429), openFor: nil, retryAfter: retryAfter, serverRetry: nil)
        default:
            return .disconnected(.http(status: http.statusCode), openFor: nil, retryAfter: nil, serverRetry: nil)
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        guard contentType.hasPrefix("text/event-stream") else {
            return .disconnected(.unavailable(status: 200), openFor: nil, retryAfter: nil, serverRetry: nil)
        }

        let openedAt = uptime()
        let (reason, serverRetry) = await read(bytes, continuation)
        if reason == nil { return .cancelled }
        return .disconnected(reason!, openFor: uptime() - openedAt, retryAfter: nil, serverRetry: serverRetry)
    }

    private func transportOutcome(_ error: Error) -> Outcome {
        if Task.isCancelled || error is CancellationError { return .cancelled }
        if let urlError = error as? URLError {
            // A `.cancelled` we did not cause (session/system) is a disconnect like any other.
            return .disconnected(.network(urlError.code), openFor: nil, retryAfter: nil, serverRetry: nil)
        }
        return .disconnected(.network(.unknown), openFor: nil, retryAfter: nil, serverRetry: nil)
    }

    /// Reads events until the stream ends, `bye`, the idle timeout or cancellation (`nil`).
    private func read(_ bytes: URLSession.AsyncBytes,
                      _ continuation: AsyncThrowingStream<StreamSignal, Error>.Continuation) async -> (StreamDisconnectReason?, Int?) {
        // The watchdog runs on the real monotonic clock (`uptime` is only for the backoff reset).
        let clock: @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        let activity = Activity(now: clock())
        let idle = timing.idleTimeout.seconds
        let maxLineBytes = timing.maxLineBytes
        let result: (StreamDisconnectReason?, Int?) = await withTaskGroup(of: (StreamDisconnectReason?, Int?).self) { group in
            group.addTask {
                var parser = SSEParser(maxLineBytes: maxLineBytes)
                var chunk = Data()
                do {
                    for try await byte in bytes {
                        chunk.append(byte)
                        // Feed at every line end (LF or CR) so an event is handled as soon as it is complete.
                        guard byte == 0x0A || byte == 0x0D || chunk.count >= 4096 else { continue }
                        // Liveness per line / 4 KiB (a ping is a line), not per byte.
                        activity.touch(clock())
                        for event in parser.feed(chunk) {
                            if let bye = Self.handle(event, continuation) { return (.bye(bye), parser.retry) }
                        }
                        chunk.removeAll(keepingCapacity: true)
                        // A line without end (broken proxy): reset the connection.
                        if parser.lineTooLong { return (.unavailable(status: 200), parser.retry) }
                    }
                    if !chunk.isEmpty {
                        for event in parser.feed(chunk) {
                            if let bye = Self.handle(event, continuation) { return (.bye(bye), parser.retry) }
                        }
                    }
                    return Task.isCancelled ? (nil, nil) : (.ended, parser.retry)
                } catch {
                    if Task.isCancelled { return (nil, nil) }
                    if let urlError = error as? URLError {
                        return (.network(urlError.code), parser.retry)
                    }
                    return (.network(.unknown), parser.retry)
                }
            }
            group.addTask {
                // Watchdog: the server sends at least a ping every 25 s.
                let step = Duration.seconds(max(idle / 4, 0.01))
                while !Task.isCancelled {
                    try? await Task.sleep(for: step)
                    if Task.isCancelled { return (nil, nil) }
                    if clock() - activity.last >= idle { return (.idleTimeout, nil) }
                }
                return (nil, nil)
            }
            let first = await group.next() ?? (nil, nil)
            group.cancelAll()
            return first
        }
        if Task.isCancelled { return (nil, nil) }
        return result
    }

    /// Yields the signal of an event; returns the reason of a `bye`.
    private static func handle(_ event: SSEEvent,
                               _ continuation: AsyncThrowingStream<StreamSignal, Error>.Continuation) -> String? {
        let fields = (try? JSONSerialization.jsonObject(with: Data(event.data.utf8))) as? [String: Any] ?? [:]
        func text(_ key: String) -> String {
            switch fields[key] {
            case let value as String: return value
            case let value as NSNumber: return value.stringValue
            default: return ""
            }
        }
        switch event.event {
        case "hello":
            var cursors: [String: String] = [:]
            for (space, value) in fields["cursors"] as? [String: Any] ?? [:] {
                switch value {
                case let value as String: cursors[space] = value
                case let value as NSNumber: cursors[space] = value.stringValue
                default: break
                }
            }
            continuation.yield(.connected(cursor: text("cursor"), cursors: cursors))
        case "account":
            continuation.yield(.account)
        case "changes":
            // A wake-up even when the payload is unreadable.
            continuation.yield(.changes(space: text("space"), cursor: text("cursor")))
        case "bye":
            let reason = text("reason")
            return reason.isEmpty ? "unknown" : reason
        default:
            break
        }
        return nil
    }

    /// Error body of a 401/403 (at most 16 KiB).
    private static func readBody(_ bytes: URLSession.AsyncBytes) async -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= 16 * 1024 { break }
            }
        } catch {}
        return data
    }
}

/// Time of the last received byte (shared by the reader and the watchdog).
private final class Activity: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval

    init(now: TimeInterval) { value = now }

    var last: TimeInterval { lock.withLock { value } }
    func touch(_ now: TimeInterval) { lock.withLock { value = now } }
}

extension Duration {
    /// The duration in seconds.
    var seconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) / 1e18
    }
}
