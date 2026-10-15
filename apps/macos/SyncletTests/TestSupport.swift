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
        let response = HTTPURLResponse(url: request.url!, statusCode: mock.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": mock.contentType])!
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
                {"device":{"id":"dev-\(issuedTokens)","name":"Test Mac","platform":"macos","appVersion":"0.1.0",
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

/// Records domain changes instead of touching the system.
final class FakeDomains: FileProviderDomainControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var identifiers: [String] = []
    private(set) var addCalls: [(identifier: String, displayName: String)] = []
    private(set) var removeCalls: [String] = []

    var current: [String] { lock.withLock { identifiers } }

    func addDomain(identifier: String, displayName: String) async throws {
        lock.withLock {
            addCalls.append((identifier, displayName))
            identifiers.append(identifier)
        }
    }

    func removeDomain(identifier: String) async throws {
        lock.withLock {
            removeCalls.append(identifier)
            identifiers.removeAll { $0 == identifier }
        }
    }

    func domainIdentifiers() async throws -> [String] { current }

    func signalEnumerator(domainIdentifier: String, container: NSFileProviderItemIdentifier) async {}
}

final class FakeFinder: FinderIntegrating, @unchecked Sendable {
    var pending: Int?
    private(set) var signalled: [String] = []

    func userVisibleURL(domain: NSFileProviderDomain) async throws -> URL {
        URL(filePath: "/tmp/CloudStorage/\(domain.identifier.rawValue)")
    }

    func pendingItemCount(domain: NSFileProviderDomain) async -> Int? { pending }

    func signalWorkingSet(domain: NSFileProviderDomain) async {
        signalled.append(domain.identifier.rawValue)
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

/// A fresh app-group stand-in plus the account machinery wired to fakes.
@MainActor
struct Harness {
    let directory: URL
    let storage = InMemorySecureStorage()
    let domains = FakeDomains()
    let finder = FakeFinder()
    let manager: AccountManager
    let accounts: AccountsModel

    init() {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-app-tests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        manager = AccountManager(credentials: CredentialStore(storage: storage), accounts: AccountStore(directory: directory),
                                 domains: domains, session: MockURLProtocol.session(), deviceName: "Test Mac",
                                 installationID: { "installation" })
        accounts = AccountsModel(manager: manager, finder: finder)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
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
