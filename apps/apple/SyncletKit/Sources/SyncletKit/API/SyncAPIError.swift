import Foundation

/// Errors of the Sync API, derived from the HTTP status and `code` (SYNC_API.md §1).
public enum SyncAPIError: Error, Sendable, Equatable {
    /// 401 `unauthorized` – token missing/invalid/expired, user disabled.
    case unauthorized(message: String?)
    /// 401 `device_revoked` – the device was signed out; the client needs a new login.
    case deviceRevoked
    /// 403 `forbidden` – action not allowed on this item (root) or with this token.
    case forbidden(message: String?)
    /// 403 `password_login_disabled` – use the browser login.
    case passwordLoginDisabled
    /// 404 `not_found` (also: an unknown route without `code`).
    case notFound
    /// 409 `name_conflict` – `existing` = the sibling at the target.
    case nameConflict(existing: SyncItem?)
    /// 409 `setup_done`.
    case setupDone
    /// 400 `invalid_move`.
    case invalidMove(message: String?)
    /// 400 `invalid_name`.
    case invalidName(message: String?)
    /// 400 `invalid_request` (and 415 of `preview-text`).
    case invalidRequest(message: String?)
    /// 410 `cursor_expired` – full re-enumeration needed.
    case cursorExpired
    /// 412 `conflict` – `current` = the current server state.
    case conflict(current: SyncItem?)
    /// 428 `precondition_required` – `If-Match` missing on PUT content.
    case preconditionRequired
    /// 413 `too_large` (also a 413 of a proxy without JSON body) – do not retry.
    case tooLarge(message: String?)
    /// 416 `range_not_satisfiable`.
    case rangeNotSatisfiable
    /// 429 `rate_limited` – wait `retryAfter` seconds (from `Retry-After`).
    case rateLimited(retryAfter: TimeInterval?)
    /// 507 `insufficient_storage` – the server's disk is full; retry later.
    case insufficientStorage(message: String?)
    /// 304 on a conditional request (`If-None-Match`).
    case notModified
    /// Any other HTTP error (e.g. 423 of a tus upload being published, 5xx).
    case http(status: Int, code: String?, message: String?)
    /// Response not readable.
    case invalidResponse(String)
    /// Network error (connection, timeout …).
    case transport(URLError.Code, message: String)

    /// Maps status + error body (+ `Retry-After`) to the matching case.
    public static func from(status: Int, body: SyncErrorBody?, retryAfter: TimeInterval? = nil) -> SyncAPIError {
        let code = body?.code
        let message = body?.message
        switch (status, code) {
        case (401, "device_revoked"): return .deviceRevoked
        case (401, _): return .unauthorized(message: message)
        case (403, "password_login_disabled"): return .passwordLoginDisabled
        case (403, _): return .forbidden(message: message)
        case (404, _): return .notFound
        case (409, "name_conflict"): return .nameConflict(existing: body?.item)
        case (409, "setup_done"): return .setupDone
        case (400, "invalid_move"): return .invalidMove(message: message)
        case (400, "invalid_name"): return .invalidName(message: message)
        case (400, "invalid_request"), (415, "invalid_request"): return .invalidRequest(message: message)
        case (410, "cursor_expired"): return .cursorExpired
        case (412, _): return .conflict(current: body?.item)
        case (413, _): return .tooLarge(message: message)
        case (416, _): return .rangeNotSatisfiable
        case (428, _): return .preconditionRequired
        case (429, _): return .rateLimited(retryAfter: retryAfter)
        case (507, _): return .insufficientStorage(message: message)
        default: return .http(status: status, code: code, message: message)
        }
    }

    /// Parses `Retry-After` (seconds or an HTTP date).
    public static func retryAfter(header: String?, now: Date = Date()) -> TimeInterval? {
        guard let header = header?.trimmingCharacters(in: .whitespaces), !header.isEmpty else { return nil }
        if let seconds = TimeInterval(header) { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: header) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    /// The login was rejected (device revoked / token invalid) – the user must sign in again.
    public var isAuthenticationFailure: Bool {
        switch self {
        case .unauthorized, .deviceRevoked: return true
        default: return false
        }
    }

    /// Temporary error – try again later.
    public var isTransient: Bool {
        switch self {
        case .transport, .rateLimited, .insufficientStorage: return true
        case .http(let status, _, _): return status >= 500 || status == 423
        default: return false
        }
    }
}

extension SyncAPIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return L10n.string("error.unauthorized", "You are not signed in. Please sign in again.")
        case .deviceRevoked:
            return L10n.string("error.deviceRevoked", "This device was signed out. Please sign in again.")
        case .forbidden:
            return L10n.string("error.forbidden", "You are not allowed to do this here.")
        case .passwordLoginDisabled:
            return L10n.string("error.passwordLoginDisabled", "Password login is disabled. Please sign in through the browser.")
        case .notFound:
            return L10n.string("error.notFound", "The file or folder no longer exists.")
        case .nameConflict:
            return L10n.string("error.nameConflict", "An item with this name already exists at the destination.")
        case .setupDone:
            return L10n.string("error.setupDone", "This server has already been set up.")
        case .invalidMove:
            return L10n.string("error.invalidMove", "The item cannot be moved there.")
        case .invalidName:
            return L10n.string("error.invalidName", "The name is not allowed.")
        case .invalidRequest:
            return L10n.string("error.invalidRequest", "The server rejected the request.")
        case .cursorExpired:
            return L10n.string("error.cursorExpired", "Your files are being re-synchronized. Please wait a moment.")
        case .conflict:
            return L10n.string("error.conflict", "The file was changed elsewhere in the meantime.")
        case .preconditionRequired:
            return L10n.string("error.preconditionRequired", "The server requires the file version for this change.")
        case .tooLarge:
            return L10n.string("error.tooLarge", "The file is too large for this server.")
        case .rangeNotSatisfiable:
            return L10n.string("error.rangeNotSatisfiable", "The download could not be resumed.")
        case .rateLimited:
            return L10n.string("error.rateLimited", "Too many attempts. Please try again in a moment.")
        case .insufficientStorage:
            return L10n.string("error.insufficientStorage", "The server's storage is full.")
        case .notModified:
            return L10n.string("error.notModified", "Unchanged.")
        case .http(let status, _, _):
            return String(format: L10n.string("error.http", "The server is not reachable right now (error %d). Please try again later."), status)
        case .invalidResponse:
            return L10n.string("error.invalidResponse", "Unexpected response from the server. Please try again later.")
        case .transport(_, let message):
            return message
        }
    }
}

/// Localized strings of the kit (en + de in `Resources/*.lproj/Localizable.strings`).
enum L10n {
    static func string(_ key: String, _ english: String, bundle: Bundle? = nil) -> String {
        (bundle ?? .module).localizedString(forKey: key, value: english, table: nil)
    }
}

/// Access to the kit's resource bundle (localizations).
public enum SyncletKitResources {
    public static var bundle: Bundle { .module }
}
