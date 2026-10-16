import Foundation
import SyncletKit
import UniformTypeIdentifiers

/// Where the Share extension uploads to: the last used target, kept in the app group's
/// `UserDefaults` under ``defaultsKey``. Compiled into the app (tests) and the extension.
struct ShareTarget: Codable, Equatable, Sendable {
    static let defaultsKey = "shareLastTarget"

    var accountKey: String
    var folderId: String
    var folderName: String

    /// „Meine Dateien“ of an account.
    static func root(of account: StoredAccount) -> ShareTarget {
        let rootId = account.spaces.first { $0.kind == .personal }?.rootId ?? SyncItem.rootID
        return ShareTarget(accountKey: account.key, folderId: rootId, folderName: String(localized: "My Files"))
    }

    /// The stored target while its account still exists; otherwise the first account's „Meine
    /// Dateien“; `nil` without accounts.
    static func resolve(stored: ShareTarget?, accounts: [StoredAccount]) -> ShareTarget? {
        if let stored, accounts.contains(where: { $0.key == stored.accountKey }) { return stored }
        return accounts.first.map(root(of:))
    }

    static func load(from defaults: UserDefaults) -> ShareTarget? {
        defaults.data(forKey: defaultsKey).flatMap { try? JSONDecoder().decode(ShareTarget.self, from: $0) }
    }

    func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.defaultsKey) }
    }
}

/// Which representation of a shared attachment is uploaded, and under which name.
enum ShareNaming {
    /// The first registered type that has file data (web links and other non-file items are
    /// skipped).
    static func uploadType(_ types: [UTType]) -> UTType? {
        types.first { ($0.conforms(to: .data) || $0.conforms(to: .package)) && !$0.conforms(to: .url) }
    }

    /// The provider's suggested name (with the file's extension when it has none), else the
    /// file's own name; never containing a path separator.
    static func fileName(suggested: String?, file: URL, type: UTType) -> String {
        var name = file.lastPathComponent
        if let suggested = suggested?.trimmingCharacters(in: .whitespacesAndNewlines), !suggested.isEmpty {
            name = suggested
            if (suggested as NSString).pathExtension.isEmpty,
               let ext = file.pathExtension.isEmpty ? type.preferredFilenameExtension : file.pathExtension {
                name += ".\(ext)"
            }
        }
        name = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return name.isEmpty ? "file" : name
    }
}
