import FileProvider
import Foundation
import UniformTypeIdentifiers

/// Immutable `NSFileProviderItem` for a server item, a space folder or the root container.
///
/// - A server item whose id is a space's `rootId` is presented as that space folder.
/// - `itemVersion`: content = `contentEtag` (else `etag`), metadata = `etag` + name + parent.
/// - Trash is not supported.
public final class FileProviderItem: NSObject, NSFileProviderItem, @unchecked Sendable {
    /// Where the item comes from.
    public enum Source: Sendable, Hashable {
        case server(SyncItem)
        case space(SyncSpace)
        case root
    }

    public let source: Source
    public let itemIdentifier: NSFileProviderItemIdentifier
    public let parentItemIdentifier: NSFileProviderItemIdentifier
    public let filename: String
    public let contentType: UTType
    public let capabilities: NSFileProviderItemCapabilities
    public let fileSystemFlags: NSFileProviderFileSystemFlags
    public let itemVersion: NSFileProviderItemVersion
    public let documentSize: NSNumber?
    public let creationDate: Date?
    public let contentModificationDate: Date?

    private init(source: Source, identifier: NSFileProviderItemIdentifier, parent: NSFileProviderItemIdentifier,
                 filename: String, contentType: UTType, capabilities: NSFileProviderItemCapabilities,
                 flags: NSFileProviderFileSystemFlags, version: NSFileProviderItemVersion,
                 documentSize: NSNumber? = nil, creationDate: Date? = nil, modificationDate: Date? = nil) {
        self.source = source
        self.itemIdentifier = identifier
        self.parentItemIdentifier = parent
        self.filename = filename
        self.contentType = contentType
        self.capabilities = capabilities
        self.fileSystemFlags = flags
        self.itemVersion = version
        self.documentSize = documentSize
        self.creationDate = creationDate
        self.contentModificationDate = modificationDate
    }

    /// A server item, placed by `layout` (a space root becomes its space folder).
    public convenience init(_ syncItem: SyncItem, layout: SpaceLayout) {
        if let space = layout.space(forRootId: syncItem.id) {
            self.init(space: space, displayName: SpaceLayout.displayName(for: space))
            return
        }
        self.init(source: .server(syncItem),
                  identifier: layout.providerIdentifier(forServerID: syncItem.id),
                  parent: layout.parentIdentifier(for: syncItem),
                  filename: syncItem.name,
                  contentType: ItemMapping.contentType(for: syncItem),
                  capabilities: ItemMapping.capabilities(for: syncItem),
                  flags: ItemMapping.fileSystemFlags(for: syncItem),
                  version: ItemMapping.itemVersion(for: syncItem),
                  documentSize: syncItem.isFolder ? nil : NSNumber(value: syncItem.size),
                  creationDate: syncItem.createdDate,
                  modificationDate: syncItem.modifiedDate)
    }

    /// A space folder in the root container.
    public convenience init(space: SyncSpace, displayName: String) {
        let metadata = "\(space.kind.rawValue)|\(space.rootId)|\(displayName)|\(space.canWrite)"
        var flags: NSFileProviderFileSystemFlags = [.userReadable, .userExecutable]
        if space.canWrite { flags.insert(.userWritable) }
        self.init(source: .space(space),
                  identifier: SpaceLayout.identifier(for: space),
                  parent: .rootContainer,
                  filename: displayName,
                  contentType: .folder,
                  capabilities: ItemMapping.capabilities(for: space),
                  flags: flags,
                  version: NSFileProviderItemVersion(contentVersion: Data("space".utf8),
                                                     metadataVersion: Data(metadata.utf8)))
    }

    /// The root container (the list of spaces): read-only.
    public static func rootContainer() -> FileProviderItem {
        FileProviderItem(source: .root, identifier: .rootContainer, parent: .rootContainer,
                         filename: "Synclet", contentType: .folder,
                         capabilities: [.allowsReading, .allowsContentEnumerating],
                         flags: [.userReadable, .userExecutable],
                         version: NSFileProviderItemVersion(contentVersion: Data("root".utf8),
                                                            metadataVersion: Data("root".utf8)))
    }

    /// The server item, if this is one.
    public var syncItem: SyncItem? {
        if case .server(let item) = source { return item }
        return nil
    }

    /// The space, if this is a space folder.
    public var space: SyncSpace? {
        if case .space(let space) = source { return space }
        return nil
    }

    public override var description: String {
        "FileProviderItem(\(itemIdentifier.rawValue), \(filename))"
    }
}
