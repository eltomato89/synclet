import Foundation

/// Result of a content download.
public struct SyncDownloadResult: Sendable, Hashable {
    /// Destination file (complete content, also after a range download).
    public var fileURL: URL
    /// `contentEtag` of the downloaded state (from the `ETag` header, unquoted).
    public var etag: String?
    /// 200 (complete) or 206 (partial content appended).
    public var statusCode: Int
    /// `Content-Type` of the response.
    public var mime: String?

    public init(fileURL: URL, etag: String?, statusCode: Int, mime: String?) {
        self.fileURL = fileURL
        self.etag = etag
        self.statusCode = statusCode
        self.mime = mime
    }
}

/// A thumbnail (`GET /items/:id/thumbnail`).
public struct SyncThumbnail: Sendable, Hashable {
    /// `image/webp` bytes.
    public var data: Data
    /// `"<sha256>-<size>"` (unquoted).
    public var etag: String?

    public init(data: Data, etag: String?) {
        self.data = data
        self.etag = etag
    }
}

/// Client of the Synclet Sync API v1 (docs/sync/SYNC_API.md).
///
/// Platform neutral (iOS/macOS), stateless and thread safe. `baseURL` is the server
/// origin (`https://files.example.com`); the API lives below `<origin>/api`, the Sync
/// API below `<origin>/api/sync/v1`. Authenticates with the bearer token returned by
/// `token` on every request – normally the device token (`syd_…`).
///
/// All errors are thrown as ``SyncAPIError`` (cancellation as `CancellationError`).
public final class SyncAPIClient: Sendable {
    /// Server origin (scheme, host, port).
    public let baseURL: URL
    /// `<origin>/api`.
    public let apiBaseURL: URL
    /// `<origin>/api/sync/v1`.
    public let syncBaseURL: URL
    let session: URLSession
    private let token: @Sendable () async throws -> String

    /// - Parameters:
    ///   - baseURL: server origin (see ``ServerURL/normalize(_:)``).
    ///   - token: returns the bearer token (device token, or an access token for the registration).
    ///   - session: URLSession (replaceable by a `URLProtocol` stub in tests).
    public init(baseURL: URL, token: @escaping @Sendable () async throws -> String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiBaseURL = Self.apiBaseURL(origin: baseURL)
        self.syncBaseURL = apiBaseURL.appending(path: "sync").appending(path: "v1")
        self.session = session
        self.token = token
    }

    /// Variant with a fixed token.
    public convenience init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.init(baseURL: baseURL, token: { token }, session: session)
    }

    /// `<origin>/api` (any path of `origin` is dropped).
    public static func apiBaseURL(origin: URL) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = "/api"
        components.query = nil
        components.fragment = nil
        return components.url ?? origin.appending(path: "api")
    }

    // MARK: - Devices (§2.2)

    /// `POST /devices` – registers this device. Needs a client with the **access token**
    /// of the login. The returned token is delivered only once and must be stored at once.
    public func registerDevice(name: String, platform: SyncPlatform, appVersion: String,
                               installationId: String? = nil) async throws -> SyncDeviceRegistration {
        struct Body: Encodable { let name: String; let platform: SyncPlatform; let appVersion: String; let installationId: String? }
        return try await send(.post, sync(["devices"]),
                              body: Body(name: name, platform: platform, appVersion: appVersion, installationId: installationId))
    }

    /// `GET /devices` – own, not revoked devices.
    public func devices() async throws -> [SyncDevice] {
        try await send(.get, sync(["devices"]))
    }

    /// `DELETE /devices/:id`.
    public func revokeDevice(id: String) async throws {
        try await sendNoContent(.delete, sync(["devices", id]))
    }

    /// `DELETE /devices/current` – sign out with the device token.
    public func revokeCurrentDevice() async throws {
        try await sendNoContent(.delete, sync(["devices", "current"]))
    }

    // MARK: - Account (§3)

    /// `GET /account`.
    public func account() async throws -> SyncAccount {
        try await send(.get, sync(["account"]))
    }

    /// `GET /capabilities`; a `404` (server older than Phase 1c) yields all `false`.
    public func capabilities() async throws -> SyncServerCapabilities {
        do {
            return try await send(.get, sync(["capabilities"]))
        } catch SyncAPIError.notFound {
            return SyncServerCapabilities()
        }
    }

    // MARK: - Items (§4)

    /// `GET /items/:id`.
    public func item(id: String) async throws -> SyncItem {
        try await send(.get, sync(["items", id]))
    }

    /// `GET /items/:id/children` – one page (limit default 500, max 1000).
    public func children(of id: String, pageToken: String? = nil, limit: Int? = nil) async throws -> SyncChildrenPage {
        try await send(.get, sync(["items", id, "children"]), query: [
            ("pageToken", pageToken),
            ("limit", limit.map(String.init)),
        ])
    }

    // MARK: - Changes (§5)

    /// `GET /cursor` – current change cursor.
    public func cursor() async throws -> String {
        let result: SyncCursor = try await send(.get, sync(["cursor"]))
        return result.cursor
    }

    /// `GET /changes` – changes since `cursor` (throws ``SyncAPIError/cursorExpired`` on 410).
    public func changes(since cursor: String, limit: Int? = nil) async throws -> SyncChangesPage {
        try await send(.get, sync(["changes"]), query: [
            ("cursor", cursor),
            ("limit", limit.map(String.init)),
        ])
    }

    // MARK: - Content (§6)

    /// `GET /items/:id/content` – downloads the content into `destination`.
    ///
    /// - Parameters:
    ///   - resumeFrom: > 0 ⇒ `Range: bytes=<offset>-`; a `206` is appended to the existing
    ///     file, a `200` replaces it.
    ///   - ifRange: validator for a resumed download (`contentEtag`); the server answers
    ///     `200` with the whole file when it no longer matches.
    ///   - ifNoneMatch: `contentEtag` of the local state ⇒ `304` throws ``SyncAPIError/notModified``.
    ///   - progress: filled with the progress of the transfer.
    public func downloadContent(itemID: String, to destination: URL, resumeFrom offset: Int64 = 0,
                                ifRange: String? = nil, ifNoneMatch: String? = nil,
                                progress: Progress? = nil) async throws -> SyncDownloadResult {
        var request = try await makeRequest(.get, sync(["items", itemID, "content"]))
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        if offset > 0 {
            request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
            if let ifRange { request.setValue(Self.quoted(ifRange), forHTTPHeaderField: "If-Range") }
        }
        if let ifNoneMatch {
            request.setValue(Self.quoted(ifNoneMatch), forHTTPHeaderField: "If-None-Match")
        }

        let delegate = ProgressTaskDelegate(progress: progress)
        let (tempURL, response) = try await perform { try await self.session.download(for: request, delegate: delegate) }
        defer { try? FileManager.default.removeItem(at: tempURL) }
        let http = try Self.httpResponse(response)

        switch http.statusCode {
        case 200:
            let fm = FileManager.default
            if fm.fileExists(atPath: destination.path) {
                try fm.removeItem(at: destination)
            }
            try fm.moveItem(at: tempURL, to: destination)
        case 206:
            try Self.append(contentsOf: tempURL, to: destination)
        case 304:
            throw SyncAPIError.notModified
        default:
            let data = (try? Data(contentsOf: tempURL)) ?? Data()
            throw Self.error(http, data: data)
        }
        return SyncDownloadResult(
            fileURL: destination,
            etag: http.value(forHTTPHeaderField: "ETag").map(Self.unquoted),
            statusCode: http.statusCode,
            mime: http.value(forHTTPHeaderField: "Content-Type")
        )
    }

    /// `PUT /items/:id/content` – replaces the content (raw bytes from `fileURL`).
    ///
    /// - Parameters:
    ///   - ifMatch: `contentEtag` the change is based on (required; `*` = any version).
    ///   - modifiedAt: sent as `X-Synclet-Modified-At` (sets the file's `modifiedAt`).
    /// - Throws: ``SyncAPIError/conflict(current:)`` on a version mismatch (412).
    public func replaceContent(itemID: String, from fileURL: URL, ifMatch: String,
                               modifiedAt: Date? = nil, progress: Progress? = nil) async throws -> SyncItem {
        var request = try await makeRequest(.put, sync(["items", itemID, "content"]))
        request.setValue(Self.quoted(ifMatch), forHTTPHeaderField: "If-Match")
        Self.applyUploadHeaders(&request, fileURL: fileURL, modifiedAt: modifiedAt)
        return try await upload(request, fileURL: fileURL, progress: progress)
    }

    /// `POST /items/upload` – creates a new file.
    ///
    /// - Parameter onConflict: `.fail` ⇒ ``SyncAPIError/nameConflict(existing:)``;
    ///   `.rename` ⇒ the server picks a free name (see `name` of the result).
    public func uploadNewFile(parentID: String, name: String, from fileURL: URL,
                              onConflict: SyncNameConflictPolicy = .fail,
                              modifiedAt: Date? = nil, progress: Progress? = nil) async throws -> SyncItem {
        var request = try await makeRequest(.post, sync(["items", "upload"]), query: [
            ("parentId", parentID),
            ("name", name),
            ("onConflict", onConflict.rawValue),
        ])
        Self.applyUploadHeaders(&request, fileURL: fileURL, modifiedAt: modifiedAt)
        return try await upload(request, fileURL: fileURL, progress: progress)
    }

    // MARK: - Structure (§8)

    /// `POST /items` – creates a folder.
    public func createFolder(parentID: String, name: String,
                             onConflict: SyncNameConflictPolicy = .fail) async throws -> SyncItem {
        struct Body: Encodable {
            let parentId: String
            let type = "folder"
            let name: String
            let onConflict: SyncNameConflictPolicy
        }
        return try await send(.post, sync(["items"]), body: Body(parentId: parentID, name: name, onConflict: onConflict))
    }

    /// `PATCH /items/:id` – rename and/or move (only the given fields are sent).
    public func updateItem(id: String, name: String? = nil, parentID: String? = nil,
                           ifMatch: String? = nil) async throws -> SyncItem {
        struct Body: Encodable { let name: String?; let parentId: String? }
        var headers: [String: String] = [:]
        if let ifMatch { headers["If-Match"] = Self.quoted(ifMatch) }
        return try await send(.patch, sync(["items", id]), body: Body(name: name, parentId: parentID), headers: headers)
    }

    /// `PATCH /items/:id` with a new name.
    public func rename(id: String, to name: String, ifMatch: String? = nil) async throws -> SyncItem {
        try await updateItem(id: id, name: name, ifMatch: ifMatch)
    }

    /// `PATCH /items/:id` with a new parent (and optionally a new name).
    public func move(id: String, toParent parentID: String, name: String? = nil,
                     ifMatch: String? = nil) async throws -> SyncItem {
        try await updateItem(id: id, name: name, parentID: parentID, ifMatch: ifMatch)
    }

    /// `DELETE /items/:id` – moves the item (and its subtree) to the user's trash.
    public func deleteItem(id: String) async throws {
        try await sendNoContent(.delete, sync(["items", id]))
    }

    // MARK: - Previews (§9)

    /// URL of `GET /items/:id/thumbnail?size=` (256 or 1024). Needs `Authorization`
    /// (or a download token as `dt`).
    public func thumbnailURL(itemID: String, size: Int = 256) throws -> URL {
        try makeURL(sync(["items", itemID, "thumbnail"]), query: [("size", String(size))])
    }

    /// Loads a thumbnail; `nil` when the server has none (yet) (404, 415).
    /// - Throws: ``SyncAPIError/notModified`` when `ifNoneMatch` still matches.
    public func thumbnail(itemID: String, size: Int = 256, ifNoneMatch: String? = nil) async throws -> SyncThumbnail? {
        var request = try await makeRequest(.get, sync(["items", itemID, "thumbnail"]), query: [("size", String(size))])
        request.setValue("image/webp, */*", forHTTPHeaderField: "Accept")
        if let ifNoneMatch { request.setValue(Self.quoted(ifNoneMatch), forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await perform { try await self.session.data(for: request) }
        let http = try Self.httpResponse(response)
        switch http.statusCode {
        case 200: return SyncThumbnail(data: data, etag: http.value(forHTTPHeaderField: "ETag").map(Self.unquoted))
        case 304: throw SyncAPIError.notModified
        case 404, 415: return nil
        default: throw Self.error(http, data: data)
        }
    }

    // MARK: - Building requests

    enum Method: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

    /// Path below `<origin>/api/sync/v1`.
    private func sync(_ segments: [String]) -> [String] { ["sync", "v1"] + segments }

    /// Strict encoding of path segments and query values (also `+`, `&`, `/`).
    private static let strictAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: strictAllowed) ?? value
    }

    /// URL `<origin>/api/<segments>?<query>`.
    func makeURL(_ segments: [String], query: [(String, String?)] = []) throws -> URL {
        guard var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false) else {
            throw SyncAPIError.invalidResponse("Invalid base URL \(apiBaseURL)")
        }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        path += segments.map { "/" + Self.encode($0) }.joined()
        components.percentEncodedPath = path
        let items = query.compactMap { name, value in value.map { "\(Self.encode(name))=\(Self.encode($0))" } }
        components.percentEncodedQuery = items.isEmpty ? nil : items.joined(separator: "&")
        guard let url = components.url else {
            throw SyncAPIError.invalidResponse("Invalid URL")
        }
        return url
    }

    func makeRequest(_ method: Method, _ segments: [String], query: [(String, String?)] = []) async throws -> URLRequest {
        var request = URLRequest(url: try makeURL(segments, query: query))
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        try await authorize(&request)
        return request
    }

    /// Sets `Authorization: Bearer <token>` (used by the transfer classes for absolute URLs).
    func authorize(_ request: inout URLRequest) async throws {
        let bearer: String
        do {
            bearer = try await token()
        } catch let error as SyncAPIError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SyncAPIError.unauthorized(message: String(describing: error))
        }
        if !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
    }

    private func send<T: Decodable>(_ method: Method, _ segments: [String], query: [(String, String?)] = [],
                                    body: (any Encodable)? = nil, headers: [String: String] = [:]) async throws -> T {
        let data = try await sendRaw(method, segments, query: query, body: body, headers: headers)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SyncAPIError.invalidResponse(String(describing: error))
        }
    }

    private func sendNoContent(_ method: Method, _ segments: [String], body: (any Encodable)? = nil) async throws {
        _ = try await sendRaw(method, segments, query: [], body: body, headers: [:])
    }

    private func sendRaw(_ method: Method, _ segments: [String], query: [(String, String?)],
                         body: (any Encodable)?, headers: [String: String]) async throws -> Data {
        var request = try await makeRequest(method, segments, query: query)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await perform { try await self.session.data(for: request) }
        let http = try Self.httpResponse(response)
        guard (200...299).contains(http.statusCode) else {
            throw Self.error(http, data: data)
        }
        return data
    }

    private func upload(_ request: URLRequest, fileURL: URL, progress: Progress?) async throws -> SyncItem {
        let delegate = ProgressTaskDelegate(progress: progress)
        let (data, response) = try await perform {
            try await self.session.upload(for: request, fromFile: fileURL, delegate: delegate)
        }
        let http = try Self.httpResponse(response)
        guard (200...299).contains(http.statusCode) else {
            throw Self.error(http, data: data)
        }
        do {
            return try JSONDecoder().decode(SyncItem.self, from: data)
        } catch {
            throw SyncAPIError.invalidResponse(String(describing: error))
        }
    }

    private static func applyUploadHeaders(_ request: inout URLRequest, fileURL: URL, modifiedAt: Date?) {
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
            request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        }
        if let modifiedAt {
            request.setValue(SyncDate.format(modifiedAt), forHTTPHeaderField: "X-Synclet-Modified-At")
        }
    }

    // MARK: - Responses / errors

    /// Runs the transfer and translates network errors.
    func perform<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw SyncAPIError.transport(error.code, message: error.localizedDescription)
        }
    }

    static func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw SyncAPIError.invalidResponse("Not an HTTP response")
        }
        return http
    }

    static func error(_ http: HTTPURLResponse, data: Data) -> SyncAPIError {
        let body = try? JSONDecoder().decode(SyncErrorBody.self, from: data)
        let retryAfter = SyncAPIError.retryAfter(header: http.value(forHTTPHeaderField: "Retry-After"))
        return SyncAPIError.from(status: http.statusCode, body: body, retryAfter: retryAfter)
    }

    private static func append(contentsOf source: URL, to destination: URL) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: destination.path) else {
            try fm.moveItem(at: source, to: destination)
            return
        }
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }
        try handle.seekToEnd()
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
            try handle.write(contentsOf: chunk)
        }
    }

    /// `"v3"` for `v3`; `*` and already quoted values stay as they are.
    static func quoted(_ etag: String) -> String {
        if etag == "*" || etag.hasPrefix("\"") || etag.hasPrefix("W/\"") { return etag }
        return "\"\(etag)\""
    }

    static func unquoted(_ header: String) -> String {
        var value = header.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("W/") { value.removeFirst(2) }
        if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
            value = String(value.dropFirst().dropLast())
        }
        return value
    }
}

/// Attaches the progress of the URLSession task to a given `Progress`.
private final class ProgressTaskDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let progress: Progress?

    init(progress: Progress?) {
        self.progress = progress
    }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        guard let progress else { return }
        progress.addChild(task.progress, withPendingUnitCount: max(progress.totalUnitCount - progress.completedUnitCount, 0))
    }
}
