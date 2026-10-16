import FileProvider
import Foundation
import SyncletKit

/// Principal class of the iOS File Provider extension (Files app).
///
/// The logic (enumeration, download, upload, conflict copies, the virtual top level) lives
/// in ``SyncletReplicatedExtension`` from SyncletKit, which reads the account from the
/// domain identifier (`key16`) and the device token from the shared keychain. This subclass
/// only tells the app when the server rejects the sign-in (`.notAuthenticated` ⇒
/// ``AuthFailureSignal``), so the account shows "Neu anmelden". The thumbnail override is
/// kept because it reports auth failures of thumbnail requests too.
final class FileProviderExtension: SyncletReplicatedExtension, @unchecked Sendable {
    private var key16: String { domain.identifier.rawValue }

    /// Root of the app group container (parent of `accounts/`). Computed, not `lazy`: `inspect`
    /// runs on arbitrary queues, and lazy initialization is not thread-safe. Only used on
    /// auth failures, so the cost does not matter.
    private var container: URL? { Self.sharedConfiguration.appGroup.map { AccountStore(appGroup: $0).directory } }

    /// Reports `.notAuthenticated` to the app; other errors are ignored. `started` is when the
    /// operation began: a failure of an operation older than the current sign-in is ignored
    /// (it used the previous, revoked token).
    fileprivate func inspect(_ error: Error?, started: Date) {
        guard let error, AuthFailureSignal.isAuthenticationFailure(error), let container else { return }
        AuthFailureSignal.report(container: container, key16: key16, startedAt: started)
    }

    override func fetchThumbnails(for itemIdentifiers: [NSFileProviderItemIdentifier], requestedSize size: CGSize,
                                  perThumbnailCompletionHandler: @escaping (NSFileProviderItemIdentifier, Data?, Error?) -> Void,
                                  completionHandler: @escaping (Error?) -> Void) -> Progress {
        let started = Date()
        return super.fetchThumbnails(for: itemIdentifiers, requestedSize: size, perThumbnailCompletionHandler: { [self] id, data, error in
            inspect(error, started: started)
            perThumbnailCompletionHandler(id, data, error)
        }, completionHandler: { [self] error in
            inspect(error, started: started)
            completionHandler(error)
        })
    }

    override func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
                       completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let started = Date()
        return super.item(for: identifier, request: request) { [self] item, error in
            inspect(error, started: started)
            completionHandler(item, error)
        }
    }

    override func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                             request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        do {
            let inner = try super.enumerator(for: containerItemIdentifier, request: request)
            return SignallingEnumerator(inner: inner) { [weak self] error, started in self?.inspect(error, started: started) }
        } catch {
            inspect(error, started: Date())
            throw error
        }
    }

    override func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                                request: NSFileProviderRequest,
                                completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let started = Date()
        return super.fetchContents(for: itemIdentifier, version: requestedVersion, request: request) { [self] url, item, error in
            inspect(error, started: started)
            completionHandler(url, item, error)
        }
    }

    override func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                             options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let started = Date()
        return super.createItem(basedOn: itemTemplate, fields: fields, contents: url, options: options, request: request) { [self] item, fields, later, error in
            inspect(error, started: started)
            completionHandler(item, fields, later, error)
        }
    }

    override func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                             changedFields: NSFileProviderItemFields, contents newContents: URL?,
                             options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let started = Date()
        return super.modifyItem(item, baseVersion: version, changedFields: changedFields, contents: newContents,
                         options: options, request: request) { [self] item, fields, later, error in
            inspect(error, started: started)
            completionHandler(item, fields, later, error)
        }
    }

    override func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                             options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                             completionHandler: @escaping (Error?) -> Void) -> Progress {
        let started = Date()
        return super.deleteItem(identifier: identifier, baseVersion: version, options: options, request: request) { [self] error in
            inspect(error, started: started)
            completionHandler(error)
        }
    }
}
