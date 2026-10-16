import FileProvider
import Foundation

/// Errors of the virtual top level.
public enum SpaceLayoutError: Error, Sendable, Equatable {
    /// Writes into the root container (the list of spaces) are not possible.
    case readOnlyTopLevel
    /// `space:<id>` of a space the account does not have (any more).
    case unknownSpace(String)
}

/// The virtual top level of a domain (spec §2.3): the root container lists one folder
/// per space (`space:<id>`); a space folder shows the children of the space's `rootId`.
/// Server ids below stay unchanged (`d_…`, `f_…`).
///
/// Pure value type – all mapping between server ids and File Provider identifiers that
/// involves the top level goes through here.
public struct SpaceLayout: Sendable, Hashable {
    /// Prefix of the identifiers of space folders.
    public static let identifierPrefix = "space:"

    /// Spaces in display order.
    public let spaces: [SyncSpace]

    public init(spaces: [SyncSpace]) {
        self.spaces = spaces
    }

    // MARK: Identifiers

    /// `space:<id>`.
    public static func identifier(for space: SyncSpace) -> NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier(identifierPrefix + space.id)
    }

    /// The space id of a `space:<id>` identifier, else `nil`.
    public static func spaceID(from identifier: NSFileProviderItemIdentifier) -> String? {
        let raw = identifier.rawValue
        guard raw.hasPrefix(identifierPrefix), raw.count > identifierPrefix.count else { return nil }
        return String(raw.dropFirst(identifierPrefix.count))
    }

    public func space(id: String) -> SyncSpace? {
        spaces.first { $0.id == id }
    }

    /// The space whose root folder is the server item `rootId`.
    public func space(forRootId rootId: String) -> SyncSpace? {
        spaces.first { $0.rootId == rootId }
    }

    /// The space of a `space:<id>` identifier.
    public func space(for identifier: NSFileProviderItemIdentifier) -> SyncSpace? {
        Self.spaceID(from: identifier).flatMap(space(id:))
    }

    /// The root container or a space folder.
    public func isTopLevel(_ identifier: NSFileProviderItemIdentifier) -> Bool {
        identifier == .rootContainer || Self.spaceID(from: identifier) != nil
    }

    /// Server id → identifier: a space's `rootId` becomes `space:<id>`, anything else
    /// passes through unchanged.
    public func providerIdentifier(forServerID id: String) -> NSFileProviderItemIdentifier {
        if let space = space(forRootId: id) { return Self.identifier(for: space) }
        return NSFileProviderItemIdentifier(id)
    }

    /// Parent identifier for a server `parentId` (same rule as ``providerIdentifier(forServerID:)``).
    public func providerParent(forServerParentId parentId: String) -> NSFileProviderItemIdentifier {
        providerIdentifier(forServerID: parentId)
    }

    /// Parent identifier of a server item. A space root itself sits in the root container.
    public func parentIdentifier(for item: SyncItem) -> NSFileProviderItemIdentifier {
        if space(forRootId: item.id) != nil { return .rootContainer }
        guard let parentId = item.parentId else { return .rootContainer }
        return providerParent(forServerParentId: parentId)
    }

    /// Identifier → server id. `nil` for the root container, the working set, the trash
    /// and unknown spaces (none of them is a server item).
    public func serverID(for identifier: NSFileProviderItemIdentifier) -> String? {
        switch identifier {
        case .rootContainer, .workingSet, .trashContainer:
            return nil
        default:
            if Self.spaceID(from: identifier) != nil { return space(for: identifier)?.rootId }
            return identifier.rawValue
        }
    }

    /// Server `parentId` for an item that is created in / moved to `providerParent`.
    /// - Throws: ``SpaceLayoutError/readOnlyTopLevel`` for the root container (and the
    ///   working set/trash), ``SpaceLayoutError/unknownSpace(_:)`` for a vanished space.
    public func serverParentId(for providerParent: NSFileProviderItemIdentifier) throws -> String {
        switch providerParent {
        case .rootContainer, .workingSet, .trashContainer:
            throw SpaceLayoutError.readOnlyTopLevel
        default:
            if let spaceID = Self.spaceID(from: providerParent) {
                guard let space = space(id: spaceID) else { throw SpaceLayoutError.unknownSpace(spaceID) }
                return space.rootId
            }
            return providerParent.rawValue
        }
    }

    // MARK: Top level items

    /// One folder per space, in order: localized name by kind, read-only (no writing,
    /// renaming, reparenting or deleting).
    public func topLevelItems(bundle: Bundle? = nil) -> [FileProviderItem] {
        spaces.map { FileProviderItem(space: $0, displayName: Self.displayName(for: $0, bundle: bundle)) }
    }

    /// The virtual item for the root container or a space folder.
    public func virtualItem(for identifier: NSFileProviderItemIdentifier, bundle: Bundle? = nil) -> FileProviderItem? {
        if identifier == .rootContainer { return FileProviderItem.rootContainer() }
        guard let space = space(for: identifier) else { return nil }
        return FileProviderItem(space: space, displayName: Self.displayName(for: space, bundle: bundle))
    }

    /// Display name of a space: personal → "My Files" / "Meine Dateien"
    /// (`String(localized:)`); other kinds show the server's `name`.
    /// - Parameter bundle: localization bundle (tests pass a specific `.lproj`).
    public static func displayName(for space: SyncSpace, bundle: Bundle? = nil) -> String {
        switch space.kind {
        case .personal:
            if let bundle {
                return bundle.localizedString(forKey: "space.personal", value: "My Files", table: nil)
            }
            return String(localized: "space.personal", defaultValue: "My Files", bundle: .module)
        case .shared, .external, .unknown:
            return space.name
        }
    }

    // MARK: Change feeds

    /// Spaces with a change feed (`GET /changes?space=<id>`): all of them (Phase 4). Each
    /// keeps its own cursor in the sync anchor.
    public var feedSpaces: [SyncSpace] { spaces }

    /// Server ids of all space roots (never reported as ordinary items).
    public var rootIds: Set<String> { Set(spaces.map(\.rootId)) }
}
