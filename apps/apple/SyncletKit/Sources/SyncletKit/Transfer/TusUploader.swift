import Foundation

/// Metadata of a tus upload (`Upload-Metadata`, SYNC_API.md §7): either a **new file**
/// (`name`, `parentId`, `onConflict`) or the **replacement** of an existing file's content
/// (`itemId` + `ifMatch`; the create keys must then be absent).
public struct TusUploadMetadata: Sendable, Hashable, Codable {
    public enum Target: Sendable, Hashable, Codable {
        /// New file `name` in `parentId`; `rename` (tus default) or `fail` (⇒ `409 name_conflict`
        /// at completion; the upload is dropped).
        case create(name: String, parentId: String, onConflict: SyncNameConflictPolicy)
        /// New content for file `itemId`, based on content etag `ifMatch` (`v<n>`; `*` is not
        /// supported by tus). A stale etag ⇒ `412` at creation or at completion.
        case replace(itemId: String, ifMatch: String)
    }

    public var target: Target
    /// Content mtime, in whole milliseconds (the precision the server keeps, so a stored
    /// target compares equal after its JSON round trip).
    public var modifiedAt: Date? {
        didSet { if let modifiedAt, modifiedAt != Self.milliseconds(modifiedAt) { self.modifiedAt = Self.milliseconds(modifiedAt) } }
    }

    public init(target: Target, modifiedAt: Date? = nil) {
        self.target = target
        self.modifiedAt = modifiedAt.map(Self.milliseconds)
    }

    /// A new file.
    public init(name: String, parentId: String, onConflict: SyncNameConflictPolicy = .rename, modifiedAt: Date? = nil) {
        self.init(target: .create(name: name, parentId: parentId, onConflict: onConflict), modifiedAt: modifiedAt)
    }

    /// Replacement of an existing file's content.
    public static func replace(itemId: String, ifMatch: String, modifiedAt: Date? = nil) -> TusUploadMetadata {
        TusUploadMetadata(target: .replace(itemId: itemId, ifMatch: ifMatch), modifiedAt: modifiedAt)
    }

    /// Name of a new file (`nil` for a replace).
    public var name: String? {
        if case .create(let name, _, _) = target { return name }
        return nil
    }

    /// Base etag of a replace (`nil` for a new file).
    public var ifMatch: String? {
        if case .replace(_, let ifMatch) = target { return ifMatch }
        return nil
    }

    /// Parent of a new file (`nil` for a replace).
    public var parentId: String? {
        if case .create(_, let parentId, _) = target { return parentId }
        return nil
    }

    static func milliseconds(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000)
    }

    /// tus encoding: `key base64(value)` pairs separated by commas.
    public var headerValue: String {
        var pairs: [(String, String)]
        switch target {
        case .create(let name, let parentId, let onConflict):
            pairs = [("name", name), ("parentId", parentId), ("onConflict", onConflict.rawValue)]
        case .replace(let itemId, let ifMatch):
            pairs = [("itemId", itemId), ("ifMatch", ifMatch)]
        }
        if let modifiedAt { pairs.append(("modifiedAt", SyncDate.format(modifiedAt))) }
        return pairs.map { "\($0.0) \(Data($0.1.utf8).base64EncodedString())" }.joined(separator: ",")
    }
}

/// Answer of a `PATCH`: the new offset, or the published item (the request completed the upload).
public enum TusPatchResult: Sendable, Equatable {
    case offset(Int64)
    /// `fromResponse`: the item is the completion's own JSON body (§7.4), so its etag is
    /// the version this upload published. `false`: the body was missing and the item was
    /// fetched with `GET /items/:id` – it may already reflect a later edit.
    case completed(SyncItem, fromResponse: Bool)
}

/// Client of the tus 1.0 endpoint `<origin>/api/sync/v1/uploads` (SYNC_API.md §7).
///
/// Low-level and stateless; ``TransferEngine`` drives it (chunking, resume, retries).
/// Errors are ``SyncAPIError``s: tus protocol errors have plain-text bodies and map by
/// status (`404` → `.notFound`, `410`/`423`/`409` offset mismatch → `.http`), publish
/// errors at completion use the Sync error format (`409 name_conflict`, `507`, …).
public final class TusUploader: Sendable {
    public static let defaultChunkSize = 16 << 20

    public let api: SyncAPIClient
    /// Bytes per `PATCH`.
    public let chunkSize: Int
    /// `<origin>/api/sync/v1/uploads`.
    public var endpoint: URL { api.syncBaseURL.appending(path: "uploads") }

    public init(api: SyncAPIClient, chunkSize: Int = TusUploader.defaultChunkSize) {
        precondition(chunkSize > 0)
        self.api = api
        self.chunkSize = chunkSize
    }

    /// `POST /uploads` → the absolute upload URL (from the path-only `Location`).
    /// An empty upload (`length == 0`) completes with the `POST` itself.
    public func create(length: Int64, metadata: TusUploadMetadata) async throws -> TusCreateResult {
        var request = try await request("POST", endpoint)
        request.setValue(String(length), forHTTPHeaderField: "Upload-Length")
        request.setValue(metadata.headerValue, forHTTPHeaderField: "Upload-Metadata")
        let (data, http) = try await send(request, body: nil)
        guard http.statusCode == 201 else { throw SyncAPIClient.error(http, data: data) }
        guard let location = http.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: api.baseURL)?.absoluteURL else {
            throw SyncAPIError.invalidResponse("tus: Location missing")
        }
        if length == 0 {
            return .completed(try await publishedItem(http, data: data).item)
        }
        return .created(url)
    }

    /// `HEAD <upload>` → current offset and length. `404`/`410` = the upload is gone.
    public func head(_ uploadURL: URL) async throws -> (offset: Int64, length: Int64?) {
        let request = try await request("HEAD", uploadURL)
        let (data, http) = try await send(request, body: nil)
        guard http.statusCode == 200 || http.statusCode == 204,
              let offset = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init) else {
            throw SyncAPIClient.error(http, data: data)
        }
        return (offset, http.value(forHTTPHeaderField: "Upload-Length").flatMap(Int64.init))
    }

    /// `PATCH <upload>` with `chunk` at `offset`. An empty chunk at the final offset retries
    /// a publish that failed on the server's side (§7.5).
    public func patch(_ uploadURL: URL, offset: Int64, chunk: Data) async throws -> TusPatchResult {
        var request = try await request("PATCH", uploadURL)
        request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, http) = try await send(request, body: chunk)
        switch http.statusCode {
        case 200, 201:
            let published = try await publishedItem(http, data: data)
            return .completed(published.item, fromResponse: published.fromResponse)
        case 204:
            guard let newOffset = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init) else {
                throw SyncAPIError.invalidResponse("tus: Upload-Offset missing")
            }
            return .offset(newOffset)
        default:
            throw SyncAPIClient.error(http, data: data)
        }
    }

    /// `DELETE <upload>` – terminates an unfinished upload (an unknown one counts as done).
    public func terminate(_ uploadURL: URL) async throws {
        let request = try await request("DELETE", uploadURL)
        let (data, http) = try await send(request, body: nil)
        guard (200...299).contains(http.statusCode) || http.statusCode == 404 || http.statusCode == 410 else {
            throw SyncAPIClient.error(http, data: data)
        }
    }

    // MARK: - Internals

    private func request(_ method: String, _ url: URL) async throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        try await api.authorize(&request)
        return request
    }

    private func send(_ request: URLRequest, body: Data?) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await api.perform {
            if let body {
                try await self.api.session.upload(for: request, from: body)
            } else {
                try await self.api.session.data(for: request)
            }
        }
        return (data, try SyncAPIClient.httpResponse(response))
    }

    /// The completing request answers with the `SyncItem`; otherwise fall back to
    /// `X-Synclet-Item` and `GET /items/:id` (§7.4).
    private func publishedItem(_ http: HTTPURLResponse, data: Data) async throws -> (item: SyncItem, fromResponse: Bool) {
        if let item = try? JSONDecoder().decode(SyncItem.self, from: data) { return (item, true) }
        guard let id = http.value(forHTTPHeaderField: "X-Synclet-Item"), !id.isEmpty else {
            throw SyncAPIError.invalidResponse("tus: completed upload without item")
        }
        return (try await api.item(id: id), false)
    }
}

/// Answer of ``TusUploader/create(length:metadata:)``.
public enum TusCreateResult: Sendable, Equatable {
    /// Upload created; continue with `PATCH`es to this URL.
    case created(URL)
    /// Empty upload, published by the `POST` itself.
    case completed(SyncItem)
}
