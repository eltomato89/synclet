import Foundation
import os

/// What is pinned (kept offline) in one space: the whole space and/or first-level folders,
/// keyed by item id so a rename keeps the pin.
public struct PinSet: Codable, Sendable, Hashable {
    public var wholeSpace: Bool
    /// Ids of pinned folders directly below the space root.
    public var folders: Set<String>

    public init(wholeSpace: Bool = false, folders: Set<String> = []) {
        self.wholeSpace = wholeSpace
        self.folders = folders
    }

    public var isEmpty: Bool { !wholeSpace && folders.isEmpty }

    private enum CodingKeys: String, CodingKey { case v, wholeSpace, folders }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wholeSpace = try c.decodeIfPresent(Bool.self, forKey: .wholeSpace) ?? false
        folders = Set(try c.decodeIfPresent([String].self, forKey: .folders) ?? [])
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(StateFormat.version, forKey: .v)
        try c.encode(wholeSpace, forKey: .wholeSpace)
        try c.encode(folders.sorted(), forKey: .folders)
    }
}

/// Offline pins of one account, stored per space in the app group:
///
/// ```
/// <stateDir>/spaces/<spaceId>/pins.json           written by the app (settings), pruned by both
/// <stateDir>/spaces/<spaceId>/pins-applied.json   the extension's record of what it re-reported
/// ```
///
/// `stateDir` is the account directory `accounts/<key16>/`. Every effective change of
/// `pins.json` posts the Darwin notification `tech.jensk.synclet.pinsChanged.<key16>`.
/// Read-modify-write runs under an exclusive `flock` on `<spaceId>/pins.lock`, shared by the
/// app and the extension, so a toggle and a prune never lose each other's change. Writes are
/// atomic; an unreadable file counts as "nothing pinned".
public final class PinStore: Sendable {
    public static let notificationPrefix = "tech.jensk.synclet.pinsChanged."
    /// Posted by the extension when it reported new or changed items under a pin, so the app
    /// can make sure they are downloaded.
    public static let pinnedContentNotificationPrefix = "tech.jensk.synclet.pinnedContentChanged."

    public static func notificationName(key16: String) -> String { notificationPrefix + key16 }
    public static func pinnedContentNotificationName(key16: String) -> String { pinnedContentNotificationPrefix + key16 }

    /// Posts a Darwin notification (app ↔ extension).
    public static let postDarwinNotification: @Sendable (String) -> Void = { name in
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(name as CFString), nil, nil, true)
    }

    public let stateDir: URL
    private let post: @Sendable (String) -> Void

    /// - Parameters:
    ///   - stateDir: the account directory `accounts/<key16>/`.
    ///   - post: how change notifications are posted (tests record them).
    public init(stateDir: URL, post: @escaping @Sendable (String) -> Void = PinStore.postDarwinNotification) {
        self.stateDir = stateDir
        self.post = post
    }

    /// The account's `key16` (the state directory's name).
    public var key16: String { stateDir.lastPathComponent }

    // MARK: Pins

    public func pins(space: String) -> PinSet {
        read(file(space: space, name: "pins.json")) ?? PinSet()
    }

    /// Pins of several spaces (missing ⇒ empty).
    public func allPins(spaces: [String]) -> [String: PinSet] {
        Dictionary(spaces.map { ($0, pins(space: $0)) }, uniquingKeysWith: { a, _ in a })
    }

    public func setWholeSpace(_ wholeSpace: Bool, space: String) throws {
        try update(space: space) { $0.wholeSpace = wholeSpace }
    }

    public func setFolder(_ id: String, pinned: Bool, space: String) throws {
        try update(space: space) { pins in
            if pinned { pins.folders.insert(id) } else { pins.folders.remove(id) }
        }
    }

    /// Drops pins of folders that are no longer directly below the space root (deleted or
    /// moved deeper). Returns the dropped ids.
    @discardableResult
    public func prune(existingFirstLevel: Set<String>, space: String) throws -> Set<String> {
        var removed: Set<String> = []
        try update(space: space) { pins in
            removed = pins.folders.subtracting(existingFirstLevel)
            pins.folders.formIntersection(existingFirstLevel)
        }
        return removed
    }

    /// Drops the pin of a deleted folder in whichever space holds it; `true` if one was dropped.
    @discardableResult
    public func forget(folder id: String, spaces: [String]) throws -> Bool {
        var dropped = false
        for space in spaces where pins(space: space).folders.contains(id) {
            try setFolder(id, pinned: false, space: space)
            dropped = true
        }
        return dropped
    }

    /// Drops every pin of a space the account lost (and the extension's applied state).
    /// Returns `true` if something was pinned.
    @discardableResult
    public func forgetSpace(_ space: String) throws -> Bool {
        guard !pins(space: space).isEmpty || !appliedPins(space: space).isEmpty else { return false }
        var hadPins = false
        try update(space: space) { pins in
            hadPins = !pins.isEmpty
            pins = PinSet()
        }
        try setAppliedPins(PinSet(), space: space)
        return hadPins
    }

    // MARK: Applied state (extension bookkeeping, no notification)

    /// The pins whose policy the extension last re-reported to the system (never ⇒ empty).
    public func appliedPins(space: String) -> PinSet {
        read(file(space: space, name: "pins-applied.json")) ?? PinSet()
    }

    /// Written by the extension only.
    public func setAppliedPins(_ pins: PinSet, space: String) throws {
        try write(pins, to: file(space: space, name: "pins-applied.json"))
    }

    // MARK: Files

    private func file(space: String, name: String) -> URL {
        stateDir.appending(path: "spaces", directoryHint: .isDirectory)
            .appending(path: AccountStore.safeComponent(space), directoryHint: .isDirectory)
            .appending(path: name, directoryHint: .notDirectory)
    }

    private func read(_ url: URL) -> PinSet? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PinSet.self, from: data)
    }

    private func write(_ pins: PinSet, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(pins).write(to: url, options: .atomic)
    }

    /// Read-modify-write of `pins.json`; posts the notification only on an effective change.
    private func update(space: String, _ change: (inout PinSet) -> Void) throws {
        let changed = try FileLock.withLock(file(space: space, name: "pins.lock")) { () -> Bool in
            let url = file(space: space, name: "pins.json")
            let before = read(url) ?? PinSet()
            var after = before
            change(&after)
            guard after != before else { return false }
            try write(after, to: url)
            return true
        }
        if changed {
            Log.pinning.info("pins of space \(space, privacy: .public) changed")
            post(Self.notificationName(key16: key16))
        }
    }
}
