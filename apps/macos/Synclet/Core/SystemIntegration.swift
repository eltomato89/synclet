import AppKit
import FileProvider
import Foundation
import Observation
import os
import ServiceManagement
import SyncletKit

/// "Bei Anmeldung starten" via `SMAppService.mainApp`.
@MainActor
@Observable
final class LoginItemController {
    private(set) var isEnabled = false
    private(set) var requiresApproval = false
    var errorMessage: String?

    @ObservationIgnored private let defaults: UserDefaults
    /// Set once the user (or the first-account default) decided; the default never overrides it.
    static let configuredKey = "loginItemConfigured"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        reload()
    }

    func reload() {
        let status = SMAppService.mainApp.status
        isEnabled = status == .enabled
        requiresApproval = status == .requiresApproval
    }

    /// Settings toggle.
    func setEnabled(_ enabled: Bool) {
        defaults.set(true, forKey: Self.configuredKey)
        apply(enabled)
    }

    /// Default "on" after the first account, unless the user already chose. Debug builds
    /// (run from DerivedData) skip it, so development runs never register a login item.
    func enableByDefaultIfUnconfigured() {
        guard !defaults.bool(forKey: Self.configuredKey) else { return }
        defaults.set(true, forKey: Self.configuredKey)
        #if DEBUG
        Logger.app.info("debug build: not enabling the login item by default")
        #else
        apply(true)
        #endif
    }

    private func apply(_ enabled: Bool) {
        errorMessage = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            errorMessage = String(localized: "The login item could not be changed: \(error.localizedDescription)")
        }
        reload()
        if requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
        }
    }
}

/// Finder-related actions per File Provider domain (replaceable in tests).
protocol FinderIntegrating: Sendable {
    /// The account's folder in Finder (`~/Library/CloudStorage/…`).
    func userVisibleURL(domain: NSFileProviderDomain) async throws -> URL
    /// Number of items with local changes the extension has not uploaded yet;
    /// `nil` when it cannot be determined.
    func pendingItemCount(domain: NSFileProviderDomain) async -> Int?
    /// Lets the extension re-read the working set (e.g. after signing in again).
    func signalWorkingSet(domain: NSFileProviderDomain) async
}

/// Production: `NSFileProviderManager`.
struct SystemFinderIntegration: FinderIntegrating {
    func userVisibleURL(domain: NSFileProviderDomain) async throws -> URL {
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        return try await manager.getUserVisibleURL(for: .rootContainer)
    }

    func signalWorkingSet(domain: NSFileProviderDomain) async {
        try? await NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet)
    }

    func pendingItemCount(domain: NSFileProviderDomain) async -> Int? {
        guard let manager = NSFileProviderManager(for: domain) else { return nil }
        return await PendingCounter.count(manager.enumeratorForPendingItems(), timeout: .seconds(3))
    }
}

/// Counts the items of a pending set enumerator (all pages); `nil` on error or timeout.
private final class PendingCounter: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
    private let enumerator: NSFileProviderEnumerator
    private var total = 0
    private var continuation: CheckedContinuation<Int?, Never>?
    private let lock = NSLock()

    private init(enumerator: NSFileProviderEnumerator) {
        self.enumerator = enumerator
    }

    static func count(_ enumerator: NSFileProviderEnumerator, timeout: Duration) async -> Int? {
        let counter = PendingCounter(enumerator: enumerator)
        let result = await withCheckedContinuation { continuation in
            counter.lock.withLock { counter.continuation = continuation }
            Task {
                try? await Task.sleep(for: timeout)
                counter.finish(nil)
            }
            enumerator.enumerateItems(for: counter, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        }
        enumerator.invalidate()
        return result
    }

    /// Resumes once (enumeration end or timeout, whichever comes first).
    private func finish(_ value: Int?) {
        let continuation = lock.withLock { () -> CheckedContinuation<Int?, Never>? in
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(returning: value)
    }

    func didEnumerate(_ updatedItems: [NSFileProviderItemProtocol]) {
        lock.withLock { total += updatedItems.count }
    }

    func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
        if let nextPage {
            enumerator.enumerateItems(for: self, startingAt: nextPage)
        } else {
            finish(lock.withLock { total })
        }
    }

    func finishEnumeratingWithError(_ error: Error) {
        finish(nil)
    }
}

extension Logger {
    static let app = Logger(subsystem: "tech.jensk.synclet", category: "app")
}
