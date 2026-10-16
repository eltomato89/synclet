import Foundation
import Observation
import os
import SyncletKit

/// „Link teilen“ for one item (spec §2.3): reuses the newest active link or creates one;
/// password, expiry, download and (folders only) upload; revoking.
@MainActor
@Observable
final class ShareLinkModel {
    let item: SyncItem
    let server: URL
    @ObservationIgnored let api: SyncAPIClient

    /// The newest link that is active (not revoked, item not trashed) and not expired.
    private(set) var active: ShareLink?
    private(set) var state: LoadState = .idle
    /// A create, update or revoke is running.
    private(set) var isBusy = false
    /// Error of the last change.
    var error: String?

    /// A new password (empty = keep the link's current password).
    var password = ""
    var usePassword = false
    var expiresAt: Date?
    var allowDownload = true
    /// Only sent for folders.
    var allowUpload = false

    /// The settings of ``active`` as loaded (to send only what changed).
    @ObservationIgnored private var baseline = Settings()
    /// Clock for the expiry check.
    @ObservationIgnored var now: () -> Date = Date.init

    private static let log = Logger(subsystem: "tech.jensk.synclet", category: "share")

    private struct Settings: Equatable {
        var hasPassword = false
        var expiresAt: Date?
        var allowDownload = true
        var allowUpload = false
    }

    init(item: SyncItem, server: URL, api: SyncAPIClient) {
        self.item = item
        self.server = server
        self.api = api
    }

    var isFolder: Bool { item.isFolder }

    /// The URL of ``active`` (relative links resolved against the server).
    var activeURL: URL? { active?.absoluteURL(server: server) }

    /// `GET /api/shares?itemId=`; fills the form from the active link.
    func load() async {
        if state != .loaded { state = .loading }
        do {
            let links = try await api.shareLinks(itemID: item.id)
            adopt(Self.newestActive(links, now: now()))
            state = .loaded
        } catch is CancellationError {
            if state == .loading { state = .idle }
        } catch {
            Self.log.error("share links failed: \(String(describing: error), privacy: .public)")
            state = FolderModel.loadState(for: error)
        }
    }

    static func newestActive(_ links: [ShareLink], now: Date) -> ShareLink? {
        links
            .filter { link in
                guard link.isActive else { return false }
                guard let expiry = link.expiresAt else { return true }
                guard let date = SyncDate.parse(expiry) else { return false }
                return date > now
            }
            .max { (SyncDate.parse($0.createdAt) ?? .distantPast) < (SyncDate.parse($1.createdAt) ?? .distantPast) }
    }

    /// No active link: `POST`; otherwise `PATCH` with the changed fields only (nothing changed:
    /// no request). Returns the link's absolute URL for the share sheet, `nil` on failure.
    func createOrUpdate() async -> URL? {
        guard !isBusy else { return nil }
        isBusy = true
        defer { isBusy = false }
        error = nil
        do {
            if let active {
                let options = changes()
                if options != ShareLinkOptions() {
                    adopt(try await api.updateShareLink(id: active.id, options: options))
                }
            } else {
                adopt(try await api.createShareLink(itemID: item.id, options: creation()))
            }
            return activeURL
        } catch {
            report(error)
            return nil
        }
    }

    /// `DELETE /api/shares/:id`.
    func revoke() async {
        guard let active, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        error = nil
        do {
            try await api.revokeShareLink(id: active.id)
            adopt(nil)
        } catch {
            report(error)
        }
    }

    // MARK: - Private

    private var newPassword: String? {
        usePassword && !password.isEmpty ? password : nil
    }

    private func creation() -> ShareLinkOptions {
        ShareLinkOptions(password: newPassword.map { .some($0) },
                         expiresAt: expiresAt.map { .some($0) },
                         allowDownload: allowDownload,
                         allowUpload: isFolder ? allowUpload : nil)
    }

    private func changes() -> ShareLinkOptions {
        var options = ShareLinkOptions()
        if let newPassword {
            options.password = .some(newPassword)
        } else if !usePassword, baseline.hasPassword {
            options.password = .some(nil)
        }
        if !Self.sameMoment(expiresAt, baseline.expiresAt) { options.expiresAt = .some(expiresAt) }
        if allowDownload != baseline.allowDownload { options.allowDownload = allowDownload }
        if isFolder, allowUpload != baseline.allowUpload { options.allowUpload = allowUpload }
        return options
    }

    /// Dates are sent with whole seconds.
    private static func sameMoment(_ lhs: Date?, _ rhs: Date?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (l?, r?): return Int(l.timeIntervalSince1970) == Int(r.timeIntervalSince1970)
        default: return false
        }
    }

    /// Makes `link` the active link and resets the form to its settings (defaults without a link).
    private func adopt(_ link: ShareLink?) {
        active = link
        var settings = Settings()
        if let link {
            settings = Settings(hasPassword: link.hasPassword, expiresAt: link.expiresAt.flatMap(SyncDate.parse),
                                allowDownload: link.allowDownload, allowUpload: link.allowUpload)
        }
        baseline = settings
        usePassword = settings.hasPassword
        password = ""
        expiresAt = settings.expiresAt
        allowDownload = settings.allowDownload
        allowUpload = settings.allowUpload
    }

    private func report(_ error: Error) {
        Self.log.error("share change failed: \(String(describing: error), privacy: .public)")
        if case .http(_, _, let message?)? = error as? SyncAPIError {
            self.error = message
            return
        }
        self.error = MutationErrors.message(MutationErrors.outcome(for: error))
    }
}
