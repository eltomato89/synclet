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

// MARK: - User-visible problems

/// A failure (or notable event) the user should see in the menu bar's "Letzte Probleme"
/// (spec §2.7): the cases the File Provider system does not explain by itself and that a
/// retry does not fix soon. Transient errors (network, 5xx, rate limits) and errors the
/// system resolves on its own (sign-in, missing items, name collisions) are not problems.
public struct SyncProblem: Sendable, Hashable {
    public enum Code: String, Sendable, Codable, CaseIterable {
        /// `413`: above the server's upload limit – never retried successfully.
        case tooLarge = "too_large"
        /// `507`: the server's disk or quota is full (retried with backoff).
        case insufficientStorage = "insufficient_storage"
        /// `400 invalid_name`.
        case invalidName = "invalid_name"
        /// `403 forbidden`, `400 invalid_move`, or a write into the read-only top level.
        case permission
        /// `412` on a replace: the local version was uploaded as a conflict copy (info).
        case conflictCopy = "conflict_copy"
    }

    public var code: Code
    /// Name of the affected file (for a conflict copy: the original's name).
    public var fileName: String
    /// File Provider identifier to reveal in Finder (for a conflict copy: the copy).
    public var itemIdentifier: String?
    /// Extra text: the conflict copy's name.
    public var detail: String?

    public init(code: Code, fileName: String, itemIdentifier: String?, detail: String? = nil) {
        self.code = code
        self.fileName = fileName
        self.itemIdentifier = itemIdentifier
        self.detail = detail
    }

    /// Information, not an error (does not mark the account as failed).
    public var isInfo: Bool { code == .conflictCopy }

    /// The user-facing text (en/de from the kit's resources).
    public func message(bundle: Bundle? = nil) -> String {
        switch code {
        case .tooLarge:
            return L10n.string("problem.tooLarge", "Too large for the server – not uploaded.", bundle: bundle)
        case .insufficientStorage:
            return L10n.string("problem.insufficientStorage", "The server's storage is full – will retry later.", bundle: bundle)
        case .invalidName:
            return L10n.string("problem.invalidName", "The name is not allowed on the server.", bundle: bundle)
        case .permission:
            return L10n.string("problem.permission", "Not allowed here – the change was not synced.", bundle: bundle)
        case .conflictCopy:
            let format = L10n.string("problem.conflictCopy", "Changed elsewhere – your version was saved as “%@”.", bundle: bundle)
            return String(format: format, detail ?? fileName)
        }
    }
}

extension ErrorMapping {
    /// The user-visible problem behind a failed create/modify, or `nil` when the error is
    /// transient or handled by the system.
    public static func problem(for error: Error, fileName: String, itemIdentifier: String?) -> SyncProblem? {
        let code: SyncProblem.Code
        switch error {
        case SyncAPIError.tooLarge: code = .tooLarge
        case SyncAPIError.insufficientStorage: code = .insufficientStorage
        case SyncAPIError.invalidName: code = .invalidName
        case SyncAPIError.forbidden, SyncAPIError.invalidMove: code = .permission
        case SpaceLayoutError.readOnlyTopLevel: code = .permission
        default: return nil
        }
        return SyncProblem(code: code, fileName: fileName, itemIdentifier: itemIdentifier)
    }
}
