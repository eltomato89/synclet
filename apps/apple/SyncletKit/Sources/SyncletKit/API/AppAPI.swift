import Foundation

/// Search, recent files, trash and share links (docs/sync/SYNC_API.md §8.4, §11).
extension SyncAPIClient {
    private struct RemovedCount: Decodable { var removed: Int }

    /// `GET /sync/v1/search`.
    public func search(_ query: String, folder: String? = nil, limit: Int = 20, offset: Int = 0) async throws -> SyncSearchResult {
        try await send(.get, ["sync", "v1", "search"],
                       query: [("q", query), ("folder", folder), ("limit", String(limit)), ("offset", String(offset))])
    }

    /// `GET /sync/v1/recent`.
    public func recent(limit: Int = 50) async throws -> [SyncItem] {
        try await send(.get, ["sync", "v1", "recent"], query: [("limit", String(limit))])
    }

    /// `GET /api/trash`.
    public func trash() async throws -> [TrashEntry] {
        try await send(.get, api(["trash"]))
    }

    /// `POST /api/trash/:id/restore`.
    public func restoreFromTrash(id: String) async throws -> RestoreResult {
        try await send(.post, api(["trash", id, "restore"]))
    }

    /// `DELETE /api/trash/:id`.
    public func deleteFromTrash(id: String) async throws {
        try await sendNoContent(.delete, api(["trash", id]))
    }

    /// `DELETE /api/trash`; returns the number of removed entries.
    public func emptyTrash() async throws -> Int {
        let result: RemovedCount = try await send(.delete, api(["trash"]))
        return result.removed
    }

    /// `GET /api/shares?itemId=`.
    public func shareLinks(itemID: String) async throws -> [ShareLink] {
        try await send(.get, api(["shares"]), query: [("itemId", itemID)])
    }

    /// `POST /api/shares`.
    public func createShareLink(itemID: String, options: ShareLinkOptions) async throws -> ShareLink {
        try await send(.post, api(["shares"]), body: CreateShareBody(itemId: itemID, options: options))
    }

    /// `PATCH /api/shares/:id`.
    public func updateShareLink(id: String, options: ShareLinkOptions) async throws -> ShareLink {
        try await send(.patch, api(["shares", id]), body: options)
    }

    /// `DELETE /api/shares/:id`.
    public func revokeShareLink(id: String) async throws {
        try await sendNoContent(.delete, api(["shares", id]))
    }
}
