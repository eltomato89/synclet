import os
import SyncletKit
import UIKit

/// UIKit hooks SwiftUI does not offer: the background refresh registration (before launch
/// ends), background `URLSession` events (uploads, Task 8) and the extension's Darwin
/// notification.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Completion handlers of background `URLSession`s, by session identifier. The uploader
    /// calls ``takeBackgroundCompletionHandler(for:)`` once the session delivered its events.
    private var backgroundCompletionHandlers: [String: () -> Void] = [:]

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !AppEnvironment.isRunningTests else { return true }
        let environment = AppEnvironment.shared
        BackgroundRefresh.register(accounts: environment.accountStore)
        observeAuthFailures()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        backgroundCompletionHandlers[identifier] = completionHandler
    }

    /// The system's completion handler for a background session's events (called once).
    func takeBackgroundCompletionHandler(for identifier: String) -> (() -> Void)? {
        backgroundCompletionHandlers.removeValue(forKey: identifier)
    }

    /// The extension wrote an auth-failure marker: update the account list.
    private func observeAuthFailures() {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in
                Task { @MainActor in AppEnvironment.shared.accounts.processAuthFailures() }
            },
            AuthFailureSignal.notificationName as CFString, nil, .deliverImmediately
        )
    }
}
