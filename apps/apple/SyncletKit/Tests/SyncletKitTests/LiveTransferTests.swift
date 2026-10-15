#if os(macOS)
import Foundation
import XCTest
@testable import SyncletKit

/// Opt-in live checks against a running server (skipped without `SYNCLET_LIVE_URL`).
///
/// - `SYNCLET_LIVE_URL`, `SYNCLET_LIVE_USER`, `SYNCLET_LIVE_PASSWORD`: server and account.
/// - `SYNCLET_LIVE_SIZE_MB`: transfer size (default 200 for the upload, 100 for the replace).
/// - `SYNCLET_LIVE_INTERRUPT`: shell command run once when ~40 % are transferred, e.g.
///   `docker kill <your server container>; sleep 8; docker start <container>`; the transfer
///   must survive it.
/// - `SYNCLET_LIVE_KEEP`: keep the uploaded file.
///
/// Transfers go through ``TransferEngine`` (tus), retried with a new engine like the File
/// Provider system does after `serverUnreachable`; the server's sha256 is checked and the
/// file is downloaded again through ``RangeDownloader``.
final class LiveTransferTests: XCTestCase {
    /// New 200 MB file via tus, interrupted.
    func testLargeUploadSurvivesInterruption() async throws {
        try await withLiveAccount { api, env in
            let sizeMB = Int(env["SYNCLET_LIVE_SIZE_MB"] ?? "") ?? 200
            let file = TransferFixtures.patternFile(size: sizeMB * 1_000_000, seed: UInt8.random(in: 0...255))
            defer { try? FileManager.default.removeItem(at: file) }
            let localSHA = try TransferEngine.sha256(of: file)
            let stateDir = Fixtures.tempDirectory()
            defer { try? FileManager.default.removeItem(at: stateDir) }
            let name = "live-\(UUID().uuidString.prefix(8)).bin"
            let modifiedAt = Date() // the same local file version on every attempt

            let uploaded = try await self.retrying(env: env, interrupt: env["SYNCLET_LIVE_INTERRUPT"]) { engine, progress in
                try await engine.upload(file: file, newIn: SyncItem.rootID, name: name, modifiedAt: modifiedAt,
                                        progress: progress, resumeKey: "live-\(name)")
            }(api, stateDir)
            XCTAssertEqual(uploaded.name, name, "no duplicate name")
            XCTAssertEqual(uploaded.size, Int64(sizeMB * 1_000_000))
            XCTAssertEqual(uploaded.sha256, localSHA)
            print("LIVE: local sha256 \(localSHA), server sha256 \(uploaded.sha256 ?? "nil")")
            try await self.assertDownload(api: api, item: uploaded, sha: localSHA, stateDir: stateDir)

            // Exactly one file with that name (no "(2)").
            let siblings = try await api.children(of: SyncItem.rootID, limit: 1000).items
            XCTAssertEqual(siblings.filter { $0.name.hasPrefix(String(name.dropLast(4))) }.count, 1)
            if env["SYNCLET_LIVE_KEEP"] == nil { try await api.deleteItem(id: uploaded.id) }
        }
    }

    /// Replacing a 100 MB file via tus (`itemId` + `ifMatch`), interrupted: same id,
    /// version + 1, sha256 of the new content.
    func testLargeReplaceSurvivesInterruption() async throws {
        try await withLiveAccount { api, env in
            let sizeMB = Int(env["SYNCLET_LIVE_SIZE_MB"] ?? "") ?? 100
            let stateDir = Fixtures.tempDirectory()
            defer { try? FileManager.default.removeItem(at: stateDir) }
            let name = "live-replace-\(UUID().uuidString.prefix(8)).bin"

            // The original (not interrupted).
            let original = TransferFixtures.patternFile(size: sizeMB * 1_000_000, seed: 1)
            defer { try? FileManager.default.removeItem(at: original) }
            let first = try await TransferEngine(api: api, stateDir: stateDir)
                .upload(file: original, newIn: SyncItem.rootID, name: name, modifiedAt: Date())
            print("LIVE: original \(first.id) version \(first.version ?? -1) etag \(first.contentEtag ?? "nil")")
            let baseEtag = try XCTUnwrap(first.contentEtag)

            // The new content, replaced through tus with an interruption.
            let changed = TransferFixtures.patternFile(size: sizeMB * 1_000_000, seed: 2)
            defer { try? FileManager.default.removeItem(at: changed) }
            let changedSHA = try TransferEngine.sha256(of: changed)
            let modifiedAt = Date()
            let replaced = try await self.retrying(env: env, interrupt: env["SYNCLET_LIVE_INTERRUPT"]) { engine, progress in
                try await engine.replace(file: changed, itemId: first.id, baseEtag: baseEtag, modifiedAt: modifiedAt,
                                         progress: progress)
            }(api, stateDir)

            print("LIVE: replaced \(replaced.id) version \(replaced.version ?? -1), local sha256 \(changedSHA), server sha256 \(replaced.sha256 ?? "nil")")
            XCTAssertEqual(replaced.id, first.id, "same item")
            XCTAssertEqual(replaced.version, (first.version ?? 0) + 1, "version + 1")
            XCTAssertEqual(replaced.sha256, changedSHA)
            let fetched = try await api.item(id: first.id)
            XCTAssertEqual(fetched.version, replaced.version)
            XCTAssertEqual(fetched.sha256, changedSHA)
            try await self.assertDownload(api: api, item: replaced, sha: changedSHA, stateDir: stateDir)
            if env["SYNCLET_LIVE_KEEP"] == nil { try await api.deleteItem(id: first.id) }
        }
    }

    // MARK: - Helpers

    /// Signs in with a password, registers a throwaway device, runs `body`, revokes the device.
    private func withLiveAccount(_ body: (SyncAPIClient, [String: String]) async throws -> Void) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let user = env["SYNCLET_LIVE_USER"], let password = env["SYNCLET_LIVE_PASSWORD"] else {
            throw XCTSkip("SYNCLET_LIVE_URL / _USER / _PASSWORD not set")
        }
        var login = URLRequest(url: server.appending(path: "api/auth/login"))
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONSerialization.data(withJSONObject: ["login": user, "password": password])
        let (loginData, _) = try await URLSession.shared.data(for: login)
        let accessToken = try XCTUnwrap((try JSONSerialization.jsonObject(with: loginData) as? [String: Any])?["accessToken"] as? String)
        let registration = try await SyncAPIClient(baseURL: server, token: accessToken)
            .registerDevice(name: "SyncletKit live transfer test", platform: .macos, appVersion: "0.1.0")
        let api = SyncAPIClient(baseURL: server, token: registration.token)
        do {
            try await body(api, env)
        } catch {
            try? await api.revokeCurrentDevice()
            throw error
        }
        try await api.revokeCurrentDevice()
    }

    /// Runs `operation` until it succeeds, with a new engine per attempt, interrupting once at
    /// ~40 % with the `interrupt` shell command.
    private func retrying(env: [String: String], interrupt: String?,
                          _ operation: @escaping (TransferEngine, Progress) async throws -> SyncItem)
        -> (SyncAPIClient, URL) async throws -> SyncItem {
        { api, stateDir in
            let interrupted = Flag()
            let resumeLog = Flag()
            let progress = Progress(totalUnitCount: 0)
            let observation = progress.observe(\.completedUnitCount) { progress, _ in
                if resumeLog.take() { print("LIVE: next attempt starts at \(progress.completedUnitCount) bytes") }
                guard let interrupt, progress.totalUnitCount > 0,
                      progress.completedUnitCount * 10 >= progress.totalUnitCount * 4, interrupted.setOnce() else { return }
                print("LIVE: interrupting at \(progress.completedUnitCount) bytes: \(interrupt)")
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/sh")
                process.arguments = ["-c", interrupt]
                try? process.run()
            }
            defer { observation.invalidate() }
            var failures: [String] = []
            let started = Date()
            for attempt in 1...30 {
                do {
                    let item = try await operation(TransferEngine(api: api, stateDir: stateDir), progress)
                    print("LIVE: completed in attempt \(attempt) after \(Int(Date().timeIntervalSince(started))) s, failures \(failures.count)")
                    if interrupt != nil { XCTAssertFalse(failures.isEmpty, "the interruption should have broken the transfer") }
                    return item
                } catch let error as SyncAPIError where error.isTransient {
                    failures.append("attempt \(attempt) at \(progress.completedUnitCount): \(error)")
                    print("LIVE: \(failures.last!)")
                    try await Task.sleep(for: .seconds(2))
                    resumeLog.arm()
                }
            }
            throw SyncAPIError.invalidResponse("transfer did not complete: \(failures)")
        }
    }

    private func assertDownload(api: SyncAPIClient, item: SyncItem, sha: String, stateDir: URL) async throws {
        let copy = stateDir.appending(path: "download-\(UUID().uuidString)")
        let result = try await RangeDownloader(api: api).download(itemID: item.id, to: copy)
        XCTAssertEqual(try TransferEngine.sha256(of: copy), sha)
        XCTAssertEqual(result.etag, item.contentEtag)
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var set = false
    private var armed = false
    func setOnce() -> Bool { lock.withLock { if set { return false }; set = true; return true } }
    func arm() { lock.withLock { armed = true } }
    func take() -> Bool { lock.withLock { defer { armed = false }; return armed } }
}
#endif
