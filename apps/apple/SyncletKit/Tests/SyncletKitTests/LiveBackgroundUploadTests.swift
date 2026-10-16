import CryptoKit
import Foundation
import XCTest
@testable import SyncletKit

/// Opt-in live check of ``BackgroundUploader`` against a running server (skipped without
/// `SYNCLET_LIVE_URL` and `SYNCLET_LIVE_TOKEN`, a registered device token; see
/// `scripts/ios-live-tests.sh` / `scripts/macos-live-tests.sh`).
///
/// A 40 MiB file goes through tus with an `.ephemeral` session (no background daemon under
/// `swift test`). While the second `PATCH` is in flight the session is invalidated (the task is
/// cancelled, like a killed process); a new uploader on the same queue directory resumes the
/// same tus upload through `HEAD`. The server's sha256 must match and the folder must contain
/// exactly one item of that name.
final class LiveBackgroundUploadTests: XCTestCase {
    private static let size = 40 * 1024 * 1024
    private static let identifier = "tech.jensk.synclet.upload.livetest"
    private static let accountKey = "live:background-upload"

    /// Holds the uploader for its own progress callback, the tus URLs seen and the kill flag.
    private final class Observer: @unchecked Sendable {
        private let lock = NSLock()
        private var _uploader: BackgroundUploader?
        private var _killed = false
        private var _tusURLs: [URL] = []

        var uploader: BackgroundUploader? {
            get { lock.withLock { _uploader } }
            set { lock.withLock { _uploader = newValue } }
        }
        var killed: Bool { lock.withLock { _killed } }
        var tusURLs: [URL] { lock.withLock { _tusURLs } }

        func record(_ entry: UploadEntry) {
            guard let url = entry.tusURL else { return }
            lock.withLock { if _tusURLs.last != url { _tusURLs.append(url) } }
        }

        /// Cancels the session once the transfer is past the first chunk (second `PATCH` running).
        func progress(sent: Int64) {
            let kill: BackgroundUploader? = lock.withLock {
                guard !_killed, sent > UploadRequestBuilder.chunkSize + 1024 * 1024 else { return nil }
                _killed = true
                return _uploader
            }
            kill?.invalidate()
        }
    }

    func testTusUploadResumesInNewUploaderAfterKill() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let token = env["SYNCLET_LIVE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("SYNCLET_LIVE_URL / SYNCLET_LIVE_TOKEN not set")
        }
        let api = SyncAPIClient(baseURL: server, token: token)
        let dir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let accounts = AccountStore(directory: dir)
        try accounts.upsert(StoredAccount(key: Self.accountKey, serverURL: server, userId: "live", username: "live",
                                          displayName: "Live", spaces: []))
        let credentials = CredentialStore(storage: InMemorySecureStorage())
        try credentials.save(token: token, for: Self.accountKey)
        let queueDir = dir.appending(path: "uploads", directoryHint: .isDirectory)

        // The local file.
        let source = TransferFixtures.patternFile(size: Self.size, seed: UInt8.random(in: 0...255))
        defer { try? FileManager.default.removeItem(at: source) }
        let localSHA = try Self.sha256(of: source)
        let name = "live-bg-\(UUID().uuidString.prefix(8)).bin"
        let entry = try UploadQueue(directory: queueDir)
            .enqueue(source: source, name: name, accountKey: Self.accountKey, parentId: SyncItem.rootID, parentName: "Root")
        XCTAssertGreaterThan(Int64(Self.size), UploadRequestBuilder.threshold, "tus, not a single POST")

        // First uploader: killed while the second PATCH is in flight.
        let first = Observer()
        let uploader1 = Self.makeUploader(queueDir: queueDir, accounts: accounts, credentials: credentials,
                                          observer: first)
        first.uploader = uploader1
        defer { uploader1.invalidate() }
        await uploader1.pump()
        try await waitUntil("first uploader killed and entry back to waiting", timeout: 120) {
            let current = UploadQueue(directory: queueDir).entry(id: entry.id)
            return first.killed && current?.status == .waiting
        }
        let interrupted = try XCTUnwrap(UploadQueue(directory: queueDir).entry(id: entry.id))
        let tusURL = try XCTUnwrap(interrupted.tusURL, "tus upload created before the kill")
        XCTAssertGreaterThanOrEqual(interrupted.tusOffset, UploadRequestBuilder.chunkSize, "first PATCH done")
        XCTAssertLessThan(interrupted.tusOffset, Int64(Self.size))
        print("LIVE: killed at offset \(interrupted.tusOffset) of \(Self.size), tus \(tusURL.lastPathComponent)")

        // Second uploader on the same queue directory (a relaunch): HEAD, then the rest.
        let second = Observer()
        let uploader2 = Self.makeUploader(queueDir: queueDir, accounts: accounts, credentials: credentials,
                                          observer: second)
        defer { uploader2.invalidate() }
        await uploader2.pump()
        try await waitUntil("upload done", timeout: 180) {
            let status = UploadQueue(directory: queueDir).entry(id: entry.id)?.status
            return status == .done || status == .failed
        }
        let done = try XCTUnwrap(UploadQueue(directory: queueDir).entry(id: entry.id))
        XCTAssertEqual(done.status, .done, "failure: \(String(describing: done.failure)) \(done.failureMessage ?? "")")
        XCTAssertEqual(second.tusURLs, [tusURL], "resumed the same tus upload (HEAD), no new create")
        let itemId = try XCTUnwrap(done.itemId)

        // Server item: same content, no duplicate.
        var item = try await api.item(id: itemId)
        for _ in 0..<20 where item.sha256 == nil {
            try await Task.sleep(for: .milliseconds(500))
            item = try await api.item(id: itemId)
        }
        print("LIVE: local sha256 \(localSHA), server sha256 \(item.sha256 ?? "nil")")
        XCTAssertEqual(item.name, name)
        XCTAssertEqual(item.size, Int64(Self.size))
        XCTAssertEqual(item.sha256, localSHA)
        let siblings = try await api.children(of: SyncItem.rootID, limit: 1000).items
        XCTAssertEqual(siblings.filter { $0.name.hasPrefix(String(name.dropLast(4))) }.count, 1, "exactly one item")
        try await api.deleteItem(id: itemId)
    }

    // MARK: - Helpers

    private static func makeUploader(queueDir: URL, accounts: AccountStore, credentials: CredentialStore,
                                     observer: Observer) -> BackgroundUploader {
        BackgroundUploader(identifier: identifier, queue: UploadQueue(directory: queueDir), appGroup: nil,
                           accounts: accounts, credentials: credentials, sessionConfiguration: .ephemeral,
                           onChange: { observer.record($0) },
                           onProgress: { _, sent in observer.progress(sent: sent) })
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1 << 20), !data.isEmpty { hasher.update(data: data) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func waitUntil(_ what: String, timeout: TimeInterval, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { throw Timeout(what: what) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private struct Timeout: Error, CustomStringConvertible {
        let what: String
        var description: String { "timed out waiting for \(what)" }
    }
}
