import Foundation
import SyncletKit

/// A space as the app shows it: "My Files" for the personal space (localized), the server's
/// name for team folders and external storages. Compiled into the app and the Share extension.
struct SpaceEntry: Identifiable, Hashable, Sendable {
    let space: SyncSpace

    var id: String { space.id }

    var title: String {
        space.kind == .personal ? String(localized: "My Files") : space.name
    }

    /// Team folders: people; external storages: a drive.
    var systemImage: String {
        switch space.kind {
        case .personal: return "folder"
        case .shared: return "person.2"
        case .external: return "externaldrive"
        case .unknown: return "folder"
        }
    }

    var isReadOnly: Bool { !space.canWrite }
    /// `false` while the storage is missing (its content answers `503 space_unavailable`).
    var isAvailable: Bool { space.isAvailable }
    /// Uploads, new folders and moves may go here.
    var isWritable: Bool { space.canWrite && isAvailable }

    /// "Not Available" or "Read Only" below the name; `nil` for an ordinary space.
    var subtitle: String? {
        if !isAvailable { return String(localized: "Not Available") }
        if isReadOnly { return String(localized: "Read Only") }
        return nil
    }
}

/// The spaces of an account in server order (personal, team folders, external storages).
struct SpaceDirectory: Equatable, Sendable {
    let spaces: [SyncSpace]

    init(spaces: [SyncSpace]) {
        self.spaces = spaces
    }

    /// "My Files" (synthesized for a server without `spaces`).
    var personal: SpaceEntry {
        SpaceEntry(space: spaces.first { $0.kind == .personal } ?? .personal())
    }

    /// Team folders and external storages, in server order.
    var others: [SpaceEntry] {
        spaces.filter { $0.kind != .personal }.map(SpaceEntry.init(space:))
    }

    /// The personal space first, then the others.
    var all: [SpaceEntry] { [personal] + others }

    /// `true` when the account has more than "My Files" (the browser lists the spaces).
    var hasSpaces: Bool { !others.isEmpty }

    /// Targets of uploads and moves: spaces with write access whose storage is there.
    var writable: [SpaceEntry] { all.filter(\.isWritable) }

    func entry(id: String?) -> SpaceEntry? {
        guard let id else { return personal }
        return all.first { $0.id == id }
    }

    /// The space name next to a hit, a recent file or a trash entry; `nil` while the account
    /// has only "My Files" (nothing to tell apart) or for an unknown space. A missing
    /// `spaceId` (older server) is the personal space.
    func label(for spaceId: String?) -> String? {
        guard hasSpaces else { return nil }
        return entry(id: spaceId)?.title
    }

    /// "Team · /Docs/Plan.pdf" (just the path without spaces).
    func location(spaceId: String?, path: String) -> String {
        guard let label = label(for: spaceId) else { return path }
        return "\(label) · \(path)"
    }

    func location(of hit: SyncSearchHit) -> String {
        location(spaceId: hit.item.spaceId, path: hit.path)
    }
}
