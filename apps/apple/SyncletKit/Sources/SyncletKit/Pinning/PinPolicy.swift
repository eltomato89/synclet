import FileProvider
import Foundation

/// The single decision point for offline pinning (spec §2.5).
///
/// Strategy B: the extension sets the policy explicitly on **every** item below a pin (not
/// only on the pinned folder), so it is correct whether or not macOS lets descendants
/// inherit `.downloadEagerlyAndKeepDownloaded`. Unpinned items get `.inherited`, i.e. the
/// system default (download on demand). The user's own Finder "Keep Downloaded" is a
/// separate system state and is never touched.
public enum PinPolicy {
    /// The "keep offline" policy. On iOS (no eager policy in the SDK) it is `.inherited`.
    public static var keepDownloaded: NSFileProviderContentPolicy {
        #if os(macOS)
        return .downloadEagerlyAndKeepDownloaded
        #else
        return .inherited
        #endif
    }

    /// Whether an item whose ancestor directly below the space root is `firstLevelAncestor`
    /// (the item itself for a first-level item) is pinned.
    public static func isPinned(firstLevelAncestor: String?, pins: PinSet) -> Bool {
        if pins.wholeSpace { return true }
        guard let firstLevelAncestor else { return false }
        return pins.folders.contains(firstLevelAncestor)
    }

    /// Policy of a server item of `space`.
    /// - Parameter firstLevelAncestor: the item's ancestor directly below the space root
    ///   (itself for a first-level item); `nil` when unknown.
    public static func contentPolicy(for item: SyncItem, firstLevelAncestor: String?, space: String,
                                     pins: PinSet) -> NSFileProviderContentPolicy {
        isPinned(firstLevelAncestor: firstLevelAncestor, pins: pins) ? keepDownloaded : .inherited
    }

    /// Policy of a space folder: kept offline only when the whole space is pinned.
    public static func contentPolicy(forSpace space: String, pins: PinSet) -> NSFileProviderContentPolicy {
        pins.wholeSpace ? keepDownloaded : .inherited
    }
}
