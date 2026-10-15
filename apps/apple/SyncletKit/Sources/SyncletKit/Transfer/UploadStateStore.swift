import CryptoKit
import Foundation

/// Persistent state of an unfinished tus upload (one JSON file per upload).
public struct UploadState: Codable, Sendable, Hashable {
    /// Absolute upload URL (`Location` of the `POST`).
    public var uploadURL: URL
    /// `Upload-Length`.
    public var length: Int64
    /// Size and mtime of the local file when the upload started; a change ⇒ restart.
    public var fileSize: Int64
    public var fileMtime: Date
    /// Where the upload is published.
    public var target: TusUploadMetadata
    /// ETag the change is based on (replace; `nil` for new files).
    public var baseEtag: String?
    public var createdAt: Date

    public init(uploadURL: URL, length: Int64, fileSize: Int64, fileMtime: Date, target: TusUploadMetadata,
                baseEtag: String? = nil, createdAt: Date) {
        self.uploadURL = uploadURL
        self.length = length
        self.fileSize = fileSize
        self.fileMtime = fileMtime
        self.target = target
        self.baseEtag = baseEtag
        self.createdAt = createdAt
    }
}

/// Stores ``UploadState``s in a directory (the account's folder in the app group), so an
/// upload survives a killed extension. Entries older than 24 h are dropped: the server
/// expires unfinished uploads after 24 h (`410`).
public final class UploadStateStore: Sendable {
    public static let maxAge: TimeInterval = 24 * 3600

    public let directory: URL
    private let now: @Sendable () -> Date

    public init(directory: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.now = now
    }

    /// `sha256(itemIdentifier + contentVersion)` as hex.
    public static func key(itemIdentifier: String, contentVersion: String) -> String {
        SHA256.hash(data: Data((itemIdentifier + contentVersion).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func file(_ key: String) -> URL { directory.appending(path: "\(key).json") }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }

    /// The state for `key`; `nil` (and removed) when unreadable or older than 24 h.
    public func load(key: String) -> UploadState? {
        guard let data = try? Data(contentsOf: file(key)) else { return nil }
        guard let state = try? Self.decoder().decode(UploadState.self, from: data),
              now().timeIntervalSince(state.createdAt) < Self.maxAge else {
            remove(key: key)
            return nil
        }
        return state
    }

    public func save(_ state: UploadState, key: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.encoder.encode(state).write(to: file(key), options: .atomic)
    }

    public func remove(key: String) {
        try? FileManager.default.removeItem(at: file(key))
    }

    /// Drops all expired or unreadable entries.
    public func purgeExpired() {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for url in files where url.pathExtension == "json" {
            _ = load(key: url.deletingPathExtension().lastPathComponent)
        }
    }
}
