import FileProvider
import Foundation
import SyncletKit

/// Principal class of the macOS File Provider extension.
///
/// The logic (enumeration, download, upload, conflict copies, the virtual top level) lives
/// in ``SyncletReplicatedExtension`` from SyncletKit, which reads the account from the
/// domain identifier (`key16`) and the device token from the shared keychain. This subclass
/// only tells the menu bar app when the server rejects the sign-in
/// (`.notAuthenticated` ⇒ ``AuthFailureSignal``), so it can show "Anmeldung erforderlich".
final class FileProviderExtension: SyncletReplicatedExtension, @unchecked Sendable {
    private var key16: String { domain.identifier.rawValue }

    /// Root of the app group container (parent of `accounts/`).
    private lazy var container: URL? = Self.sharedConfiguration.appGroup.map { AccountStore(appGroup: $0).directory }

    /// Reports `.notAuthenticated` to the app; other errors are ignored.
    fileprivate func inspect(_ error: Error?) {
        guard let error, Self.isAuthenticationFailure(error), let container else { return }
        AuthFailureSignal.report(container: container, key16: key16)
    }

    static func isAuthenticationFailure(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSFileProviderErrorDomain && ns.code == NSFileProviderError.notAuthenticated.rawValue
    }

    override func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
                       completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        super.item(for: identifier, request: request) { [self] item, error in
            inspect(error)
            completionHandler(item, error)
        }
    }

    override func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                             request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        do {
            let inner = try super.enumerator(for: containerItemIdentifier, request: request)
            return SignallingEnumerator(inner: inner) { [weak self] error in self?.inspect(error) }
        } catch {
            inspect(error)
            throw error
        }
    }

    override func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                                request: NSFileProviderRequest,
                                completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        super.fetchContents(for: itemIdentifier, version: requestedVersion, request: request) { [self] url, item, error in
            inspect(error)
            completionHandler(url, item, error)
        }
    }

    override func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                             options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        super.createItem(basedOn: itemTemplate, fields: fields, contents: url, options: options, request: request) { [self] item, fields, later, error in
            inspect(error)
            completionHandler(item, fields, later, error)
        }
    }

    override func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                             changedFields: NSFileProviderItemFields, contents newContents: URL?,
                             options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        super.modifyItem(item, baseVersion: version, changedFields: changedFields, contents: newContents,
                         options: options, request: request) { [self] item, fields, later, error in
            inspect(error)
            completionHandler(item, fields, later, error)
        }
    }

    override func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                             options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (Error?) -> Void) -> Progress {
        super.deleteItem(identifier: identifier, baseVersion: version, options: options, request: request) { [self] error in
            inspect(error)
            completionHandler(error)
        }
    }
}

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
        inner.enumerateChanges?(for: ChangeObserver(inner: observer, onError: onError), from: syncAnchor)
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
