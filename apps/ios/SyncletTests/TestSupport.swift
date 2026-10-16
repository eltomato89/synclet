import FileProvider
import Foundation
import SyncletKit
@testable import Synclet

/// Recorded request (body from `httpBody` or `httpBodyStream`).
struct RecordedRequest {
    let request: URLRequest
    let body: Data

    var method: String { request.httpMethod ?? "" }
    var path: String { request.url?.path(percentEncoded: false) ?? "" }
    var host: String { request.url?.host() ?? "" }
    var json: [String: Any]? { try? JSONSerialization.jsonObject(with: body) as? [String: Any] }
}

struct MockResponse {
    var status: Int
    var body: Data
    var contentType: String
    /// Extra response headers (`ETag` …).
    var headers: [String: String] = [:]
    /// Fails the request with this transport error instead of answering.
    var failure: URLError.Code?

    /// A transport failure (no HTTP response).
    static func failure(_ code: URLError.Code) -> MockResponse {
        MockResponse(status: 0, body: Data(), contentType: "", failure: code)
    }

    static func data(_ status: Int, _ body: Data, contentType: String = "application/octet-stream",
                     headers: [String: String] = [:]) -> MockResponse {
        MockResponse(status: status, body: body, contentType: contentType, headers: headers)
    }

    static func json(_ status: Int, _ text: String) -> MockResponse {
        MockResponse(status: status, body: Data(text.utf8), contentType: "application/json")
    }

    static func html(_ status: Int, _ text: String = "<html><body>hello</body></html>") -> MockResponse {
        MockResponse(status: status, body: Data(text.utf8), contentType: "text/html")
    }

    static func empty(_ status: Int = 204) -> MockResponse {
        MockResponse(status: status, body: Data(), contentType: "text/plain")
    }
}

/// `URLProtocol` stub: answers through a handler and records every request.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var handler: ((RecordedRequest) -> MockResponse)?
    nonisolated(unsafe) private static var recorded: [RecordedRequest] = []
    private static let lock = NSLock()

    static func reset(_ handler: @escaping (RecordedRequest) -> MockResponse) {
        lock.withLock {
            self.handler = handler
            recorded = []
        }
    }

    static var requests: [RecordedRequest] { lock.withLock { recorded } }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        let recordedRequest = RecordedRequest(request: request, body: body)
        let handler = Self.lock.withLock { () -> ((RecordedRequest) -> MockResponse)? in
            Self.recorded.append(recordedRequest)
            return Self.handler
        }
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let mock = handler(recordedRequest)
        if let failure = mock.failure {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
            return
        }
        let headers = mock.headers.merging(["Content-Type": mock.contentType]) { current, _ in current }
        let response = HTTPURLResponse(url: request.url!, statusCode: mock.status, httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: mock.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A fake Synclet server: one per host, with its own server id. Device tokens count up, so a
/// second login yields a different token.
final class FakeSynclet: @unchecked Sendable {
    let serverId: String
    let userId: String
    let username: String
    private(set) var issuedTokens = 0
    private let lock = NSLock()

    init(serverId: String, userId: String = "u1", username: String = "jens") {
        self.serverId = serverId
        self.userId = userId
        self.username = username
    }

    var accountJSON: String {
        """
        {"userId":"\(userId)","email":null,"displayName":"Jens","organizationId":"\(serverId):\(userId)",
         "organizationName":"Synclet","slug":"\(username)","canWrite":true,
         "spaces":[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}],
         "quotaBytes":0,"usedBytes":0,"maxUploadBytes":10737418240,"cursor":"7"}
        """
    }

    func respond(_ request: RecordedRequest) -> MockResponse {
        switch (request.method, request.path) {
        case ("GET", "/api/health"):
            return .json(200, #"{"ok":true}"#)
        case ("GET", "/api/sync/v1/capabilities"):
            return .json(401, #"{"statusCode":401,"message":"unauthorized","code":"unauthorized"}"#)
        case ("POST", "/api/auth/app/token"):
            return .json(200, """
                {"accessToken":"jwt-\(serverId)","refreshToken":"refresh-\(serverId)",
                 "user":{"id":"\(userId)","username":"\(username)","displayName":"Jens","email":null,"role":"admin"}}
                """)
        case ("POST", "/api/sync/v1/devices"):
            let token = lock.withLock { () -> String in
                issuedTokens += 1
                return "syd_\(serverId)_\(issuedTokens)"
            }
            return .json(201, """
                {"device":{"id":"dev-\(issuedTokens)","name":"Test iPhone","platform":"ios","appVersion":"0.1.0",
                           "createdAt":"2026-10-15T10:00:00.000Z","lastSeenAt":null},
                 "token":"\(token)","account":\(accountJSON)}
                """)
        case ("GET", "/api/sync/v1/account"):
            return .json(200, accountJSON)
        case ("POST", "/api/auth/logout"), ("DELETE", "/api/sync/v1/devices/current"):
            return .empty()
        default:
            return .json(404, #"{"statusCode":404,"message":"not found","code":"not_found"}"#)
        }
    }
}

/// Records domain changes and signals instead of touching the system.
final class FakeDomains: FileProviderDomainControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var identifiers: [String] = []
    private var adds: [(identifier: String, displayName: String)] = []
    private var removes: [String] = []
    private var signals: [(domain: String, container: NSFileProviderItemIdentifier)] = []

    var current: [String] { lock.withLock { identifiers } }
    var addCalls: [(identifier: String, displayName: String)] { lock.withLock { adds } }
    var removeCalls: [String] { lock.withLock { removes } }
    var signalled: [(domain: String, container: NSFileProviderItemIdentifier)] { lock.withLock { signals } }

    func addDomain(identifier: String, displayName: String) async throws {
        lock.withLock {
            adds.append((identifier, displayName))
            identifiers.append(identifier)
        }
    }

    func removeDomain(identifier: String) async throws {
        lock.withLock {
            removes.append(identifier)
            identifiers.removeAll { $0 == identifier }
        }
    }

    func domainIdentifiers() async throws -> [String] { current }

    func signalEnumerator(domainIdentifier: String, container: NSFileProviderItemIdentifier) async {
        lock.withLock { signals.append((domainIdentifier, container)) }
    }
}

/// Records which domains had their throttled errors lifted.
final class FakeResolver: FileProviderResolving, @unchecked Sendable {
    private let lock = NSLock()
    private var authentication: [String] = []
    private var transient: [String] = []

    /// Domains whose `.notAuthenticated` throttling was lifted.
    var resolvedAuthentication: [String] { lock.withLock { authentication } }
    var resolvedTransient: [String] { lock.withLock { transient } }

    func resolveAuthentication(domain: NSFileProviderDomain) async {
        lock.withLock { authentication.append(domain.identifier.rawValue) }
    }

    func resolveTransientErrors(domain: NSFileProviderDomain) async {
        lock.withLock { transient.append(domain.identifier.rawValue) }
    }
}

/// Returns a prepared redirect instead of opening a browser.
@MainActor
final class FakeBrowser: WebAuthenticating {
    /// Builds the redirect from the authorize URL (whose `state` it can echo).
    var redirect: (URL) throws -> URL
    private(set) var openedURLs: [URL] = []

    init(redirect: @escaping (URL) throws -> URL) {
        self.redirect = redirect
    }

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        openedURLs.append(url)
        return try redirect(url)
    }

    static func query(_ url: URL) -> [String: String] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
    }

    /// Echoes the state with a code, like the server's `/app-login`.
    static let echo: (URL) throws -> URL = { url in
        URL(string: "synclet://oauth?code=c0de&state=\(query(url)["state"] ?? "")")!
    }
}

/// A fresh app-group stand-in plus the account machinery wired to fakes (in-memory keychain,
/// private `UserDefaults` suite).
@MainActor
struct Harness {
    let directory: URL
    let storage = InMemorySecureStorage()
    let domains = FakeDomains()
    let resolver = FakeResolver()
    let defaultsSuite = "synclet-tests-\(UUID().uuidString)"
    let defaults: UserDefaults
    let manager: AccountManager
    let accounts: AccountsModel

    init() {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-app-tests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: defaultsSuite)!
        manager = AccountManager(credentials: CredentialStore(storage: storage), accounts: AccountStore(directory: directory),
                                 domains: domains, session: MockURLProtocol.session(), deviceName: "Test iPhone",
                                 installationID: { "installation" })
        accounts = AccountsModel(manager: manager, resolver: resolver, defaults: defaults)
    }

    /// Another model over the same store and defaults (an app relaunch).
    func relaunch() -> AccountsModel {
        AccountsModel(manager: manager, resolver: resolver, defaults: defaults)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
        UserDefaults().removePersistentDomain(forName: defaultsSuite)
    }

    /// Routes each host to its fake server.
    static func serve(_ servers: [String: FakeSynclet]) {
        MockURLProtocol.reset { request in
            guard let server = servers[request.host] else { return .html(404) }
            return server.respond(request)
        }
    }

    func tokens(_ server: FakeSynclet) -> AppTokens {
        AppTokens(accessToken: "jwt-\(server.serverId)", refreshToken: "refresh-\(server.serverId)",
                  user: PublicUser(id: server.userId, username: server.username, displayName: "Jens", email: nil, role: "admin"))
    }
}

/// Polls `condition` until it holds or `timeout` passes.
@MainActor
func eventually(timeout: Duration = .seconds(3), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

// MARK: - Browser

/// Builds `SyncItem`s for the browser tests.
enum Items {
    static func file(_ name: String, id: String? = nil, parent: String = "root", size: Int64 = 3,
                     version: Int = 1, etag: String? = nil, modified: String = "2026-10-01T10:00:00.000Z",
                     thumbnail: Bool = false) -> SyncItem {
        let id = id ?? "f-\(name)"
        return SyncItem(id: id, parentId: parent, type: .file, kind: .file, name: name, size: size,
                        mime: "text/plain", version: version, etag: etag ?? "e-\(id)-\(version)",
                        contentEtag: "v\(version)", createdAt: modified, modifiedAt: modified, documentId: id,
                        capabilities: SyncCapabilities(read: true, write: true, rename: true, move: true, delete: true),
                        preview: SyncPreview(kind: "image", thumbnail: thumbnail))
    }

    static func folder(_ name: String, id: String? = nil, parent: String = "root",
                       modified: String = "2026-10-01T10:00:00.000Z") -> SyncItem {
        let id = id ?? "d-\(name)"
        return SyncItem(id: id, parentId: parent, type: .folder, kind: .folder, name: name, etag: "e-\(id)",
                        createdAt: modified, modifiedAt: modified,
                        capabilities: SyncCapabilities(read: true, write: true, rename: true, move: true,
                                                       delete: true, addChildren: true))
    }

    static func json(_ value: some Encodable) -> Data {
        try! JSONEncoder().encode(value)
    }

    static func error(_ status: Int, _ code: String, item: SyncItem? = nil) -> MockResponse {
        var body: [String: Any] = ["statusCode": status, "message": "\(code) message", "code": code]
        if let item { body["item"] = try! JSONSerialization.jsonObject(with: json(item)) }
        return .json(status, String(data: try! JSONSerialization.data(withJSONObject: body), encoding: .utf8)!)
    }
}

/// A fake Sync API for the folder tests: children per folder (paginated), mutations answered by
/// `override` first (`nil` falls through to the defaults).
final class FakeFolderServer: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: [SyncItem]]
    private var overrideHandler: ((RecordedRequest) -> MockResponse?)?
    /// Items per children page (`nil` = all in one page).
    var pageSize: Int?

    init(_ children: [String: [SyncItem]]) {
        storage = children
    }

    var children: [String: [SyncItem]] {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }

    var override: ((RecordedRequest) -> MockResponse?)? {
        get { lock.withLock { overrideHandler } }
        set { lock.withLock { overrideHandler = newValue } }
    }

    static let base = URL(string: "https://files.test")!

    func client() -> SyncAPIClient {
        SyncAPIClient(baseURL: Self.base, token: "syd_test", session: MockURLProtocol.session())
    }

    func install() {
        MockURLProtocol.reset { [self] request in respond(request) }
    }

    func respond(_ request: RecordedRequest) -> MockResponse {
        if let override, let response = override(request) { return response }
        let parts = request.path.split(separator: "/").map(String.init)
        // api sync v1 items <id> [children]
        guard parts.count >= 4, parts[0] == "api", parts[1] == "sync", parts[2] == "v1", parts[3] == "items" else {
            return Items.error(404, "not_found")
        }
        switch (request.method, parts.count) {
        case ("GET", 6) where parts[5] == "children":
            guard let all = children[parts[4]] else { return Items.error(404, "not_found") }
            let items = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let query = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
            let start = Int(query["pageToken"] ?? "") ?? 0
            let end = pageSize.map { min(all.count, start + $0) } ?? all.count
            let next = end < all.count ? String(end) : nil
            return .data(200, Items.json(SyncChildrenPage(items: Array(all[start..<end]), nextPageToken: next, cursor: "1")),
                         contentType: "application/json")
        case ("POST", 4):
            let name = request.json?["name"] as? String ?? "?"
            let parent = request.json?["parentId"] as? String ?? "root"
            return .data(201, Items.json(Items.folder(name, parent: parent)), contentType: "application/json")
        case ("PATCH", 5):
            let id = parts[4]
            let existing = children.values.flatMap { $0 }.first { $0.id == id } ?? Items.file(id)
            var updated = existing
            if let name = request.json?["name"] as? String { updated.name = name }
            if let parent = request.json?["parentId"] as? String { updated.parentId = parent }
            return .data(200, Items.json(updated), contentType: "application/json")
        case ("DELETE", 5):
            return .empty(204)
        default:
            return Items.error(404, "not_found")
        }
    }
}

/// Records `signal(accountKey)` calls.
@MainActor
final class SignalRecorder {
    private(set) var keys: [String] = []

    var callback: (String) async -> Void {
        { [weak self] key in self?.keys.append(key) }
    }
}
