import Foundation

/// One hit of `GET /sync/v1/search` (docs/sync/SYNC_API.md §11).
public struct SyncSearchHit: Codable, Sendable, Hashable {
    public var item: SyncItem
    public var path: String
    /// Highlights matches with `«…»`.
    public var snippet: String?
    /// `name`, `content` or `both`.
    public var matched: String

    public init(item: SyncItem, path: String, snippet: String?, matched: String) {
        self.item = item; self.path = path; self.snippet = snippet; self.matched = matched
    }
}

public struct SyncSearchResult: Codable, Sendable, Hashable {
    public var hits: [SyncSearchHit]
    public var total: Int

    public init(hits: [SyncSearchHit], total: Int) { self.hits = hits; self.total = total }
}

/// Entry of `GET /api/trash` (`TrashEntryWire`).
public struct TrashEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var itemId: String
    public var type: SyncItemType
    public var name: String
    public var originalPath: String
    public var size: Int64
    public var deletedAt: String
    public var expiresAt: String?
    public var itemCount: Int

    public init(id: String, itemId: String, type: SyncItemType, name: String, originalPath: String,
                size: Int64, deletedAt: String, expiresAt: String?, itemCount: Int) {
        self.id = id; self.itemId = itemId; self.type = type; self.name = name
        self.originalPath = originalPath; self.size = size; self.deletedAt = deletedAt
        self.expiresAt = expiresAt; self.itemCount = itemCount
    }
}

/// `POST /api/trash/:id/restore`.
public struct RestoreResult: Codable, Sendable, Hashable {
    public var item: SyncItem
    public var restoredTo: String
    public var renamed: Bool

    public init(item: SyncItem, restoredTo: String, renamed: Bool) {
        self.item = item; self.restoredTo = restoredTo; self.renamed = renamed
    }
}

/// Public share link (`ShareLinkWire`).
public struct ShareLink: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var itemId: String
    public var itemName: String
    public var itemType: SyncItemType
    public var url: String
    public var hasPassword: Bool
    public var expiresAt: String?
    public var allowDownload: Bool
    public var allowUpload: Bool
    public var createdAt: String
    public var revokedAt: String?
    public var hits: Int
    public var itemTrashed: Bool

    public init(id: String, itemId: String, itemName: String, itemType: SyncItemType, url: String,
                hasPassword: Bool, expiresAt: String?, allowDownload: Bool, allowUpload: Bool,
                createdAt: String, revokedAt: String?, hits: Int, itemTrashed: Bool) {
        self.id = id; self.itemId = itemId; self.itemName = itemName; self.itemType = itemType
        self.url = url; self.hasPassword = hasPassword; self.expiresAt = expiresAt
        self.allowDownload = allowDownload; self.allowUpload = allowUpload; self.createdAt = createdAt
        self.revokedAt = revokedAt; self.hits = hits; self.itemTrashed = itemTrashed
    }

    /// `url` resolved against the server origin when the server returned a relative "/s/<token>".
    public func absoluteURL(server: URL) -> URL? {
        if let u = URL(string: url), u.scheme != nil { return u }
        var c = URLComponents(url: server, resolvingAgainstBaseURL: false); c?.path = url; c?.query = nil; c?.fragment = nil
        return c?.url
    }

    /// Not revoked and the item is not in the trash (expiry is checked by the caller with a date).
    public var isActive: Bool { revokedAt == nil && !itemTrashed }
}

/// Body options of create (`POST`) and update (`PATCH`) of a share link.
public struct ShareLinkOptions: Encodable, Sendable, Hashable {
    /// `nil` = leave unchanged (PATCH) / no password (POST); `.some(nil)` = remove password (PATCH).
    public var password: String??
    public var expiresAt: Date??
    public var allowDownload: Bool?
    public var allowUpload: Bool?

    public init(password: String?? = nil, expiresAt: Date?? = nil, allowDownload: Bool? = nil, allowUpload: Bool? = nil) {
        self.password = password; self.expiresAt = expiresAt
        self.allowDownload = allowDownload; self.allowUpload = allowUpload
    }


    public func encode(to encoder: Encoder) throws {
        try encode(to: encoder, itemId: nil)
    }

    func encode(to encoder: Encoder, itemId: String?) throws {
        var container = encoder.container(keyedBy: DynamicKey.self)
        if let itemId { try container.encode(itemId, forKey: DynamicKey("itemId")) }
        if let password { try container.encode(password, forKey: DynamicKey("password")) }   // nil -> null
        if let expiresAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            try container.encode(expiresAt.map(formatter.string(from:)), forKey: DynamicKey("expiresAt"))
        }
        if let allowDownload { try container.encode(allowDownload, forKey: DynamicKey("allowDownload")) }
        if let allowUpload { try container.encode(allowUpload, forKey: DynamicKey("allowUpload")) }
    }
}

struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// `POST /api/shares` body: `itemId` plus the options.
struct CreateShareBody: Encodable {
    var itemId: String
    var options: ShareLinkOptions
    func encode(to encoder: Encoder) throws { try options.encode(to: encoder, itemId: itemId) }
}
