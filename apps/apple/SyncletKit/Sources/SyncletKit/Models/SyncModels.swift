import Foundation

// Wire types of the Sync API v1 – field names exactly as in docs/sync/SYNC_API.md.
// Timestamps stay ISO 8601 strings (independent of the decoder's date strategy);
// the `…Date` properties return parsed values. Unknown response fields are ignored.

// MARK: - Items (§4)

/// Item type: folder or file.
public enum SyncItemType: String, Codable, Sendable, Hashable {
    case folder
    case file
}

/// Kind of an item. Synclet sends `root`, `folder` and `file`; anything else
/// (a newer server) decodes as `.unknown` instead of failing.
public enum SyncItemKind: Codable, Sendable, Hashable {
    case root
    case folder
    case file
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "root": self = .root
        case "folder": self = .folder
        case "file": self = .file
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .root: return "root"
        case .folder: return "folder"
        case .file: return "file"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Allowed actions on an item (computed by the server, §4.5).
public struct SyncCapabilities: Codable, Sendable, Hashable {
    public var read: Bool
    public var write: Bool
    public var rename: Bool
    public var move: Bool
    public var delete: Bool
    public var addChildren: Bool

    public init(read: Bool = true, write: Bool = false, rename: Bool = false,
                move: Bool = false, delete: Bool = false, addChildren: Bool = false) {
        self.read = read
        self.write = write
        self.rename = rename
        self.move = move
        self.delete = delete
        self.addChildren = addChildren
    }
}

/// Preview state of a file (§9). `kind` stays a string so new kinds never break decoding.
public struct SyncPreview: Codable, Sendable, Hashable {
    public var kind: String
    public var thumbnail: Bool
    public var language: String?

    public init(kind: String, thumbnail: Bool, language: String? = nil) {
        self.kind = kind
        self.thumbnail = thumbnail
        self.language = language
    }
}

/// An item of the user's tree (`root`, `d_<uuid>`, `f_<uuid>`).
public struct SyncItem: Codable, Sendable, Hashable, Identifiable {
    /// Id of the user's folder.
    public static let rootID = "root"

    public var id: String
    /// `nil` only for `root`; top-level items have `"root"`.
    public var parentId: String?
    public var type: SyncItemType
    public var kind: SyncItemKind
    public var name: String
    /// Bytes (folders 0).
    public var size: Int64
    public var mime: String?
    /// Content version (files), else `nil`.
    public var version: Int?
    /// SHA-256 (hex); `nil` for folders and not yet hashed files.
    public var sha256: String?
    /// For `If-Match` on PATCH (opaque).
    public var etag: String
    /// `v<version>` for files; for `If-Match` on PUT.
    public var contentEtag: String?
    public var createdAt: String
    public var modifiedAt: String
    /// Files: equal to `id`; folders `nil`.
    public var documentId: String?
    public var capabilities: SyncCapabilities
    /// Files only; absent = unknown.
    public var preview: SyncPreview?

    public init(id: String, parentId: String?, type: SyncItemType, kind: SyncItemKind,
                name: String, size: Int64 = 0, mime: String? = nil, version: Int? = nil,
                sha256: String? = nil, etag: String, contentEtag: String? = nil,
                createdAt: String, modifiedAt: String, documentId: String? = nil,
                capabilities: SyncCapabilities = SyncCapabilities(), preview: SyncPreview? = nil) {
        self.id = id
        self.parentId = parentId
        self.type = type
        self.kind = kind
        self.name = name
        self.size = size
        self.mime = mime
        self.version = version
        self.sha256 = sha256
        self.etag = etag
        self.contentEtag = contentEtag
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.documentId = documentId
        self.capabilities = capabilities
        self.preview = preview
    }

    public var isFolder: Bool { type == .folder }
    public var createdDate: Date? { SyncDate.parse(createdAt) }
    public var modifiedDate: Date? { SyncDate.parse(modifiedAt) }
}

/// One page of `GET /items/:id/children`.
public struct SyncChildrenPage: Codable, Sendable, Hashable {
    public var items: [SyncItem]
    public var nextPageToken: String?
    /// Change cursor **before** the first page was read (sync anchor).
    public var cursor: String

    public init(items: [SyncItem], nextPageToken: String?, cursor: String) {
        self.items = items
        self.nextPageToken = nextPageToken
        self.cursor = cursor
    }
}

// MARK: - Changes (§5)

/// One change from `GET /changes`.
public enum SyncChange: Codable, Sendable, Hashable {
    case upsert(SyncItem)
    case delete(id: String)

    private enum CodingKeys: String, CodingKey { case op, item, id }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let op = try container.decode(String.self, forKey: .op)
        switch op {
        case "upsert":
            self = .upsert(try container.decode(SyncItem.self, forKey: .item))
        case "delete":
            self = .delete(id: try container.decode(String.self, forKey: .id))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .op, in: container, debugDescription: "Unknown change op \"\(op)\"")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .upsert(let item):
            try container.encode("upsert", forKey: .op)
            try container.encode(item, forKey: .item)
        case .delete(let id):
            try container.encode("delete", forKey: .op)
            try container.encode(id, forKey: .id)
        }
    }

    /// Id of the affected item.
    public var itemID: String {
        switch self {
        case .upsert(let item): return item.id
        case .delete(let id): return id
        }
    }
}

/// Response of `GET /changes`. Entries with an unknown `op` (a newer server) are
/// skipped, so the page – and its cursor – still applies.
public struct SyncChangesPage: Codable, Sendable, Hashable {
    public var changes: [SyncChange]
    public var cursor: String
    public var hasMore: Bool

    public init(changes: [SyncChange], cursor: String, hasMore: Bool) {
        self.changes = changes
        self.cursor = cursor
        self.hasMore = hasMore
    }

    private enum CodingKeys: String, CodingKey { case changes, cursor, hasMore }
    private enum OpKey: String, CodingKey { case op }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try c.decode(String.self, forKey: .cursor)
        hasMore = try c.decode(Bool.self, forKey: .hasMore)
        var list = try c.nestedUnkeyedContainer(forKey: .changes)
        var changes: [SyncChange] = []
        while !list.isAtEnd {
            // Peek at `op` through a copy of the decoder position.
            let entry = try list.superDecoder()
            let op = try entry.container(keyedBy: OpKey.self).decode(String.self, forKey: .op)
            guard op == "upsert" || op == "delete" else { continue }
            changes.append(try SyncChange(from: entry))
        }
        self.changes = changes
    }
}

/// Short name used by the plan.
public typealias ChangesPage = SyncChangesPage

/// Response of `GET /cursor`.
public struct SyncCursor: Codable, Sendable, Hashable {
    public var cursor: String
    public init(cursor: String) { self.cursor = cursor }
}

// MARK: - Spaces and account (§3)

/// Kind of a space. Unknown kinds (a newer server) are kept and shown as an ordinary folder.
public enum SyncSpaceKind: Codable, Sendable, Hashable {
    case personal
    case shared
    case external
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "personal": self = .personal
        case "shared": self = .shared
        case "external": self = .external
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .personal: return "personal"
        case .shared: return "shared"
        case .external: return "external"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// A top-level space of the account ("Meine Dateien"; later shared/external folders).
public struct SyncSpace: Codable, Sendable, Hashable, Identifiable {
    /// Stable id (Phase 2: exactly `personal`).
    public var id: String
    public var kind: SyncSpaceKind
    /// Server suggestion; clients localize known kinds.
    public var name: String
    /// Item id of the space's root folder (`personal` → `root`).
    public var rootId: String
    public var canWrite: Bool

    public init(id: String, kind: SyncSpaceKind, name: String, rootId: String, canWrite: Bool) {
        self.id = id
        self.kind = kind
        self.name = name
        self.rootId = rootId
        self.canWrite = canWrite
    }

    private enum CodingKeys: String, CodingKey { case id, kind, name, rootId, canWrite }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(SyncSpaceKind.self, forKey: .kind)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        rootId = try c.decode(String.self, forKey: .rootId)
        canWrite = try c.decodeIfPresent(Bool.self, forKey: .canWrite) ?? false
    }

    /// The space a server without `spaces` (Phase 1c) implies: the user's folder.
    public static func personal(canWrite: Bool = true) -> SyncSpace {
        SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien", rootId: SyncItem.rootID, canWrite: canWrite)
    }
}

/// Response of `GET /account`.
public struct SyncAccount: Codable, Sendable, Hashable {
    public var userId: String
    public var email: String?
    public var displayName: String
    /// `"<serverId>:<userId>"` – the account key.
    public var organizationId: String
    public var organizationName: String
    /// The username (= folder name on the server).
    public var slug: String
    public var canWrite: Bool
    /// 0 = no quota.
    public var quotaBytes: Int64
    public var usedBytes: Int64
    public var maxUploadBytes: Int64
    /// Current change cursor.
    public var cursor: String
    /// Display order = array order. Synthesized as `[personal → root]` when the server omits it.
    public var spaces: [SyncSpace]

    public init(userId: String, email: String?, displayName: String, organizationId: String,
                organizationName: String = "Synclet", slug: String, canWrite: Bool = true,
                quotaBytes: Int64 = 0, usedBytes: Int64 = 0, maxUploadBytes: Int64 = 0,
                cursor: String, spaces: [SyncSpace]? = nil) {
        self.userId = userId
        self.email = email
        self.displayName = displayName
        self.organizationId = organizationId
        self.organizationName = organizationName
        self.slug = slug
        self.canWrite = canWrite
        self.quotaBytes = quotaBytes
        self.usedBytes = usedBytes
        self.maxUploadBytes = maxUploadBytes
        self.cursor = cursor
        self.spaces = spaces ?? [.personal(canWrite: canWrite)]
    }

    /// Alias: the account key is the server's `organizationId`.
    public var accountKey: String { organizationId }
    /// Alias: `slug` is the username.
    public var username: String { slug }

    private enum CodingKeys: String, CodingKey {
        case userId, email, displayName, organizationId, organizationName, slug, canWrite
        case quotaBytes, usedBytes, maxUploadBytes, cursor, spaces
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        displayName = try c.decode(String.self, forKey: .displayName)
        organizationId = try c.decode(String.self, forKey: .organizationId)
        organizationName = try c.decodeIfPresent(String.self, forKey: .organizationName) ?? "Synclet"
        slug = try c.decode(String.self, forKey: .slug)
        canWrite = try c.decodeIfPresent(Bool.self, forKey: .canWrite) ?? true
        quotaBytes = try c.decodeIfPresent(Int64.self, forKey: .quotaBytes) ?? 0
        usedBytes = try c.decodeIfPresent(Int64.self, forKey: .usedBytes) ?? 0
        maxUploadBytes = try c.decodeIfPresent(Int64.self, forKey: .maxUploadBytes) ?? 0
        cursor = try c.decode(String.self, forKey: .cursor)
        spaces = try c.decodeIfPresent([SyncSpace].self, forKey: .spaces) ?? [.personal(canWrite: canWrite)]
    }
}

/// Response of `GET /capabilities` (Phase 1c). A `404` means an older server: all `false`.
public struct SyncServerCapabilities: Codable, Sendable, Hashable {
    public struct Office: Codable, Sendable, Hashable {
        public var enabled: Bool
        public var url: String?
        public init(enabled: Bool = false, url: String? = nil) {
            self.enabled = enabled
            self.url = url
        }
    }

    public var versions: Bool
    public var office: Office

    public init(versions: Bool = false, office: Office = Office()) {
        self.versions = versions
        self.office = office
    }

    private enum CodingKeys: String, CodingKey { case versions, office }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        versions = try c.decodeIfPresent(Bool.self, forKey: .versions) ?? false
        office = try c.decodeIfPresent(Office.self, forKey: .office) ?? Office()
    }
}

// MARK: - Devices (§2.2)

/// Platform of a sync device.
public enum SyncPlatform: String, Codable, Sendable, Hashable {
    case ios
    case android
    case macos
    case windows
    case linux
    case web

    /// The platform this code runs on.
    public static var current: SyncPlatform {
        #if os(macOS)
        return .macos
        #else
        return .ios
        #endif
    }
}

/// A registered sync device.
public struct SyncDevice: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// A string, so future platforms never break decoding.
    public var platform: String
    public var appVersion: String?
    public var createdAt: String
    public var lastSeenAt: String?
    /// `true` for the device whose token makes the request (`GET /devices`).
    public var current: Bool?

    public init(id: String, name: String, platform: String, appVersion: String?,
                createdAt: String, lastSeenAt: String?, current: Bool? = nil) {
        self.id = id
        self.name = name
        self.platform = platform
        self.appVersion = appVersion
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.current = current
    }
}

/// Response of `POST /devices` (the token is delivered only once).
public struct SyncDeviceRegistration: Codable, Sendable, Hashable {
    public var device: SyncDevice
    /// `syd_…` – Bearer for every further Sync API call.
    public var token: String
    public var account: SyncAccount

    public init(device: SyncDevice, token: String, account: SyncAccount) {
        self.device = device
        self.token = token
        self.account = account
    }
}

/// Short name used by the plan.
public typealias DeviceRegistration = SyncDeviceRegistration

/// Behaviour on a taken name (`POST /items`, `POST /items/upload`).
public enum SyncNameConflictPolicy: String, Codable, Sendable, Hashable {
    /// `409 name_conflict`.
    case fail
    /// Free name `"<base> (2).<ext>"`.
    case rename
}

// MARK: - Auth (§2.1)

/// `PublicUser` of the auth routes.
public struct PublicUser: Codable, Sendable, Hashable {
    public var id: String
    public var username: String
    public var displayName: String
    public var email: String?
    public var role: String

    public init(id: String, username: String, displayName: String, email: String? = nil, role: String = "user") {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.email = email
        self.role = role
    }
}

/// Response of `POST /api/auth/app/token`.
public struct AppTokens: Codable, Sendable, Hashable {
    /// JWT, 15 minutes – only used to register the device.
    public var accessToken: String
    /// `syr_…`, rotating; ended right after the device registration.
    public var refreshToken: String
    public var user: PublicUser

    public init(accessToken: String, refreshToken: String, user: PublicUser) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.user = user
    }
}

// MARK: - Errors (§1)

/// Error body of the API (`{ statusCode, message, code, item? }`).
public struct SyncErrorBody: Decodable, Sendable, Hashable {
    public var statusCode: Int?
    public var message: String?
    public var code: String?
    public var item: SyncItem?

    private enum CodingKeys: String, CodingKey { case statusCode, message, code, item }

    public init(statusCode: Int?, message: String?, code: String?, item: SyncItem?) {
        self.statusCode = statusCode
        self.message = message
        self.code = code
        self.item = item
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        statusCode = try? c.decodeIfPresent(Int.self, forKey: .statusCode)
        // Validation errors of the framework carry an array of messages.
        if let text = try? c.decodeIfPresent(String.self, forKey: .message) {
            message = text
        } else if let list = try? c.decodeIfPresent([String].self, forKey: .message) {
            message = list.joined(separator: "; ")
        } else {
            message = nil
        }
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        item = try? c.decodeIfPresent(SyncItem.self, forKey: .item)
    }
}

// MARK: - Dates

/// ISO 8601 parser/formatter for API timestamps (with or without milliseconds).
public enum SyncDate {
    public static func parse(_ value: String) -> Date? {
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(value, strategy: Date.ISO8601FormatStyle())
    }

    /// UTC with milliseconds (like JavaScript's `toISOString()`).
    public static func format(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
