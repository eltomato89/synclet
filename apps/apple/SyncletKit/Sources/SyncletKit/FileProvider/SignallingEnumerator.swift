import FileProvider
import Foundation

/// Passes an enumeration through and reports its errors with the start time of the failed
/// call (the working set is polled regularly – a revoked device shows up there first).
public final class SignallingEnumerator: NSObject, NSFileProviderEnumerator {
    private let inner: NSFileProviderEnumerator
    private let onError: (Error, Date) -> Void

    public init(inner: NSFileProviderEnumerator, onError: @escaping (Error, Date) -> Void) {
        self.inner = inner
        self.onError = onError
    }

    public func invalidate() { inner.invalidate() }

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let started = Date()
        inner.enumerateItems(for: ItemObserver(inner: observer, onError: { [onError] in onError($0, started) }), startingAt: page)
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
        guard let enumerateChanges = inner.enumerateChanges else {
            // The inner enumerator has no change tracking: let the system re-enumerate.
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
        let started = Date()
        enumerateChanges(ChangeObserver(inner: observer, onError: { [onError] in onError($0, started) }), syncAnchor)
    }

    public func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
        guard let current = inner.currentSyncAnchor else {
            completionHandler(nil)
            return
        }
        current(completionHandler)
    }

    private final class ItemObserver: NSObject, NSFileProviderEnumerationObserver {
        let inner: NSFileProviderEnumerationObserver
        let onError: (Error) -> Void

        init(inner: NSFileProviderEnumerationObserver, onError: @escaping (Error) -> Void) {
            self.inner = inner
            self.onError = onError
        }

        var suggestedPageSize: Int { inner.suggestedPageSize ?? FileProviderEnumerator.defaultPageSize }
        func didEnumerate(_ updatedItems: [NSFileProviderItemProtocol]) { inner.didEnumerate(updatedItems) }
        func finishEnumerating(upTo nextPage: NSFileProviderPage?) { inner.finishEnumerating(upTo: nextPage) }
        func finishEnumeratingWithError(_ error: Error) {
            onError(error)
            inner.finishEnumeratingWithError(error)
        }
    }

    private final class ChangeObserver: NSObject, NSFileProviderChangeObserver {
        let inner: NSFileProviderChangeObserver
        let onError: (Error) -> Void

        init(inner: NSFileProviderChangeObserver, onError: @escaping (Error) -> Void) {
            self.inner = inner
            self.onError = onError
        }

        var suggestedBatchSize: Int { inner.suggestedBatchSize ?? FileProviderEnumerator.defaultPageSize }
        func didUpdate(_ updatedItems: [NSFileProviderItemProtocol]) { inner.didUpdate(updatedItems) }
        func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {
            inner.didDeleteItems(withIdentifiers: deletedItemIdentifiers)
        }
        func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) {
            inner.finishEnumeratingChanges(upTo: anchor, moreComing: moreComing)
        }
        func finishEnumeratingWithError(_ error: Error) {
            onError(error)
            inner.finishEnumeratingWithError(error)
        }
    }
}
