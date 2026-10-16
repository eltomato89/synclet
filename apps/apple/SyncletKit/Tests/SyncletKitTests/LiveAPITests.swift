#if os(macOS)
import FileProvider
import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

/// End-to-end checks of the Sync API as the macOS client uses it, against a running server
/// (opt-in: skipped unless `SYNCLET_LIVE_URL`, `SYNCLET_LIVE_USER` and `SYNCLET_LIVE_PASSWORD`
/// are set; `scripts/macos-live-tests.sh` starts a throwaway stack and sets them).
///
/// Sign-in: the password path of the app login, `POST /api/auth/app/authorize` with PKCE – the
/// same HTTP calls the `/app-login` web page makes – then the app's own code exchange
/// (``AuthAPI/exchangeCode(server:code:verifier:)``) and device registration. The app itself
/// never sees a password; only this test takes the shortcut past the browser.
///
/// One sign-in per test run (the server rate-limits unauthenticated calls per IP, 10 in a
/// burst): two devices are registered from it, one shared by the tests and revoked at the end,
/// one that ``testSignOutRevokesDevice()`` signs out with.
///
/// Covered: `/account` has the personal space; small upload and 40 MiB tus upload with
/// matching sha256; replace with a stale etag → 412 and the extension's conflict path uploads a
/// named copy; SSE `hello` and `changes` within 3 s of an API change; a PNG thumbnail; sign-out
/// revokes the device (next call 401). The other live classes cover the rest: interrupted
/// 200 MB tus upload/replace (``LiveTransferTests``), thumbnail cache/304/PDF and the 413
/// problem (``LiveThumbnailTests``), SSE reconnect after a server restart
/// (``EventStreamLiveTests``, needs `SYNCLET_LIVE_TOKEN`).
final class LiveAPITests: XCTestCase {
    struct Session: Sendable {
        let server: URL
        /// Device token shared by the tests.
        let api: SyncAPIClient
        /// Its token (`syd_…`).
        let token: String
        let deviceID: String
        /// Device token of the sign-out test.
        let signOutToken: String
        let user: String
    }

    private static let session = LiveSessionCache()

    /// The signed-in session, or `XCTSkip` without the live env.
    private func live() async throws -> Session {
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["SYNCLET_LIVE_URL"], let server = URL(string: urlString),
              let user = env["SYNCLET_LIVE_USER"], let password = env["SYNCLET_LIVE_PASSWORD"] else {
            throw XCTSkip("SYNCLET_LIVE_URL / _USER / _PASSWORD not set")
        }
        return try await Self.session.get { try await Self.signIn(server: server, user: user, password: password) }
    }

    override class func tearDown() {
        // Revoke the shared device (best effort; a throwaway stack is removed anyway).
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            if let session = await session.current { try? await session.api.revokeCurrentDevice() }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 10)
        super.tearDown()
    }

    // MARK: - Sign-in (app login, password path, PKCE)

    static func signIn(server: URL, user: String, password: String) async throws -> Session {
        let auth = AuthAPI()
        let pkce = PKCE.make()
        // 1. What the /app-login page posts after the user entered the password.
        struct Authorize: Encodable {
            let login: String, password: String, clientId: String, redirectUri: String
            let codeChallenge: String, codeChallengeMethod: String
        }
        struct Code: Decodable { let code: String }
        let body = Authorize(login: user, password: password, clientId: auth.clientID, redirectUri: auth.redirectURI,
                             codeChallenge: pkce.challenge, codeChallengeMethod: "S256")
        let code: Code = try await postJSON(server.appending(path: "api/auth/app/authorize"), body: body)
        // 2. The page redirects to synclet://oauth?code=…&state=…; the app checks the state.
        var redirect = URLComponents(string: auth.redirectURI)!
        redirect.queryItems = [URLQueryItem(name: "code", value: code.code), URLQueryItem(name: "state", value: pkce.state)]
        let received = try AuthAPI.code(fromRedirect: redirect.url!, expectedState: pkce.state)
        // 3. The app's exchange and device registration (as AccountsModel does it).
        let tokens = try await auth.exchangeCode(server: server, code: received, verifier: pkce.verifier)
        XCTAssertEqual(tokens.user.username, user)
        let main = try await auth.registerDevice(server: server, accessToken: tokens.accessToken,
                                                 name: "SyncletKit LiveAPITests", platform: .macos, installationId: nil)
        let signOut = try await auth.registerDevice(server: server, accessToken: tokens.accessToken,
                                                    name: "SyncletKit LiveAPITests sign-out", platform: .macos,
                                                    installationId: nil)
        XCTAssertTrue(main.token.hasPrefix("syd_"), "device token format")
        // 4. The login session is not needed after the registration (§2.1 step 5).
        await auth.endSession(server: server, refreshToken: tokens.refreshToken)
        print("LIVE: signed in as \(user) via /api/auth/app/authorize + PKCE, device \(main.device.id)")
        return Session(server: server, api: SyncAPIClient(baseURL: server, token: main.token),
                       token: main.token, deviceID: main.device.id, signOutToken: signOut.token, user: user)
    }

    /// POST JSON, retrying once on 429 after `Retry-After`.
    private static func postJSON<T: Decodable>(_ url: URL, body: some Encodable) async throws -> T {
        for attempt in 1...2 {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await URLSession.shared.data(for: request)
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            if http.statusCode == 429, attempt == 1 {
                let wait = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 10
                print("LIVE: 429 on \(url.path), waiting \(wait) s")
                try await Task.sleep(for: .seconds(wait))
                continue
            }
            guard http.statusCode == 200 else {
                throw SyncAPIError.http(status: http.statusCode, code: nil, message: String(data: data, encoding: .utf8))
            }
            return try JSONDecoder().decode(T.self, from: data)
        }
        throw SyncAPIError.invalidResponse("rate limited")
    }

    // MARK: - Tests

    /// `GET /account` lists the personal space (`personal` → `root`) – in the raw JSON, not only
    /// through the client's fallback that synthesizes it for old servers.
    func testAccountHasPersonalSpace() async throws {
        let live = try await live()
        let account = try await live.api.account()
        XCTAssertEqual(account.username, live.user)
        let personal = try XCTUnwrap(account.spaces.first { $0.id == "personal" })
        XCTAssertEqual(personal.kind, .personal)
        XCTAssertEqual(personal.rootId, SyncItem.rootID)
        XCTAssertTrue(personal.canWrite)

        var request = try await live.api.makeRequest(.get, ["sync", "v1", "account"])
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, _) = try await URLSession.shared.data(for: request)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let spaces = try XCTUnwrap(json["spaces"] as? [[String: Any]], "server sends spaces")
        XCTAssertEqual(spaces.first?["id"] as? String, "personal")
        XCTAssertEqual(spaces.first?["rootId"] as? String, "root")
        print("LIVE: account \(account.organizationId) spaces \(account.spaces.map(\.id))")
    }

    /// A small file (single `POST`) and a 40 MiB file (tus, above the 32 MiB threshold): the
    /// server's sha256 equals the local one, and the downloaded bytes too.
    func testUploadSmallAndTus40MiB() async throws {
        let live = try await live()
        let api = live.api
        let stateDir = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let engine = TransferEngine(api: api, stateDir: stateDir)
        let tag = UUID().uuidString.prefix(8)

        let small = Fixtures.tempFile("Hallo Synclet \(tag) – äöü")
        defer { try? FileManager.default.removeItem(at: small) }
        let smallItem = try await engine.upload(file: small, newIn: SyncItem.rootID, name: "live-small-\(tag).txt",
                                                modifiedAt: Date())
        XCTAssertEqual(smallItem.sha256, try TransferEngine.sha256(of: small))
        XCTAssertEqual(smallItem.name, "live-small-\(tag).txt")

        let size = 40 << 20
        XCTAssertGreaterThan(size, TransferEngine.defaultThreshold, "40 MiB goes through tus")
        let large = TransferFixtures.patternFile(size: size, seed: UInt8.random(in: 0...255))
        defer { try? FileManager.default.removeItem(at: large) }
        let largeSHA = try TransferEngine.sha256(of: large)
        let started = Date()
        let largeItem = try await engine.upload(file: large, newIn: SyncItem.rootID, name: "live-tus-\(tag).bin",
                                                modifiedAt: Date())
        print("LIVE: 40 MiB tus upload in \(String(format: "%.1f", Date().timeIntervalSince(started))) s, sha \(largeItem.sha256 ?? "nil")")
        XCTAssertEqual(largeItem.size, Int64(size))
        XCTAssertEqual(largeItem.sha256, largeSHA)
        let fetched = try await api.item(id: largeItem.id)
        XCTAssertEqual(fetched.sha256, largeSHA)

        let copy = stateDir.appending(path: "download.bin")
        let result = try await RangeDownloader(api: api).download(itemID: largeItem.id, to: copy)
        XCTAssertEqual(try TransferEngine.sha256(of: copy), largeSHA)
        XCTAssertEqual(result.etag, largeItem.contentEtag)

        try await api.deleteItem(id: smallItem.id)
        try await api.deleteItem(id: largeItem.id)
    }

    /// The file changed on the server (another client, `v1 → v2`) while this Mac still has
    /// `v1`: `PUT` with `If-Match: v1` → 412 with the server item; the extension's modify path
    /// then uploads the local content as `"<base> (Konflikt <device> <date>).<ext>"` next to it
    /// and keeps the server version.
    func testStaleReplaceConflictCreatesNamedCopy() async throws {
        let live = try await live()
        let api = live.api
        let tag = UUID().uuidString.prefix(8)
        let name = "live-conflict-\(tag).txt"
        let original = try await api.uploadNewFile(parentID: SyncItem.rootID, name: name, from: Fixtures.tempFile("v1"))
        let v1 = try XCTUnwrap(original.contentEtag)
        let web = try await api.replaceContent(itemID: original.id, from: Fixtures.tempFile("v2 vom Web"), ifMatch: v1)
        XCTAssertNotEqual(web.contentEtag, v1)

        // 1. The raw call: 412 with the current item.
        do {
            _ = try await api.replaceContent(itemID: original.id, from: Fixtures.tempFile("lokal"), ifMatch: v1)
            XCTFail("412 expected")
        } catch SyncAPIError.conflict(let current) {
            XCTAssertEqual(current?.contentEtag, web.contentEtag)
        }

        // 2. The extension's conflict path.
        let temp = Fixtures.tempDirectory()
        defer { try? FileManager.default.removeItem(at: temp) }
        let context = SyncletReplicatedExtension.Context(client: api, deviceName: "Live-Mac", layout: SpaceLayout(spaces: [.personal()]),
                                                         transferStateDirectory: temp.appending(path: "uploads"))
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("live000000000000"), displayName: "live")
        let now = Date()
        let ext = RecordingExtension(domain: domain, temporaryDirectory: temp) { context }
        let local = TemplateItem(id: original.id, parent: NSFileProviderItemIdentifier("space:personal"), name: name, type: .plainText)
        let localFile = Fixtures.tempFile("meine lokale Änderung \(tag)")
        let base = NSFileProviderItemVersion(contentVersion: Data(v1.utf8), metadataVersion: Data())
        let result = try await ext.modify(item: local, baseVersion: base, changedFields: [.contents], contents: localFile,
                                          context: context, progress: nil)
        XCTAssertTrue(result.shouldFetchContent, "the system fetches the server version")
        XCTAssertEqual(result.item.syncItem?.contentEtag, web.contentEtag)

        let siblings = try await api.children(of: SyncItem.rootID, limit: 1000).items
        let expectedPrefix = "live-conflict-\(tag) (Konflikt Live-Mac "
        let copies = siblings.filter { $0.name.hasPrefix(expectedPrefix) && $0.name.hasSuffix(").txt") }
        XCTAssertEqual(copies.count, 1, "\(siblings.map(\.name))")
        let copy = try XCTUnwrap(copies.first)
        XCTAssertTrue(copy.name == ConflictNaming.name(original: name, device: "Live-Mac", date: now)
                      || copy.name == ConflictNaming.name(original: name, device: "Live-Mac", date: Date()), copy.name)
        XCTAssertEqual(copy.sha256, try TransferEngine.sha256(of: localFile))
        let kept = try await api.item(id: original.id)
        XCTAssertEqual(kept.contentEtag, web.contentEtag, "server version kept")
        XCTAssertEqual(ext.problems.map(\.code), [.conflictCopy])
        print("LIVE: 412 → conflict copy \"\(copy.name)\"")

        try await api.deleteItem(id: copy.id)
        try await api.deleteItem(id: original.id)
    }

    /// `hello` on connect, then `changes` within 3 s of a folder created through the API.
    func testEventStreamHelloAndChangesWithin3s() async throws {
        let live = try await live()
        let token = live.token
        let stream = EventStream(url: EventStream.url(origin: live.server), token: { token })
        let log = SignalLog()
        let consumer = Task {
            do {
                for try await signal in stream.events() { log.append(signal) }
            } catch {
                log.fail(error)
            }
        }
        defer { consumer.cancel() }

        let hello = try await log.wait(timeout: 5) { if case .connected = $0 { true } else { false } }
        let helloIndex = try XCTUnwrap(hello, "no hello within 5 s").index

        // The head before the create: a `changes` signal still at this cursor (a catch-up of
        // something older) does not count.
        let before = try await live.api.cursor()
        let start = Date()
        let folder = try await live.api.createFolder(parentID: SyncItem.rootID, name: "live-sse-\(UUID().uuidString.prefix(8))")
        let changes = try await log.wait(timeout: 3, after: helloIndex + 1) {
            if case .changes(let space, let cursor) = $0 { space == "personal" && cursor != before } else { false }
        }
        XCTAssertNotNil(changes, "no changes within 3 s")
        if let changes {
            print("LIVE: changes \(String(format: "%.3f", changes.at.timeIntervalSince(start))) s after the create")
            // The signal's cursor covers the create (cursors are opaque: checked through /changes,
            // never by comparing them): the create is after `before` but not after the signal's cursor.
            guard case .changes(_, let cursor) = changes.signal else { return XCTFail("not a changes signal") }
            func ids(since cursor: String) async throws -> Set<String> {
                Set(try await live.api.changes(since: cursor).changes.map {
                    switch $0 {
                    case .upsert(let item): item.id
                    case .delete(let id): id
                    }
                })
            }
            let sinceBefore = try await ids(since: before)
            let sinceSignal = try await ids(since: cursor)
            XCTAssertTrue(sinceBefore.contains(folder.id), "the create is a change after the old head")
            XCTAssertFalse(sinceSignal.contains(folder.id), "the signal's cursor already covers the create")
        }
        try await live.api.deleteItem(id: folder.id)
    }

    /// A PNG gets a webp thumbnail once the derivatives worker rendered it (polled like the
    /// extension does, up to ~90 s).
    func testThumbnailForPNG() async throws {
        let live = try await live()
        let png = try await live.api.uploadNewFile(parentID: SyncItem.rootID, name: "live-api-\(UUID().uuidString.prefix(8)).png",
                                                   from: try LiveThumbnailTests.pngFile())
        var thumbnail: SyncThumbnail?
        let started = Date()
        for _ in 1...45 {
            thumbnail = try await live.api.thumbnail(itemID: png.id, size: 256)
            if thumbnail != nil { break }
            try await Task.sleep(for: .seconds(2))
        }
        let data = try XCTUnwrap(thumbnail?.data, "no thumbnail after \(Int(Date().timeIntervalSince(started))) s – is the worker running?")
        XCTAssertEqual(data.prefix(4), Data("RIFF".utf8))
        XCTAssertEqual(data.dropFirst(8).prefix(4), Data("WEBP".utf8))
        XCTAssertEqual(thumbnail?.etag, "\(png.sha256 ?? "")-256")
        print("LIVE: PNG thumbnail \(data.count) B after \(Int(Date().timeIntervalSince(started))) s")
        try await live.api.deleteItem(id: png.id)
    }

    /// Sign-out (`DELETE /devices/current`, what the app's sign-out sends) revokes the device:
    /// the next call with its token is a 401 (`device_revoked`), and it is gone from the list.
    func testSignOutRevokesDevice() async throws {
        let live = try await live()
        let api = SyncAPIClient(baseURL: live.server, token: live.signOutToken)
        let account = try await api.account()
        XCTAssertEqual(account.username, live.user)
        try await api.revokeCurrentDevice()
        do {
            _ = try await api.account()
            XCTFail("401 expected after sign-out")
        } catch SyncAPIError.deviceRevoked {
            print("LIVE: after sign-out → 401 device_revoked")
        } catch SyncAPIError.unauthorized {
            print("LIVE: after sign-out → 401 unauthorized")
        }
        let devices = try await live.api.devices()
        XCTAssertTrue(devices.contains { $0.id == live.deviceID })
        XCTAssertEqual(devices.filter { $0.name == "SyncletKit LiveAPITests sign-out" }.count, 0, "\(devices.map(\.name))")
    }
}

/// Signs in once per process; concurrent callers wait for the same attempt.
private actor LiveSessionCache {
    private var task: Task<LiveAPITests.Session, Error>?
    private(set) var current: LiveAPITests.Session?

    func get(_ make: @escaping @Sendable () async throws -> LiveAPITests.Session) async throws -> LiveAPITests.Session {
        if let task { return try await task.value }
        let task = Task { try await make() }
        self.task = task
        let session = try await task.value
        current = session
        return session
    }
}

/// Signals of an ``EventStream`` with their arrival time.
private final class SignalLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(at: Date, signal: StreamSignal)] = []
    private var failure: Error?

    func append(_ signal: StreamSignal) { lock.withLock { entries.append((Date(), signal)) } }
    func fail(_ error: Error) { lock.withLock { failure = error } }

    func wait(timeout: TimeInterval, after start: Int = 0,
              _ match: (StreamSignal) -> Bool) async throws -> (index: Int, at: Date, signal: StreamSignal)? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let (signals, error) = lock.withLock { (entries, failure) }
            if let found = signals.indices.first(where: { $0 >= start && match(signals[$0].signal) }) {
                return (found, signals[found].at, signals[found].signal)
            }
            if let error { throw error }
            try await Task.sleep(for: .milliseconds(20))
        }
        return nil
    }
}
#endif
