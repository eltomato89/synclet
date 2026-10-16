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
    /// After signing in again: lifts the system's throttling of items that failed with
    /// `.notAuthenticated` (`signalErrorResolved`) and lets the extension re-read the working set.
    func resolveAuthentication(domain: NSFileProviderDomain) async
    /// The server is reachable again (SSE `hello`, a successful `GET /account`): lifts the
    /// system's throttling of items that failed with `.serverUnreachable` or
    /// `.insufficientQuota` (507), so stuck uploads are retried now.
    func resolveTransientErrors(domain: NSFileProviderDomain) async
}

/// Production: `NSFileProviderManager`.
struct SystemFinderIntegration: FinderIntegrating {
    func userVisibleURL(domain: NSFileProviderDomain) async throws -> URL {
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        return try await manager.getUserVisibleURL(for: .rootContainer)
    }

    func resolveAuthentication(domain: NSFileProviderDomain) async {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        do {
            try await manager.signalErrorResolved(NSFileProviderError(.notAuthenticated))
        } catch {
            Logger.app.error("signalErrorResolved failed: \(String(describing: error), privacy: .public)")
        }
        try? await manager.signalEnumerator(for: .workingSet)
    }

    func resolveTransientErrors(domain: NSFileProviderDomain) async {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        for code in [NSFileProviderError.Code.serverUnreachable, .insufficientQuota] {
            do {
                try await manager.signalErrorResolved(NSFileProviderError(code))
            } catch {
                Logger.app.error("signalErrorResolved(\(code.rawValue, privacy: .public)) failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func pendingItemCount(domain: NSFileProviderDomain) async -> Int? {
        guard let manager = NSFileProviderManager(for: domain) else { return nil }
        return await PendingCounter.count(manager.enumeratorForPendingItems(), timeout: .seconds(3))
    }
}

/// Counts the items of a pending set enumerator (all pages); `nil` on error or timeout.
private final class PendingCounter: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
    private let enumerator: NSFileProviderEnumerator
    private let lock = NSLock()
    // Guarded by `lock`.
    private var total = 0
    private var finished = false
    private var continuation: CheckedContinuation<Int?, Never>?
    private var timeoutTask: Task<Void, Never>?

    private init(enumerator: NSFileProviderEnumerator) {
        self.enumerator = enumerator
    }

    static func count(_ enumerator: NSFileProviderEnumerator, timeout: Duration) async -> Int? {
        let counter = PendingCounter(enumerator: enumerator)
        let result = await withCheckedContinuation { continuation in
            let timeoutTask = Task {
                try? await Task.sleep(for: timeout)
                if !Task.isCancelled { counter.finish(nil) }
            }
            counter.lock.withLock {
                counter.continuation = continuation
                counter.timeoutTask = timeoutTask
            }
            enumerator.enumerateItems(for: counter, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        }
        enumerator.invalidate()
        return result
    }

    /// Resumes once (enumeration end or timeout, whichever comes first); later calls are ignored.
    private func finish(_ value: Int?) {
        let (continuation, timeoutTask) = lock.withLock { () -> (CheckedContinuation<Int?, Never>?, Task<Void, Never>?) in
            guard !finished else { return (nil, nil) }
            finished = true
            defer {
                self.continuation = nil
                self.timeoutTask = nil
            }
            return (self.continuation, self.timeoutTask)
        }
        timeoutTask?.cancel()
        continuation?.resume(returning: value)
    }

    func didEnumerate(_ updatedItems: [NSFileProviderItemProtocol]) {
        lock.withLock { total += updatedItems.count }
    }

    func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
        let (done, count) = lock.withLock { (finished, total) }
        guard !done else { return }   // timed out: the enumerator is (being) invalidated, stop paging
        if let nextPage {
            enumerator.enumerateItems(for: self, startingAt: nextPage)
        } else {
            finish(count)
        }
    }

    func finishEnumeratingWithError(_ error: Error) {
        finish(nil)
    }
}

extension Logger {
    static let app = Logger(subsystem: "tech.jensk.synclet", category: "app")
}
