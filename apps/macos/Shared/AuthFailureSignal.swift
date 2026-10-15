import Foundation

/// "Sign-in rejected" signal from the File Provider extension to the menu bar app
/// (both targets compile this file).
///
/// When the server rejects the device token (`401 unauthorized` / `device_revoked`, or the
/// token is missing ⇒ `NSFileProviderError(.notAuthenticated)`), the extension writes the
/// marker file `accounts/<key16>/auth-failed` into the app group container and posts the
/// Darwin notification ``notificationName``. The app then shows the account as
/// "Anmeldung erforderlich". Signing in again clears the marker and keeps the domain.
enum AuthFailureSignal {
    /// Darwin notification (cross-process, no payload).
    static let notificationName = "tech.jensk.synclet.authFailed"
    /// Marker file inside `accounts/<key16>/`; its content is the ISO 8601 time of the failure.
    static let markerName = "auth-failed"
    /// The extension reports the same failure for every item; one signal per minute is enough.
    static let throttle: TimeInterval = 60

    /// `<container>/accounts/<key16>/auth-failed`.
    static func markerURL(container: URL, key16: String) -> URL {
        container.appending(path: "accounts", directoryHint: .isDirectory)
            .appending(path: key16, directoryHint: .isDirectory)
            .appending(path: markerName, directoryHint: .notDirectory)
    }

    /// Extension: records the failure and notifies the app. Returns `true` when a signal was
    /// sent (`false`: throttled, or the account directory does not exist – signed out).
    @discardableResult
    static func report(container: URL, key16: String, now: Date = Date(), post: Bool = true) -> Bool {
        let marker = markerURL(container: container, key16: key16)
        let directory = marker.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: directory.path) else { return false }
        if let last = date(of: marker), abs(now.timeIntervalSince(last)) < throttle { return false }
        do {
            try Data(formatter.string(from: now).utf8).write(to: marker, options: .atomic)
        } catch {
            return false
        }
        if post { postNotification() }
        return true
    }

    /// App: the time of a pending failure of an account, if any.
    static func pending(container: URL, key16: String) -> Date? {
        date(of: markerURL(container: container, key16: key16))
    }

    /// App: the failure was handled (signed in again or signed out).
    static func clear(container: URL, key16: String) {
        try? FileManager.default.removeItem(at: markerURL(container: container, key16: key16))
    }

    static func postNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(notificationName as CFString), nil, nil, true
        )
    }

    private static func date(of marker: URL) -> Date? {
        guard let data = try? Data(contentsOf: marker) else { return nil }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        // A marker without a readable date still counts (written now-ish).
        return formatter.date(from: text) ?? Date(timeIntervalSince1970: 0)
    }

    nonisolated(unsafe) private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
