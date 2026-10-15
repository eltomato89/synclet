import FileProvider
import Foundation

/// Translates errors of the Sync API (and of the virtual top level) into the errors the
/// File Provider system expects.
///
/// Read-only rule (as before): a server `403 forbidden` / `400 invalid_move` is
/// `CocoaError(.fileWriteNoPermission)`. Writes into the virtual top level
/// (``SpaceLayoutError/readOnlyTopLevel``) are `NSFileProviderError(.cannotSynchronize)`;
/// the extension rejects renaming/moving/deleting a space folder itself with
/// `CocoaError(.featureUnsupported)` before anything reaches the server.
public enum ErrorMapping {
    public static func fileProviderError(_ error: Error) -> Error {
        if error is CancellationError {
            return CocoaError(.userCancelled)
        }
        if let error = error as? NSFileProviderError {
            return error
        }
        if let error = error as? SpaceLayoutError {
            switch error {
            case .readOnlyTopLevel: return NSFileProviderError(.cannotSynchronize)
            case .unknownSpace: return NSFileProviderError(.noSuchItem)
            }
        }
        guard let apiError = error as? SyncAPIError else {
            let ns = error as NSError
            if ns.domain == NSFileProviderErrorDomain || ns.domain == NSCocoaErrorDomain {
                return error
            }
            if ns.domain == NSURLErrorDomain {
                return NSFileProviderError(.serverUnreachable)
            }
            return NSFileProviderError(.cannotSynchronize)
        }
        switch apiError {
        case .unauthorized, .deviceRevoked:
            return NSFileProviderError(.notAuthenticated)
        case .forbidden, .invalidMove:
            return CocoaError(.fileWriteNoPermission)
        case .notFound:
            return NSFileProviderError(.noSuchItem)
        case .nameConflict:
            return NSFileProviderError(.filenameCollision)
        case .invalidName:
            return CocoaError(.fileWriteInvalidFileName)
        case .cursorExpired:
            return NSFileProviderError(.syncAnchorExpired)
        case .tooLarge, .insufficientStorage:
            return NSFileProviderError(.insufficientQuota)
        case .transport, .rateLimited:
            return NSFileProviderError(.serverUnreachable)
        case .http(let status, _, _) where status >= 500 || status == 423:
            return NSFileProviderError(.serverUnreachable)
        case .passwordLoginDisabled:
            return NSFileProviderError(.notAuthenticated)
        case .conflict, .preconditionRequired, .notModified, .http, .invalidResponse, .invalidRequest,
             .rangeNotSatisfiable, .setupDone:
            return NSFileProviderError(.cannotSynchronize)
        }
    }
}
