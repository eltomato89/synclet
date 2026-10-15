import Foundation

/// Connection state of an account's live-change stream, as the menu shows it.
enum SyncConnectionState: Equatable, Sendable {
    case connected
    case connecting
    case offline
    case authFailed
    /// No monitor runs (yet) for the account.
    case unknown
}

/// Source of an account's connection state for the menu: Task 6's `ChangeMonitor`
/// (`@Observable`, so SwiftUI tracks the reads); until it is wired in,
/// ``FallbackAccountStatus``.
@MainActor
protocol AccountStatusProviding {
    var connectionState: SyncConnectionState { get }
    /// Last successful sync with the server (`nil`: not yet).
    var lastSync: Date? { get }
}

/// What the app knows without a change monitor: a rejected sign-in (the extension's
/// ``AuthFailureSignal`` or a missing token ⇒ `AccountStatus.needsLogin`), otherwise unknown.
struct FallbackAccountStatus: AccountStatusProviding {
    let entry: AccountEntry
    var connectionState: SyncConnectionState { entry.status == .needsLogin ? .authFailed : .unknown }
    var lastSync: Date? { nil }
}

/// The status line of one account in the menu (pure; derived from the account, its
/// connection and the error log).
struct AccountMenuState: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case connected(lastSync: Date?)
        case connecting
        case offline
        case needsLogin
        /// A non-informational problem of this account within ``recentProblemWindow``.
        case error
        case unknown
    }

    /// How long a problem counts as "recent" (account shows "Fehler", menu bar badge).
    static let recentProblemWindow: TimeInterval = 60 * 60

    var kind: Kind

    /// Precedence: sign-in > offline > recent error > connection.
    static func derive(status: AccountStatus, connection: SyncConnectionState, lastSync: Date?,
                       problems: [ErrorLogEntry], accountKey: String, now: Date) -> AccountMenuState {
        if status == .needsLogin || connection == .authFailed { return AccountMenuState(kind: .needsLogin) }
        if connection == .offline { return AccountMenuState(kind: .offline) }
        if hasRecentProblem(problems, accountKey: accountKey, now: now) { return AccountMenuState(kind: .error) }
        switch connection {
        case .connected: return AccountMenuState(kind: .connected(lastSync: lastSync))
        case .connecting: return AccountMenuState(kind: .connecting)
        case .unknown, .offline, .authFailed: return AccountMenuState(kind: .unknown)
        }
    }

    /// A non-info problem (of one account, or of any when `accountKey` is nil) within the window.
    static func hasRecentProblem(_ problems: [ErrorLogEntry], accountKey: String?, now: Date) -> Bool {
        problems.contains { entry in
            !entry.isInfo && (accountKey == nil || entry.accountKey == accountKey)
                && now.timeIntervalSince(entry.date) < recentProblemWindow
        }
    }

    /// The menu bar icon carries a badge: an account needs signing in again, or a recent problem.
    static func showsBadge(statuses: [AccountStatus], problems: [ErrorLogEntry], now: Date) -> Bool {
        statuses.contains(.needsLogin) || hasRecentProblem(problems, accountKey: nil, now: now)
    }

    var showsSignInAgain: Bool { kind == .needsLogin }

    var symbol: String {
        switch kind {
        case .connected: return "checkmark.circle"
        case .connecting: return "arrow.triangle.2.circlepath"
        case .offline: return "wifi.slash"
        case .needsLogin: return "person.crop.circle.badge.exclamationmark"
        case .error: return "exclamationmark.triangle"
        case .unknown: return "questionmark.circle"
        }
    }

    /// "Verbunden · Synchronisiert vor 2 Minuten", "Offline", "Anmeldung erforderlich" …
    func label(now: Date, locale: Locale = .current) -> String {
        switch kind {
        case .connected(let lastSync?):
            let relative = Self.relative(lastSync, now: now, locale: locale)
            return String(localized: "Connected · Synced \(relative)")
        case .connected(nil): return String(localized: "Connected")
        case .connecting: return String(localized: "Connecting…")
        case .offline: return String(localized: "Offline")
        case .needsLogin: return String(localized: "Sign-in required")
        case .error: return String(localized: "Error")
        case .unknown: return String(localized: "Status unknown")
        }
    }

    /// "vor 2 Minuten" / "2 minutes ago"; "gerade eben" / "just now" under 10 s.
    static func relative(_ date: Date, now: Date, locale: Locale) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        if abs(now.timeIntervalSince(date)) < 10 {
            formatter.dateTimeStyle = .named
            return formatter.localizedString(fromTimeInterval: 0)
        }
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
