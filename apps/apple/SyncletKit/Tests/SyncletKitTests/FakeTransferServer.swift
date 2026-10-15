import CryptoKit
import Foundation
import XCTest
@testable import SyncletKit

/// Reply of the ``FakeServerProtocol``: a response, a response whose body breaks off with a
/// network error, or a network error before any response.
enum FakeReply {
    case response(MockResponse)
    case partial(status: Int, headers: [String: String], body: Data, then: URLError.Code)
    case failure(URLError.Code)
}

/// `URLProtocol` routing every request to ``FakeServerProtocol/handler``.
final class FakeServerProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((RecordedRequest) -> FakeReply)?
    static let lock = NSLock()

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeServerProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func client() -> SyncAPIClient {
        SyncAPIClient(baseURL: Fixtures.server, token: "syd_test", session: session())
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let recorded = RecordedRequest(request: request, body: Self.readBody(request))
        guard let handler = Self.lock.withLock({ Self.handler }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        switch handler(recorded) {
        case .response(let mock):
            let response = HTTPURLResponse(url: request.url!, statusCode: mock.status, httpVersion: "HTTP/1.1",
                                           headerFields: mock.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !mock.body.isEmpty { client?.urlProtocol(self, didLoad: mock.body) }
            client?.urlProtocolDidFinishLoading(self)
        case .partial(let status, let headers, let body, let code):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
            // Like a real dropped connection: the bytes arrive, then the error (a synchronous
            // failure would let URLSession discard the bytes still in flight).
            let client = self.client
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                client?.urlProtocol(self, didFailWithError: URLError(code))
            }
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1 << 20)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// In-memory tus 1.0 server (SYNC_API.md §7) plus the few Sync API routes the transfers use.
final class FakeTusServer: @unchecked Sendable {
    enum PatchAction {
        /// Handle normally.
        case proceed
        /// Connection lost before the server stored anything.
        case dropBefore
        /// The server handles the request (stores, maybe publishes) but the response is lost.
        case dropAfter
        /// Answer with this status (plain text), nothing stored.
        case status(Int)
        /// Store the bytes but do not publish; answer with this status in the Sync error
        /// format (a publish failure such as 507: the upload stays resumable, §7.5).
        case storeThenError(Int, code: String)
    }

    struct Upload {
        var length: Int64
        var data = Data()
        var metadata: [String: String]
    }

    private let lock = NSLock()
    private var uploads: [String: Upload] = [:]
    private var nextID = 0
    private(set) var publishedItems: [String] = []
    /// Ranges appended by PATCHes (offset, count), in order.
    private(set) var ranges: [(offset: Int64, count: Int)] = []
    private(set) var requests: [RecordedRequest] = []
    /// Content of the last published upload.
    private(set) var publishedData: Data?
    private(set) var publishedMetadata: [String: String]?
    private var patchNumber = 0
    /// Every request fails with a network error while set.
    var networkDown = false
    /// Called for every PATCH with its 1-based number and offset.
    var onPatch: ((_ number: Int, _ offset: Int64) -> PatchAction)?
    /// Routes not handled by the fake (single-request upload, PUT …).
    var fallback: ((RecordedRequest) -> FakeReply)?

    init() {
        FakeServerProtocol.lock.withLock {
            FakeServerProtocol.handler = { request in self.handle(request) }
        }
    }

    func setNetworkDown(_ down: Bool) { lock.withLock { networkDown = down } }

    /// Adds an existing item to the children listing.
    func seed(_ json: String) { lock.withLock { publishedItems.append(json) } }

    var allRequests: [RecordedRequest] { lock.withLock { requests } }

    /// Forgets all unfinished uploads (expired on the server).
    func expireAll() { lock.withLock { uploads.removeAll() } }

    var uploadCount: Int { lock.withLock { uploads.count } }

    var tusRequests: [RecordedRequest] { lock.withLock { requests.filter { $0.path.hasPrefix("/api/sync/v1/uploads") } } }

    /// Each range appended exactly once, contiguous from 0 to `length`.
    func assertRangesContiguous(length: Int64, file: StaticString = #filePath, line: UInt = #line) {
        let ranges = lock.withLock { self.ranges }
        var expected: Int64 = 0
        for range in ranges {
            XCTAssertEqual(range.offset, expected, "range received twice or out of order", file: file, line: line)
            expected = range.offset + Int64(range.count)
        }
        XCTAssertEqual(expected, length, file: file, line: line)
    }

    static func itemJSON(id: String, parentId: String, name: String, data: Data, modifiedAt: String? = nil,
                         version: Int = 1) -> String {
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return itemJSON(id: id, parentId: parentId, name: name, size: data.count, sha256: sha, modifiedAt: modifiedAt,
                        version: version)
    }

    static func itemJSON(id: String, parentId: String, name: String, size: Int, sha256: String, modifiedAt: String? = nil,
                         version: Int = 1) -> String {
        var json = Fixtures.itemJSON(id: id, parentId: parentId, name: name, version: version, contentEtag: "v\(version)",
                                     etag: "v\(version)", sha256: sha256)
            .replacingOccurrences(of: "\"size\":1234", with: "\"size\":\(size)")
        if let modifiedAt {
            json = json.replacingOccurrences(of: "\"modifiedAt\":\"2026-10-02T12:30:15.123Z\"", with: "\"modifiedAt\":\"\(modifiedAt)\"")
        }
        return json
    }

    private func text(_ status: Int, _ message: String, headers: [String: String] = [:]) -> FakeReply {
        .response(MockResponse(status: status, body: Data(message.utf8),
                               headers: headers.merging(["Tus-Resumable": "1.0.0", "Content-Type": "text/plain"]) { a, _ in a }))
    }

    private func handle(_ request: RecordedRequest) -> FakeReply {
        lock.lock()
        requests.append(request)
        if networkDown {
            lock.unlock()
            return .failure(.networkConnectionLost)
        }
        let path = request.path
        let tusPrefix = "/api/sync/v1/uploads"
        if path == tusPrefix, request.method == "POST" {
            defer { lock.unlock() }
            let length = Int64(request.header("Upload-Length") ?? "") ?? -1
            let metadata = Self.decodeMetadata(request.header("Upload-Metadata") ?? "")
            nextID += 1
            let id = "u\(nextID)"
            if length == 0 {
                let json = publish(Upload(length: 0, metadata: metadata), id: id)
                return .response(.json(201, json, headers: ["Location": "\(tusPrefix)/\(id)", "X-Synclet-Item": "f_\(id)"]))
            }
            uploads[id] = Upload(length: length, metadata: metadata)
            return text(201, "", headers: ["Location": "\(tusPrefix)/\(id)"])
        }
        if path.hasPrefix(tusPrefix + "/") {
            let id = String(path.dropFirst(tusPrefix.count + 1))
            switch request.method {
            case "HEAD":
                defer { lock.unlock() }
                guard let upload = uploads[id] else { return text(404, "The file for this url was not found\n") }
                return text(200, "", headers: ["Upload-Offset": String(upload.data.count), "Upload-Length": String(upload.length),
                                               "Cache-Control": "no-store"])
            case "DELETE":
                defer { lock.unlock() }
                guard uploads.removeValue(forKey: id) != nil else { return text(404, "not found\n") }
                return text(204, "")
            case "PATCH":
                guard var upload = uploads[id] else {
                    lock.unlock()
                    return text(404, "The file for this url was not found\n")
                }
                patchNumber += 1
                let offset = Int64(request.header("Upload-Offset") ?? "") ?? -1
                let hook = onPatch
                let number = patchNumber
                lock.unlock()
                let action = hook?(number, offset) ?? .proceed
                lock.lock()
                defer { lock.unlock() }
                switch action {
                case .dropBefore: return .failure(.networkConnectionLost)
                case .status(let status): return text(status, "busy\n")
                case .proceed, .dropAfter, .storeThenError: break
                }
                guard offset == Int64(upload.data.count) else { return text(409, "Upload-Offset mismatch\n") }
                upload.data.append(request.body)
                if !request.body.isEmpty { ranges.append((offset, request.body.count)) }
                if case .storeThenError(let status, let code) = action {
                    uploads[id] = upload
                    return .response(.error(status, code))
                }
                let reply: FakeReply
                if Int64(upload.data.count) == upload.length {
                    uploads[id] = nil
                    let json = publish(upload, id: id)
                    reply = .response(.json(200, json, headers: ["X-Synclet-Item": "f_\(id)", "Tus-Resumable": "1.0.0"]))
                } else {
                    uploads[id] = upload
                    reply = text(204, "", headers: ["Upload-Offset": String(upload.data.count)])
                }
                if case .dropAfter = action { return .failure(.networkConnectionLost) }
                return reply
            default:
                lock.unlock()
                return text(405, "")
            }
        }
        if request.method == "GET", path.hasSuffix("/children") {
            defer { lock.unlock() }
            return .response(.json(200, #"{"items":[\#(publishedItems.joined(separator: ","))],"nextPageToken":null,"cursor":"1"}"#))
        }
        let fallback = self.fallback
        lock.unlock()
        if let fallback { return fallback(request) }
        return .response(.empty(500))
    }

    /// Caller holds the lock.
    private func publish(_ upload: Upload, id: String) -> String {
        let json = Self.itemJSON(id: "f_\(id)", parentId: upload.metadata["parentId"] ?? "root",
                                 name: upload.metadata["name"] ?? "", data: upload.data,
                                 modifiedAt: upload.metadata["modifiedAt"].flatMap { $0.isEmpty ? nil : $0 })
        publishedItems.append(json)
        publishedData = upload.data
        publishedMetadata = upload.metadata
        return json
    }

    static func decodeMetadata(_ header: String) -> [String: String] {
        var result: [String: String] = [:]
        for pair in header.split(separator: ",") {
            let parts = pair.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1)
            guard let key = parts.first else { continue }
            let value = parts.count > 1 ? Data(base64Encoded: String(parts[1])).flatMap { String(data: $0, encoding: .utf8) } : ""
            result[String(key)] = value ?? ""
        }
        return result
    }
}

enum TransferFixtures {
    /// File of `size` bytes with a position-dependent pattern (misplaced ranges change the hash).
    static func patternFile(size: Int, seed: UInt8 = 0) -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-test-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try! FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        // One 1 MiB base block; every block gets its index and the seed stamped into its
        // first bytes, so each block is distinct (a misplaced range changes the hash).
        let block = 1 << 20
        let base = Data((0..<block).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ Int(seed)) })
        var written = 0
        var blockIndex: UInt64 = 0
        while written < size {
            let count = min(block, size - written)
            var bytes = base.prefix(count)
            withUnsafeBytes(of: (blockIndex &+ 1) &* 0x9E37_79B9_7F4A_7C15 ^ UInt64(seed)) { stamp in
                for i in 0..<min(8, count) { bytes[bytes.startIndex + i] = stamp[i] }
            }
            try! handle.write(contentsOf: bytes)
            written += count
            blockIndex += 1
        }
        return url
    }

    /// Sparse file of `size` zero bytes (fast for threshold tests).
    static func sparseFile(size: Int) -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "synclet-test-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try! FileHandle(forWritingTo: url)
        try! handle.truncate(atOffset: UInt64(size))
        try! handle.close()
        return url
    }
}

/// Records the delays the engine waits for (instead of sleeping).
final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Duration] = []
    var delays: [Duration] { lock.withLock { values } }
    var sleep: @Sendable (Duration) async throws -> Void {
        { [self] duration in lock.withLock { values.append(duration) } }
    }
}
