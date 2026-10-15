import Foundation
import XCTest
@testable import SyncletKit

/// `URLProtocol` stub that streams a scripted SSE response in chunks (one script per
/// connection attempt) and can keep the connection open until the client cancels.
final class SSEStubProtocol: URLProtocol, @unchecked Sendable {
    struct Script {
        var status = 200
        var headers: [String: String] = ["Content-Type": "text/event-stream"]
        /// Chunks sent with a short pause in between.
        var chunks: [String] = []
        /// Do not finish the response (the client has to cancel or time out).
        var keepOpen = false
        var body: Data? = nil
        /// Fail the request with this error instead of answering.
        var error: URLError? = nil

        static func failing(_ code: URLError.Code) -> Script { Script(error: URLError(code)) }

        static func events(_ chunks: [String], keepOpen: Bool = false) -> Script {
            Script(chunks: chunks, keepOpen: keepOpen)
        }

        static func status(_ status: Int, contentType: String = "application/json", body: String = "",
                           headers: [String: String] = [:]) -> Script {
            Script(status: status, headers: headers.merging(["Content-Type": contentType]) { a, _ in a },
                   body: Data(body.utf8))
        }
    }

    nonisolated(unsafe) private static var script: ((Int) -> Script)?
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var stopped = 0
    private static let lock = NSLock()

    private let state = NSLock()
    private var isStopped = false

    static func reset(_ script: @escaping (Int) -> Script) {
        lock.withLock {
            self.script = script
            recorded = []
            stopped = 0
        }
    }

    static var requests: [URLRequest] { lock.withLock { recorded } }
    static var stoppedCount: Int { lock.withLock { stopped } }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SSEStubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let script = Self.lock.withLock { () -> Script in
            Self.recorded.append(request)
            return Self.script?(Self.recorded.count - 1) ?? Script(status: 500)
        }
        if let error = script.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: script.status, httpVersion: "HTTP/1.1",
                                       headerFields: script.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let body = script.body {
            if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let chunks = script.chunks
        DispatchQueue.global().async { [self] in
            for chunk in chunks {
                Thread.sleep(forTimeInterval: 0.01)
                if state.withLock({ isStopped }) { return }
                client?.urlProtocol(self, didLoad: Data(chunk.utf8))
            }
            if !script.keepOpen, !state.withLock({ isStopped }) {
                client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    override func stopLoading() {
        state.withLock { isStopped = true }
        Self.lock.withLock { Self.stopped += 1 }
    }
}

/// Records the backoff delays and returns at once.
final class EventSleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double] = []

    var delays: [Double] { lock.withLock { values } }

    var sleep: @Sendable (Duration) async throws -> Void {
        { duration in
            self.lock.withLock { self.values.append(duration.seconds) }
            try Task.checkCancellation()
            await Task.yield()
        }
    }
}

/// A monotonic clock advanced by the test.
final class FakeUptime: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 1000
    /// Added on every read.
    var step: TimeInterval = 0

    var now: @Sendable () -> TimeInterval {
        { self.lock.withLock { self.value += self.step; return self.value } }
    }
}

final class EventStreamTests: XCTestCase {
    private let url = EventStream.url(origin: URL(string: "https://synclet.example.test/ignored")!)
    private var sleeper = EventSleepRecorder()
    private var uptime = FakeUptime()

    override func setUp() {
        sleeper = EventSleepRecorder()
        uptime = FakeUptime()
    }

    /// Jitter source fixed at the middle (factor 1.0) unless a test says otherwise.
    private func stream(token: @escaping @Sendable () async throws -> String = { "syd_test" },
                        random: @escaping @Sendable (ClosedRange<Double>) -> Double = { ($0.lowerBound + $0.upperBound) / 2 },
                        timing: EventStreamTiming = EventStreamTiming()) -> EventStream {
        EventStream(url: url, token: token, session: SSEStubProtocol.session(), timing: timing,
                    sleep: sleeper.sleep, random: random, uptime: uptime.now)
    }

    /// The first `count` signals (fails after `timeout`).
    private func collect(_ stream: EventStream, count: Int, timeout: Duration = .seconds(5)) async throws -> [StreamSignal] {
        try await withThrowingTaskGroup(of: [StreamSignal].self) { group in
            group.addTask {
                var signals: [StreamSignal] = []
                for try await signal in stream.events() {
                    signals.append(signal)
                    if signals.count == count { break }
                }
                return signals
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw URLError(.timedOut)
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static let hello = "event: hello\ndata: {\"cursor\":\"1234\"}\n\n"

    func testURLAndHeaders() async throws {
        XCTAssertEqual(url.absoluteString, "https://synclet.example.test/api/sync/v1/events")
        SSEStubProtocol.reset { _ in .events([Self.hello], keepOpen: true) }
        let signals = try await collect(stream(), count: 1)
        XCTAssertEqual(signals, [.connected(cursor: "1234")])
        let request = try XCTUnwrap(SSEStubProtocol.requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer syd_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.httpMethod, "GET")
    }

    func testHelloChangesAndReconnectAfterTheStreamEnds() async throws {
        SSEStubProtocol.reset { attempt in
            attempt == 0
                ? .events([Self.hello, ": ping\n\n", "event: changes\ndata: {\"space\":\"personal\",\"cursor\":\"1240\"}\n\n"])
                : .events(["event: hello\ndata: {\"cursor\":1240}\n\n"], keepOpen: true)
        }
        let signals = try await collect(stream(), count: 4)
        XCTAssertEqual(signals, [
            .connected(cursor: "1234"),
            .changes(space: "personal", cursor: "1240"),
            .disconnected(reason: .ended),
            .connected(cursor: "1240"),   // a numeric cursor is accepted too
        ])
        XCTAssertEqual(sleeper.delays, [1])
        XCTAssertEqual(SSEStubProtocol.requests.count, 2)
    }

    func testExponentialBackoffUpToSixtySeconds() async throws {
        SSEStubProtocol.reset { _ in .status(502, contentType: "text/html", body: "<html>bad gateway</html>") }
        let signals = try await collect(stream(), count: 9)
        XCTAssertEqual(Set(signals), [.disconnected(reason: .http(status: 502))])
        XCTAssertEqual(Array(sleeper.delays.prefix(9)), [1, 2, 4, 8, 16, 32, 60, 60, 60])
    }

    func testJitterIsTwentyPercentAndCappedAtTheMaximum() async throws {
        SSEStubProtocol.reset { _ in .status(500) }
        let low = stream(random: { $0.lowerBound })
        _ = try await collect(low, count: 7)
        XCTAssertEqual(Array(sleeper.delays.prefix(7)), [0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 48])

        sleeper = EventSleepRecorder()
        SSEStubProtocol.reset { _ in .status(500) }
        let high = stream(random: { $0.upperBound })
        _ = try await collect(high, count: 7)
        XCTAssertEqual(Array(sleeper.delays.prefix(7)), [1.2, 2.4, 4.8, 9.6, 19.2, 38.4, 60])
    }

    func testBackoffResetsAfterAHealthyConnection() async throws {
        // Two failures (1, 2 s), then a connection that stays open > 60 s and ends: back to 1 s.
        SSEStubProtocol.reset { attempt in
            switch attempt {
            case 0, 1: return .status(500)
            case 2: return .events([Self.hello])
            default: return .status(500)
            }
        }
        // Every connection that opens looks 61 s long; failed attempts have no open time.
        uptime.step = 61
        let signals = try await collect(stream(), count: 5)
        XCTAssertEqual(signals, [
            .disconnected(reason: .http(status: 500)),
            .disconnected(reason: .http(status: 500)),
            .connected(cursor: "1234"),
            .disconnected(reason: .ended),
            .disconnected(reason: .http(status: 500)),
        ])
        XCTAssertEqual(Array(sleeper.delays.prefix(4)), [1, 2, 1, 2])
    }

    func testShortConnectionsKeepGrowingTheBackoff() async throws {
        SSEStubProtocol.reset { _ in .events([Self.hello]) }
        let signals = try await collect(stream(), count: 6)
        XCTAssertEqual(signals.filter { $0 == .disconnected(reason: .ended) }.count, 3)
        XCTAssertEqual(Array(sleeper.delays.prefix(3)), [1, 2, 4])
    }

    func testNotFoundBacksOffAtTheMaximum() async throws {
        SSEStubProtocol.reset { _ in .status(404, body: #"{"statusCode":404,"message":"not found","code":"not_found"}"#) }
        let signals = try await collect(stream(), count: 3)
        XCTAssertEqual(signals, Array(repeating: .disconnected(reason: .unavailable(status: 404)), count: 3))
        XCTAssertEqual(Array(sleeper.delays.prefix(3)), [60, 60, 60])
    }

    func testHTMLFromAProxyBacksOffAtTheMaximum() async throws {
        SSEStubProtocol.reset { _ in .status(200, contentType: "text/html; charset=utf-8", body: "<html>login</html>") }
        let signals = try await collect(stream(), count: 2)
        XCTAssertEqual(signals, Array(repeating: .disconnected(reason: .unavailable(status: 200)), count: 2))
        XCTAssertEqual(Array(sleeper.delays.prefix(2)), [60, 60])
    }

    func testRateLimitedHonoursRetryAfter() async throws {
        SSEStubProtocol.reset { attempt in
            attempt == 0
                ? .status(429, body: #"{"statusCode":429,"message":"rate limited","code":"rate_limited"}"#, headers: ["Retry-After": "120"])
                : .status(429)
        }
        _ = try await collect(stream(), count: 2)
        XCTAssertEqual(Array(sleeper.delays.prefix(2)), [120, 60])
    }

    func testUnauthorizedStopsWithTheAuthError() async throws {
        SSEStubProtocol.reset { _ in .status(401, body: #"{"statusCode":401,"message":"revoked","code":"device_revoked"}"#) }
        do {
            _ = try await collect(stream(), count: 1)
            XCTFail("expected an error")
        } catch let error as SyncAPIError {
            XCTAssertEqual(error, .deviceRevoked)
            XCTAssertTrue(error.isAuthenticationFailure)
        }
        XCTAssertEqual(SSEStubProtocol.requests.count, 1)
        XCTAssertEqual(sleeper.delays, [])
    }

    func testForbiddenStops() async throws {
        SSEStubProtocol.reset { _ in .status(403, body: #"{"statusCode":403,"message":"no","code":"forbidden"}"#) }
        do {
            _ = try await collect(stream(), count: 1)
            XCTFail("expected an error")
        } catch let error as SyncAPIError {
            XCTAssertEqual(error, .forbidden(message: "no"))
        }
        XCTAssertEqual(SSEStubProtocol.requests.count, 1)
    }

    func testMissingTokenIsTransientAndRetriedWithoutARequest() async throws {
        SSEStubProtocol.reset { _ in .events([Self.hello]) }
        struct KeychainError: Error {}
        let signals = try await collect(stream(token: { throw KeychainError() }), count: 3)
        XCTAssertEqual(signals, Array(repeating: .disconnected(reason: .tokenUnavailable), count: 3))
        XCTAssertEqual(Array(sleeper.delays.prefix(3)), [1, 2, 4])
        XCTAssertEqual(SSEStubProtocol.requests.count, 0)
    }

    func testForbiddenFromAProxyIsNotAnAuthFailure() async throws {
        SSEStubProtocol.reset { _ in .status(403, contentType: "text/html", body: "<html>Access denied</html>") }
        let signals = try await collect(stream(), count: 2)
        XCTAssertEqual(signals, Array(repeating: .disconnected(reason: .unavailable(status: 403)), count: 2))
        XCTAssertEqual(Array(sleeper.delays.prefix(2)), [60, 60])
    }

    func testUnauthorizedWithoutASyncErrorBodyIsNotAnAuthFailure() async throws {
        SSEStubProtocol.reset { _ in .status(401, contentType: "application/json", body: #"{"error":"proxy auth"}"#) }
        let signals = try await collect(stream(), count: 2)
        XCTAssertEqual(signals, Array(repeating: .disconnected(reason: .unavailable(status: 401)), count: 2))
    }

    func testCancellationNotCausedByTheConsumerIsADisconnect() async throws {
        SSEStubProtocol.reset { attempt in attempt == 0 ? .failing(.cancelled) : .events([Self.hello], keepOpen: true) }
        let signals = try await collect(stream(), count: 2)
        XCTAssertEqual(signals, [.disconnected(reason: .network(.cancelled)), .connected(cursor: "1234")])
        XCTAssertEqual(sleeper.delays, [1])
    }

    func testServerRetryIsCappedAtTheMaximum() async throws {
        SSEStubProtocol.reset { _ in .events(["retry: 86400000\n\n", Self.hello]) }
        _ = try await collect(stream(), count: 2)
        XCTAssertEqual(sleeper.delays.first, 60)
    }

    func testOverlongLineResetsTheConnection() async throws {
        let endless = "data: " + String(repeating: "x", count: 10_000)
        SSEStubProtocol.reset { _ in .events([Self.hello, endless], keepOpen: true) }
        let signals = try await collect(stream(timing: EventStreamTiming(maxLineBytes: 1024)), count: 2)
        XCTAssertEqual(signals, [.connected(cursor: "1234"), .disconnected(reason: .unavailable(status: 200))])
        XCTAssertEqual(sleeper.delays.first, 60)
    }

    func testByeReasons() async throws {
        SSEStubProtocol.reset { attempt in
            switch attempt {
            case 0: return .events([Self.hello, "event: bye\ndata: {\"reason\":\"server_shutdown\"}\n\n"], keepOpen: true)
            case 1: return .events([Self.hello, "event: bye\ndata: {\"reason\":\"something_new\"}\n\n"], keepOpen: true)
            default: return .events([Self.hello, "event: bye\ndata: {\"reason\":\"too_many_streams\"}\n\n"], keepOpen: true)
            }
        }
        let signals = try await collect(stream(), count: 6)
        XCTAssertEqual(signals.filter { if case .disconnected = $0 { return true } else { return false } }, [
            .disconnected(reason: .bye("server_shutdown")),
            .disconnected(reason: .bye("something_new")),
            .disconnected(reason: .bye("too_many_streams")),
        ])
        // `bye` ends the connection even though the server keeps it open; another stream
        // of the user took the slot ⇒ the maximum delay.
        XCTAssertEqual(Array(sleeper.delays.prefix(3)), [1, 2, 60])
    }

    func testServerRetryFieldIsALowerBound() async throws {
        SSEStubProtocol.reset { _ in .events(["retry: 5000\n\n", Self.hello]) }
        _ = try await collect(stream(), count: 2)
        XCTAssertEqual(sleeper.delays.first, 5)
    }

    func testIdleConnectionIsTreatedAsDead() async throws {
        SSEStubProtocol.reset { attempt in
            attempt == 0 ? .events([Self.hello], keepOpen: true) : .events([Self.hello], keepOpen: true)
        }
        let started = Date()
        let signals = try await collect(stream(timing: EventStreamTiming(idleTimeout: .milliseconds(300))), count: 3)
        XCTAssertEqual(signals, [.connected(cursor: "1234"), .disconnected(reason: .idleTimeout), .connected(cursor: "1234")])
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertGreaterThanOrEqual(SSEStubProtocol.stoppedCount, 1)
    }

    func testPingsKeepTheConnectionAlive() async throws {
        let pings = Array(repeating: ": ping\n\n", count: 40)   // 40 × 10 ms
        SSEStubProtocol.reset { _ in .events([Self.hello] + pings + ["event: changes\ndata: {\"space\":\"personal\",\"cursor\":\"2\"}\n\n"], keepOpen: true) }
        let signals = try await collect(stream(timing: EventStreamTiming(idleTimeout: .milliseconds(150))), count: 2)
        XCTAssertEqual(signals, [.connected(cursor: "1234"), .changes(space: "personal", cursor: "2")])
    }

    func testStoppingTheConsumerClosesTheConnection() async throws {
        SSEStubProtocol.reset { _ in .events([Self.hello], keepOpen: true) }
        _ = try await collect(stream(), count: 1)
        for _ in 0..<100 where SSEStubProtocol.stoppedCount == 0 {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(SSEStubProtocol.stoppedCount, 1)
        XCTAssertEqual(SSEStubProtocol.requests.count, 1)
    }

    func testNetworkErrorUsesTheNormalBackoff() async throws {
        let session = URLSession(configuration: .ephemeral)
        // Nothing listens on port 9 of localhost: connection refused.
        let refused = EventStream(url: URL(string: "http://127.0.0.1:9/api/sync/v1/events")!, token: { "t" },
                                  session: session, sleep: sleeper.sleep, random: { _ in 1 }, uptime: uptime.now)
        let signals = try await collect(refused, count: 2)
        guard case .disconnected(.network) = signals[0] else { return XCTFail("\(signals)") }
        XCTAssertEqual(Array(sleeper.delays.prefix(2)), [1, 2])
    }
}
