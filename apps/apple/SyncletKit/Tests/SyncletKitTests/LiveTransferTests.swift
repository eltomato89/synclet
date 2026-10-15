#if os(macOS)
import Foundation
import XCTest
@testable import SyncletKit

/// Opt-in live check against a running server (skipped without `SYNCLET_LIVE_URL`).
///
/// - `SYNCLET_LIVE_URL`, `SYNCLET_LIVE_USER`, `SYNCLET_LIVE_PASSWORD`: server and account.
/// - `SYNCLET_LIVE_SIZE_MB`: upload size (default 200).
/// - `SYNCLET_LIVE_INTERRUPT`: shell command run once when ~40 % are uploaded, e.g.
///   `docker restart <your server container>`; the upload must survive it.
///
/// Uploads a pattern file through ``TransferEngine`` (tus), retrying like the File Provider
/// system does after `serverUnreachable`, checks the server's sha256, downloads it again
/// through ``RangeDownloader`` and compares, then deletes the file and revokes the device.
final class LiveTransferTests: XCTestCase {
    func testLargeUploadSurvivesInterruption() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let user = env["SYNCLET_LIVE_USER"], let password = env["SYNCLET_LIVE_PASSWORD"] else {
            throw XCTSkip("SYNCLET_LIVE_URL / _USER / _PASSWORD not set")
        }
        let sizeMB = Int(env["SYNCLET_LIVE_SIZE_MB"] ?? "") ?? 200

        // Sign in (password) and register a throwaway device.
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
            try await run(api: api, env: env, sizeMB: sizeMB)
        } catch {
            try? await api.revokeCurrentDevice()
            throw error
        }
        try await api.revokeCurrentDevice()
    }

    private func run(api: SyncAPIClient, env: [String: String], sizeMB: Int) async throws {

        let file = TransferFixtures.patternFile(size: sizeMB * 1_000_000, seed: UInt8.random(in: 0...255))
        defer { try? FileManager.default.removeItem(at: file) }
        let localSHA = try TransferEngine.sha256(of: file)
        let stateDir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let name = "live-\(UUID().uuidString.prefix(8)).bin"

        let interrupt = env["SYNCLET_LIVE_INTERRUPT"]
        let interrupted = Flag()
        let progress = Progress(totalUnitCount: 0)
        let resumeLog = Flag()
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

        // Like the File Provider system: retry the operation after a transient error.
        var item: SyncItem?
        let modifiedAt = Date() // the same local file version on every attempt
        var failures: [String] = []
        let started = Date()
        for attempt in 1...30 {
            let engine = TransferEngine(api: api, stateDir: stateDir) // new instance per attempt
            do {
                item = try await engine.upload(file: file, newIn: SyncItem.rootID, name: name, modifiedAt: modifiedAt,
                                               progress: progress, resumeKey: "live-\(name)")
                print("LIVE: completed in attempt \(attempt)")
                break
            } catch let error as SyncAPIError where error.isTransient {
                failures.append("attempt \(attempt) at \(progress.completedUnitCount): \(error)")
                print("LIVE: \(failures.last!)")
                try await Task.sleep(for: .seconds(2))
                resumeLog.arm()
            }
        }
        let uploaded = try XCTUnwrap(item, "upload did not complete: \(failures)")
        print("LIVE: \(sizeMB) MB in \(Int(Date().timeIntervalSince(started))) s, id \(uploaded.id), name \(uploaded.name), failures \(failures.count)")
        if interrupt != nil { XCTAssertFalse(failures.isEmpty, "the interruption should have broken the upload") }
        XCTAssertEqual(uploaded.name, name, "no duplicate name")
        XCTAssertEqual(uploaded.size, Int64(sizeMB * 1_000_000))
        XCTAssertEqual(uploaded.sha256, localSHA)
        print("LIVE: local sha256 \(localSHA), server sha256 \(uploaded.sha256 ?? "nil")")

        // Download through the RangeDownloader and compare.
        let copy = stateDir.appending(path: "download")
        let result = try await RangeDownloader(api: api).download(itemID: uploaded.id, to: copy)
        XCTAssertEqual(try TransferEngine.sha256(of: copy), localSHA)
        XCTAssertEqual(result.etag, uploaded.contentEtag)

        // Exactly one file with that name (no "(2)").
        let siblings = try await api.children(of: SyncItem.rootID, limit: 1000).items
        XCTAssertEqual(siblings.filter { $0.name.hasPrefix(String(name.dropLast(4))) }.count, 1)

        if env["SYNCLET_LIVE_KEEP"] == nil { try await api.deleteItem(id: uploaded.id) }
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
