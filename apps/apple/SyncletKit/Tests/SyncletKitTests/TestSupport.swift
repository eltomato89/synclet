import Foundation
import XCTest
@testable import SyncletKit

/// Recorded request (body from `httpBody` or `httpBodyStream`).
struct RecordedRequest {
    let request: URLRequest
    let body: Data

    var method: String { request.httpMethod ?? "" }
    var path: String { request.url?.path(percentEncoded: false) ?? "" }
    var query: [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
    }
    func header(_ name: String) -> String? { request.value(forHTTPHeaderField: name) }
    var json: [String: Any]? { try? JSONSerialization.jsonObject(with: body) as? [String: Any] }
    var jsonBody: [String: Any]? { json }
    var bodyString: String { String(decoding: body, as: UTF8.self) }
}

/// Response of the stub.
struct MockResponse {
    var status: Int
    var body: Data
    var headers: [String: String]

    static func json(_ status: Int, _ text: String, headers: [String: String] = [:]) -> MockResponse {
        MockResponse(status: status, body: Data(text.utf8),
                     headers: headers.merging(["Content-Type": "application/json"]) { a, _ in a })
    }

    static func data(_ status: Int, _ body: Data, headers: [String: String] = [:]) -> MockResponse {
        MockResponse(status: status, body: body, headers: headers)
    }

    static func empty(_ status: Int = 204, headers: [String: String] = [:]) -> MockResponse {
        MockResponse(status: status, body: Data(), headers: headers)
    }

    /// Error body in the Sync API format.
    static func error(_ status: Int, _ code: String, item: String? = nil, headers: [String: String] = [:]) -> MockResponse {
        let itemPart = item.map { #","item":\#($0)"# } ?? ""
        return .json(status, #"{"statusCode":\#(status),"message":"\#(code)","code":"\#(code)"\#(itemPart)}"#, headers: headers)
    }
}

/// `URLProtocol` stub: answers through a handler and records every request.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var handler: ((RecordedRequest) throws -> MockResponse)?
    nonisolated(unsafe) private static var recorded: [RecordedRequest] = []
    private static let lock = NSLock()

    static func reset(_ handler: @escaping (RecordedRequest) throws -> MockResponse) {
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
        let recordedRequest = RecordedRequest(request: request, body: Self.readBody(request))
        let handler = Self.lock.withLock { () -> ((RecordedRequest) throws -> MockResponse)? in
            Self.recorded.append(recordedRequest)
            return Self.handler
        }
        do {
            guard let handler else { throw URLError(.badServerResponse) }
            let mock = try handler(recordedRequest)
            let response = HTTPURLResponse(url: request.url!, statusCode: mock.status,
                                           httpVersion: "HTTP/1.1", headerFields: mock.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !mock.body.isEmpty { client?.urlProtocol(self, didLoad: mock.body) }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Test data in the shapes the Synclet server sends (packages/shared/src, apps/server/src/sync).
enum Fixtures {
    static let server = URL(string: "https://synclet.example.test")!
    static let personal = SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien", rootId: "root", canWrite: true)
    static let layout = SpaceLayout(spaces: [personal])

    static func itemJSON(id: String, parentId: String? = "root", type: String = "file", kind: String? = nil,
                         name: String = "Angebot.pdf", version: Int? = 3, contentEtag: String? = "v3",
                         etag: String = "v3", sha256: String? = nil, write: Bool = true, size: Int = 1234) -> String {
        let kind = kind ?? (id == "root" ? "root" : type)
        let parent = parentId.map { "\"\($0)\"" } ?? "null"
        let isFile = type == "file"
        let versionText = isFile ? (version.map(String.init) ?? "null") : "null"
        let contentEtagText = isFile ? (contentEtag.map { "\"\($0)\"" } ?? "null") : "null"
        let shaText = sha256.map { "\"\($0)\"" } ?? "null"
        let isRoot = id == "root"
        let preview = isFile ? #","preview":{"kind":"pdf","thumbnail":false}"# : ""
        return """
        {"id":"\(id)","parentId":\(parent),"type":"\(type)","kind":"\(kind)","name":"\(name)",
         "size":\(isFile ? size : 0),"mime":\(isFile ? "\"application/pdf\"" : "null"),
         "version":\(versionText),"sha256":\(shaText),"etag":"\(etag)","contentEtag":\(contentEtagText),
         "createdAt":"2026-09-01T08:00:00.000Z","modifiedAt":"2026-10-02T12:30:15.123Z",
         "documentId":\(isFile ? "\"\(id)\"" : "null"),
         "capabilities":{"read":true,"write":\(write),"rename":\(write && !isRoot),"move":\(write && !isRoot),"delete":\(write && !isRoot),"addChildren":\(!isFile && write)}\(preview)}
        """
    }

    static func item(id: String, parentId: String? = "root", type: String = "file", kind: String? = nil,
                     name: String = "Angebot.pdf", version: Int? = 3, contentEtag: String? = "v3",
                     etag: String = "v3", sha256: String? = nil) -> SyncItem {
        let json = itemJSON(id: id, parentId: parentId, type: type, kind: kind, name: name, version: version,
                            contentEtag: contentEtag, etag: etag, sha256: sha256)
        return try! JSONDecoder().decode(SyncItem.self, from: Data(json.utf8))
    }

    static func folderJSON(id: String, parentId: String = "root", name: String) -> String {
        itemJSON(id: id, parentId: parentId, type: "folder", name: name, etag: "t0123456789abcdef")
    }

    /// `GET /sync/v1/account` of a Phase 1c server (no `spaces`).
    static let phase1cAccountJSON = """
    {"userId":"0b6f6d0e-7a39-4c1e-9d3b-1f2e3d4c5b6a","email":null,"displayName":"Jens",
     "organizationId":"5e0c1a52-3b7f-4d0e-a8f1-9c2b7d6e4f10:0b6f6d0e-7a39-4c1e-9d3b-1f2e3d4c5b6a",
     "organizationName":"Synclet","slug":"jens","canWrite":true,
     "areas":{"personal":true,"shared":false,"customers":false,"projects":false},
     "quotaBytes":0,"usedBytes":1048576,"maxUploadBytes":10737418240,"cursor":"42"}
    """

    /// `GET /sync/v1/account` of a Phase 2 server.
    static func accountJSON(userId: String = "u1", serverId: String = "srv1", slug: String = "jens",
                            spaces: String = #"[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}]"#) -> String {
        """
        {"userId":"\(userId)","email":"jens@example.test","displayName":"Jens",
         "organizationId":"\(serverId):\(userId)","organizationName":"Synclet","slug":"\(slug)","canWrite":true,
         "spaces":\(spaces),
         "areas":{"personal":true,"shared":false,"customers":false,"projects":false},
         "quotaBytes":0,"usedBytes":0,"maxUploadBytes":10737418240,"cursor":"7"}
        """
    }

    /// `201` of `POST /sync/v1/devices`.
    static func registrationJSON(userId: String = "u1", serverId: String = "srv1", slug: String = "jens",
                                 token: String = "syd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                                 deviceName: String = "Jens' MacBook") -> String {
        """
        {"device":{"id":"9d7c2a1e-0000-4000-8000-000000000001","name":"\(deviceName)","platform":"macos",
                   "appVersion":"0.1.0","createdAt":"2026-10-15T10:00:00.000Z","lastSeenAt":null},
         "token":"\(token)",
         "account":\(accountJSON(userId: userId, serverId: serverId, slug: slug))}
        """
    }

    /// A `ShareLinkWire` (packages/shared/src/index.ts).
    static func shareJSON(url: String, id: String = "s1", itemId: String = "d_1", itemTrashed: Bool = false) -> String {
        """
        {"id":"\(id)","itemId":"\(itemId)","itemName":"Docs","itemType":"folder","url":"\(url)",
         "hasPassword":true,"expiresAt":null,"allowDownload":true,"allowUpload":false,
         "createdAt":"2026-10-01T08:00:00.000Z","revokedAt":null,"hits":4,"itemTrashed":\(itemTrashed)}
        """
    }

    static func trashEntryJSON(id: String = "t1") -> String {
        """
        {"id":"\(id)","itemId":"f_9","type":"file","name":"Alt.pdf","originalPath":"Docs/Alt.pdf",
         "size":2048,"deletedAt":"2026-10-10T08:00:00.000Z","expiresAt":null,"itemCount":1}
        """
    }

    static func client(token: String = "syd_test") -> SyncAPIClient {
        SyncAPIClient(baseURL: server, token: token, session: MockURLProtocol.session())
    }

    static func tempFile(_ text: String) -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-test-\(UUID().uuidString)")
        try! Data(text.utf8).write(to: url)
        return url
    }

    static func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/// Expects a specific ``SyncAPIError``.
func assertThrows(_ expected: SyncAPIError, file: StaticString = #filePath, line: UInt = #line,
                  _ operation: () async throws -> Void) async {
    do {
        try await operation()
        XCTFail("Expected \(expected)", file: file, line: line)
    } catch let error as SyncAPIError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("Wrong error \(error)", file: file, line: line)
    }
}

final class Counter: @unchecked Sendable {
    private var value = 0
    private let lock = NSLock()
    func next() -> Int { lock.withLock { value += 1; return value } }
    var current: Int { lock.withLock { value } }
}

/// `.lproj` sub-bundles of the kit's resource bundle (to test a specific language).
enum TestBundles {
    static func lproj(_ language: String) -> Bundle {
        let path = SyncletKitResources.bundle.path(forResource: language, ofType: "lproj")!
        return Bundle(path: path)!
    }
}
