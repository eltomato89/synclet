import FileProvider
import Foundation

/// "Sign-in rejected" signal from the File Provider extension to the menu bar app
/// (app and extension).
///
/// When the server rejects the device token (`401 unauthorized` / `device_revoked`, or the
/// token is missing ⇒ `NSFileProviderError(.notAuthenticated)`), the extension writes the
/// marker file `accounts/<key16>/auth-failed` into the app group container and posts the
/// Darwin notification ``notificationName``. The app then shows the account as
/// "Anmeldung erforderlich". Signing in again clears the marker and keeps the domain.
public enum AuthFailureSignal {
    /// Darwin notification (cross-process, no payload).
    public static let notificationName = "tech.jensk.synclet.authFailed"
    /// Marker file inside `accounts/<key16>/`; its content is the ISO 8601 start time of the
    /// failed operation (or the time of the failure).
    public static let markerName = "auth-failed"
    /// The extension reports the same failure for every item; one signal per minute is enough.
    public static let throttle: TimeInterval = 60

    /// The error the extension reports: `NSFileProviderError(.notAuthenticated)`.
    public static func isAuthenticationFailure(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSFileProviderErrorDomain && ns.code == NSFileProviderError.notAuthenticated.rawValue
    }

    /// `<container>/accounts/<key16>/auth-failed`.
    public static func markerURL(container: URL, key16: String) -> URL {
        container.appending(path: "accounts", directoryHint: .isDirectory)
            .appending(path: key16, directoryHint: .isDirectory)
            .appending(path: markerName, directoryHint: .notDirectory)
    }

    /// Extension: records the failure and notifies the app. Returns `true` when a signal was
    /// sent (`false`: throttled, the account directory does not exist – signed out – or the
    /// failed operation started before the current sign-in and so used the previous token).
    ///
    /// - Parameter startedAt: when the failed operation started (default: `now`).
    @discardableResult
    public static func report(container: URL, key16: String, now: Date = Date(), startedAt: Date? = nil,
                       post: Bool = true) -> Bool {
        let marker = markerURL(container: container, key16: key16)
        let directory = marker.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: directory.path) else { return false }
        let started = startedAt ?? now
        if isStale(started, container: container, key16: key16) { return false }
        if let last = date(of: marker), abs(now.timeIntervalSince(last)) < throttle { return false }
        do {
            try Data(formatter.string(from: started).utf8).write(to: marker, options: .atomic)
        } catch {
            return false
        }
        if post { postNotification() }
        return true
    }

    /// App: the time of a pending failure of an account, if any. A marker of an operation
    /// that started before the current sign-in is stale: it is removed and ignored.
    public static func pending(container: URL, key16: String) -> Date? {
        guard let date = date(of: markerURL(container: container, key16: key16)) else { return nil }
        if isStale(date, container: container, key16: key16) {
            clear(container: container, key16: key16)
            return nil
        }
        return date
    }

    /// The operation started before the account's current device token was stored.
    private static func isStale(_ started: Date, container: URL, key16: String) -> Bool {
        guard let signedInAt = AccountStore(directory: container).account(key16: key16)?.signedInAt else { return false }
        // The marker keeps milliseconds.
        return started.addingTimeInterval(0.001) < signedInAt
    }

    /// App: the failure was handled (signed in again or signed out).
    public static func clear(container: URL, key16: String) {
        try? FileManager.default.removeItem(at: markerURL(container: container, key16: key16))
    }

    public static func postNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(notificationName as CFString), nil, nil, true
        )
    }

    private static func date(of marker: URL) -> Date? {
        guard let data = try? Data(contentsOf: marker) else { return nil }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        // A marker without a readable date still counts (written now-ish).
        return formatter.date(from: text) ?? plainFormatter.date(from: text) ?? Date(timeIntervalSince1970: 0)
    }

    /// Written with milliseconds (compared with the sign-in time).
    nonisolated(unsafe) private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Markers of earlier versions (whole seconds).
    nonisolated(unsafe) private static let plainFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
