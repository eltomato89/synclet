import Foundation

/// How an entry of the ``UploadQueue`` is transferred.
public enum UploadPlan: Equatable, Sendable { case single, tus }

/// One request of an upload. Stored (JSON) in the task's `taskDescription`, so a completion
/// can be routed after a relaunch.
public enum UploadStep: Codable, Sendable, Hashable {
    /// `POST /items/upload` with the whole copy.
    case single
    /// tus `POST /uploads`.
    case tusCreate
    /// tus `HEAD <upload>` (resume).
    case tusHead
    /// tus `PATCH <upload>` with bytes `[offset, offset + length)` from a chunk file.
    case tusPatch(offset: Int64, length: Int64)
}

/// What to do after a finished request (see ``UploadRequestBuilder/interpret(status:headers:body:for:requestURL:)``).
public enum UploadStepResult: Equatable, Sendable {
    /// Published: single `201`, or the completing tus `PATCH` (§7.4: `200` + `SyncItem`; with
    /// only `X-Synclet-Item` the name is unknown and `""`).
    case finished(itemId: String, name: String)
    /// tus upload created (absolute, same-origin URL).
    case tusCreated(URL)
    /// `HEAD`, or a non-final `PATCH`: the server's `Upload-Offset`.
    case tusOffset(Int64)
    /// `HEAD`/`PATCH` `404`/`410`: the tus upload is gone; create a new one.
    case restartTus
    /// Transient (5xx, `423`, `429`, `409` offset mismatch, transport errors): back off and retry.
    case retry
    /// Permanent until the user retries.
    case fail(UploadFailure, message: String?)
}

/// Pure request construction and response interpretation of the ``BackgroundUploader``
/// (SYNC_API.md §6.4 and §7). New files only, always `onConflict=rename`.
public enum UploadRequestBuilder {
    /// Up to this size a single `POST /items/upload`; above, tus.
    public static let threshold: Int64 = 32 * 1024 * 1024
    /// Bytes per tus `PATCH`.
    public static let chunkSize: Int64 = 16 * 1024 * 1024

    public static func plan(size: Int64) -> UploadPlan {
        size > threshold ? .tus : .single
    }

    /// `POST <origin>/api/sync/v1/items/upload?parentId&name&onConflict=rename`; the body is the copy.
    public static func singleUpload(api: SyncAPIClient, entry: UploadEntry, token: String) throws -> URLRequest {
        let url = try api.makeURL(["sync", "v1", "items", "upload"], query: [
            ("parentId", entry.parentId),
            ("name", entry.name),
            ("onConflict", SyncNameConflictPolicy.rename.rawValue),
        ])
        var request = base("POST", url, token: token)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// tus `POST <origin>/api/sync/v1/uploads` with `Upload-Length` and `Upload-Metadata`
    /// (`name`, `parentId`, `onConflict=rename`; encoding of ``TusUploadMetadata``).
    public static func tusCreate(api: SyncAPIClient, entry: UploadEntry, token: String) throws -> URLRequest {
        var request = tusBase("POST", api.syncBaseURL.appending(path: "uploads"), token: token)
        request.setValue(String(entry.size), forHTTPHeaderField: "Upload-Length")
        request.setValue(TusUploadMetadata(name: entry.name, parentId: entry.parentId, onConflict: .rename).headerValue,
                         forHTTPHeaderField: "Upload-Metadata")
        return request
    }

    /// tus `HEAD <upload>`. The caller checks ``isSameOrigin(_:_:)`` first.
    public static func tusHead(url: URL, token: String) -> URLRequest {
        tusBase("HEAD", url, token: token)
    }

    /// tus `PATCH <upload>`; the body comes from a chunk file. The caller checks ``isSameOrigin(_:_:)`` first.
    public static func tusPatch(url: URL, offset: Int64, token: String) -> URLRequest {
        var request = tusBase("PATCH", url, token: token)
        request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// Same scheme, host and port (default ports made explicit), as ``TusUploader/isSameOrigin(_:)``.
    public static func isSameOrigin(_ url: URL, _ other: URL) -> Bool {
        guard let origin = TusUploader.origin(url) else { return false }
        return origin == TusUploader.origin(other)
    }

    /// Maps a finished request to the next step. `requestURL` resolves a path-only tus
    /// `Location` and is the origin it must stay on (the token never goes elsewhere).
    ///
    /// Note: `requestURL` is an addition to the planned signature (Phase 3 T5) – without it a
    /// path-only `Location` (§7) can neither be resolved nor origin-checked. The uploader
    /// passes `task.originalRequest?.url`.
    public static func interpret(status: Int, headers: [String: String], body: Data, for step: UploadStep,
                                 requestURL: URL? = nil) -> UploadStepResult {
        let header = { (name: String) -> String? in
            headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
        let offset = { header("Upload-Offset").flatMap { Int64($0.trimmingCharacters(in: .whitespaces)) } }

        switch (step, status) {
        case (.single, 200...201):
            guard let item = try? JSONDecoder().decode(SyncItem.self, from: body) else {
                return .fail(.other, message: "unexpected response")
            }
            return .finished(itemId: item.id, name: item.name)

        case (.tusCreate, 201):
            guard let location = header("Location"),
                  let url = URL(string: location, relativeTo: requestURL)?.absoluteURL,
                  url.scheme != nil, url.host() != nil else {
                return .fail(.other, message: "tus: Location missing")
            }
            guard let requestURL, isSameOrigin(url, requestURL) else {
                return .fail(.other, message: "tus: Location on another origin")
            }
            return .tusCreated(url)

        case (.tusHead, 200), (.tusHead, 204):
            return offset().map(UploadStepResult.tusOffset) ?? .retry

        case (.tusPatch, 204):
            return offset().map(UploadStepResult.tusOffset) ?? .retry

        case (.tusPatch, 200...201):
            if let item = try? JSONDecoder().decode(SyncItem.self, from: body) {
                return .finished(itemId: item.id, name: item.name)
            }
            if let id = header("X-Synclet-Item"), !id.isEmpty { return .finished(itemId: id, name: "") }
            return .fail(.other, message: "tus: completed upload without item")

        case (.tusHead, 404), (.tusHead, 410), (.tusPatch, 404), (.tusPatch, 410):
            return .restartTus

        case (.tusPatch, 409):
            // Offset mismatch (plain-text tus error); re-HEAD on the next attempt. With
            // `onConflict=rename` a `name_conflict` cannot occur.
            return .retry

        default:
            break
        }

        let error = try? JSONDecoder().decode(SyncErrorBody.self, from: body)
        let message = error?.message
        switch status {
        case 401: return .fail(.signedOut, message: message)
        // Read-only space (also after the role changed mid-upload); the copy stays for a retry.
        case 403: return .fail(.readOnly, message: message)
        case 404: return .fail(.targetGone, message: message)
        // Missing storage: terminal instead of backing off; „Erneut versuchen“ works later.
        case 503 where error?.code == "space_unavailable": return .fail(.spaceUnavailable, message: message)
        case 413: return .fail(.tooLarge, message: message)
        case 507: return .fail(.insufficientStorage, message: message)
        case 400 where error?.code == "invalid_name": return .fail(.invalidName, message: message)
        case 423, 429, 500...599: return .retry
        default: return .fail(.other, message: message ?? "HTTP \(status)")
        }
    }

    // MARK: - Internals

    private static func base(_ method: String, _ url: URL, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private static func tusBase(_ method: String, _ url: URL, token: String) -> URLRequest {
        var request = base(method, url, token: token)
        request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
        return request
    }
}
