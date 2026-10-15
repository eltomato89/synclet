import Foundation
import XCTest
@testable import SyncletKit

/// Opt-in check against a running server (skipped unless `SYNCLET_LIVE_URL` and
/// `SYNCLET_LIVE_TOKEN` – a device token – are set):
///
/// 1. `hello` arrives (`.connected`).
/// 2. A folder created through the API is announced as `changes` within 3 s.
/// 3. With `SYNCLET_LIVE_RESTART_WAIT=<seconds>`: the test waits that long for the server to be
///    restarted from outside and asserts a `.disconnected` followed by a new `.connected`.
final class EventStreamLiveTests: XCTestCase {
    private final class Log: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [(Date, StreamSignal)] = []
        private var failure: Error?

        func append(_ signal: StreamSignal) { lock.withLock { entries.append((Date(), signal)) } }
        func fail(_ error: Error) { lock.withLock { failure = error } }
        var signals: [(Date, StreamSignal)] { lock.withLock { entries } }
        var error: Error? { lock.withLock { failure } }
    }

    private func waitFor(_ log: Log, timeout: TimeInterval, after index: Int = 0,
                         _ match: (StreamSignal) -> Bool) async throws -> (Int, Date)? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let signals = log.signals
            if let found = signals.indices.first(where: { $0 >= index && match(signals[$0].1) }) {
                return (found, signals[found].0)
            }
            if let error = log.error { throw error }
            try await Task.sleep(for: .milliseconds(20))
        }
        return nil
    }

    func testLiveStream() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlText = env["SYNCLET_LIVE_URL"], let origin = URL(string: urlText),
              let token = env["SYNCLET_LIVE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("SYNCLET_LIVE_URL / SYNCLET_LIVE_TOKEN not set")
        }
        let stream = EventStream(url: EventStream.url(origin: origin), token: { token })
        let log = Log()
        let consumer = Task {
            do {
                for try await signal in stream.events() {
                    print("live: \(Date()) \(signal)")
                    log.append(signal)
                }
            } catch {
                log.fail(error)
            }
        }
        defer { consumer.cancel() }

        // 1. hello
        let hello = try await waitFor(log, timeout: 5) { if case .connected = $0 { return true } else { return false } }
        XCTAssertNotNil(hello, "no hello within 5 s")

        // 2. an API change is announced within 3 s
        let client = SyncAPIClient(baseURL: origin, token: token)
        let start = Date()
        let folder = try await client.createFolder(parentID: SyncItem.rootID, name: "t6-live-\(UUID().uuidString.prefix(8))")
        let changes = try await waitFor(log, timeout: 3, after: hello?.0 ?? 0) {
            if case .changes = $0 { return true } else { return false }
        }
        XCTAssertNotNil(changes, "no changes within 3 s")
        if let changes { print("live: changes \(String(format: "%.3f", changes.1.timeIntervalSince(start))) s after the create") }
        try? await client.deleteItem(id: folder.id)

        // 3. server restart (from outside) → disconnected, then connected again
        if let waitText = env["SYNCLET_LIVE_RESTART_WAIT"], let wait = TimeInterval(waitText) {
            let mark = log.signals.count
            print("live: waiting up to \(wait) s for a server restart")
            let down = try await waitFor(log, timeout: wait, after: mark) {
                if case .disconnected = $0 { return true } else { return false }
            }
            XCTAssertNotNil(down, "no disconnect")
            guard let down else { return }
            let up = try await waitFor(log, timeout: 120, after: down.0) {
                if case .connected = $0 { return true } else { return false }
            }
            XCTAssertNotNil(up, "no reconnect within 120 s")
            if let up { print("live: reconnected \(String(format: "%.3f", up.1.timeIntervalSince(down.1))) s after the first disconnect") }
        }
    }
}
