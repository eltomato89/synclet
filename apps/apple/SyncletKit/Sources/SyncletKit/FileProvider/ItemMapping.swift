import FileProvider
import Foundation
import UniformTypeIdentifiers

/// Pure mappings between the Sync API and the File Provider world (testable).
/// Identifiers that touch the virtual top level go through ``SpaceLayout``.
public enum ItemMapping {
    // MARK: Identifiers

    /// Server id → identifier (a space root becomes `space:<id>`).
    public static func identifier(forServerID id: String, layout: SpaceLayout) -> NSFileProviderItemIdentifier {
        layout.providerIdentifier(forServerID: id)
    }

    /// Identifier → server id (`nil` for root container, working set, trash).
    public static func serverID(for identifier: NSFileProviderItemIdentifier, layout: SpaceLayout) -> String? {
        layout.serverID(for: identifier)
    }

    /// Parent identifier of a server item.
    public static func parentIdentifier(for item: SyncItem, layout: SpaceLayout) -> NSFileProviderItemIdentifier {
        layout.parentIdentifier(for: item)
    }

    // MARK: Versions

    /// Content version = `contentEtag` (folders: `etag`).
    public static func contentVersion(for item: SyncItem) -> Data {
        Data((item.contentEtag ?? item.etag).utf8)
    }

    /// Metadata version: `etag` plus name/parent/mtime – a file's `etag` (`v<version>`)
    /// does not change on rename or move.
    public static func metadataVersion(for item: SyncItem) -> Data {
        Data("\(item.etag)|\(item.parentId ?? "")|\(item.name)|\(item.modifiedAt)".utf8)
    }

    public static func itemVersion(for item: SyncItem) -> NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: contentVersion(for: item),
                                  metadataVersion: metadataVersion(for: item))
    }

    /// `contentEtag` from a content version handed in by the system (empty ⇒ `nil`).
    public static func contentEtag(from version: NSFileProviderItemVersion?) -> String? {
        guard let data = version?.contentVersion, !data.isEmpty,
              let text = String(data: data, encoding: .utf8), !text.isEmpty else { return nil }
        return text
    }

    // MARK: Capabilities

    /// Server capabilities → File Provider capabilities. Trashing is never offered
    /// (`.allowsTrashing` is left out on purpose – the server moves deletions to the
    /// user's trash anyway).
    public static func capabilities(for item: SyncItem) -> NSFileProviderItemCapabilities {
        let caps = item.capabilities
        var result: NSFileProviderItemCapabilities = []
        if item.isFolder {
            if caps.read { result.insert(.allowsContentEnumerating) }
            if caps.addChildren { result.insert(.allowsAddingSubItems) }
        } else {
            if caps.read { result.insert(.allowsReading) }
            if caps.write { result.insert(.allowsWriting) }
        }
        if caps.rename { result.insert(.allowsRenaming) }
        if caps.move { result.insert(.allowsReparenting) }
        if caps.delete { result.insert(.allowsDeleting) }
        return result
    }

    /// Capabilities of a space folder: reading and enumerating; adding children when the
    /// space is writable. Never writing, renaming, reparenting or deleting.
    public static func capabilities(for space: SyncSpace) -> NSFileProviderItemCapabilities {
        var result: NSFileProviderItemCapabilities = [.allowsReading, .allowsContentEnumerating]
        if space.canWrite { result.insert(.allowsAddingSubItems) }
        return result
    }

    /// POSIX-like flags (mainly for Finder): read-only files and folders without
    /// `addChildren` appear read-only.
    public static func fileSystemFlags(for item: SyncItem) -> NSFileProviderFileSystemFlags {
        var flags: NSFileProviderFileSystemFlags = [.userReadable]
        if item.isFolder {
            flags.insert(.userExecutable)
            if item.capabilities.addChildren { flags.insert(.userWritable) }
        } else if item.capabilities.write {
            flags.insert(.userWritable)
        }
        return flags
    }

    // MARK: Types

    /// Content type from the extension, else the MIME type, else `.data` (folders: `.folder`).
    public static func contentType(for item: SyncItem) -> UTType {
        if item.isFolder { return .folder }
        return contentType(forFileName: item.name, mime: item.mime)
    }

    public static func contentType(forFileName name: String, mime: String?) -> UTType {
        if let ext = ConflictNaming.split(name).ext,
           let type = UTType(filenameExtension: ext.lowercased()), !type.isDynamic {
            return type
        }
        if let mime = mime?.split(separator: ";").first.map({ $0.trimmingCharacters(in: .whitespaces) }),
           !mime.isEmpty, let type = UTType(mimeType: mime), !type.isDynamic {
            return type
        }
        return .data
    }

    // MARK: Names

    private static let ignoredExact: Set<String> = [
        ".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".localized",
        "Thumbs.db", "desktop.ini", "$RECYCLE.BIN", "@eaDir", "#recycle", "lost+found",
    ]

    /// Names the server never syncs (SYNC_API.md §4.3); clients must not upload them.
    public static func isIgnoredName(_ name: String) -> Bool {
        if ignoredExact.contains(name) { return true }
        if name.hasPrefix("._") || name.hasPrefix("~$") { return true }
        if name.hasPrefix(".synclet-tmp-") || name.hasPrefix(".synclet-trash-") { return true }
        if name.lowercased().hasPrefix("~wrl"), name.lowercased().hasSuffix(".tmp") { return true }
        if name.hasPrefix(".~lock."), name.hasSuffix("#") { return true }
        return false
    }
}
