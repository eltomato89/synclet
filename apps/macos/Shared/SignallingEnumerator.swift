import FileProvider
import Foundation
import SyncletKit

/// Passes an enumeration through and reports its errors (the working set is polled
/// regularly – a revoked device shows up there first).
final class SignallingEnumerator: NSObject, NSFileProviderEnumerator {
    private let inner: NSFileProviderEnumerator
    private let onError: (Error) -> Void

    init(inner: NSFileProviderEnumerator, onError: @escaping (Error) -> Void) {
        self.inner = inner
        self.onError = onError
    }

    func invalidate() { inner.invalidate() }

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        inner.enumerateItems(for: ItemObserver(inner: observer, onError: onError), startingAt: page)
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
        guard let enumerateChanges = inner.enumerateChanges else {
            // The inner enumerator has no change tracking: let the system re-enumerate.
            observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            return
        }
        enumerateChanges(ChangeObserver(inner: observer, onError: onError), syncAnchor)
    }

    func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
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
