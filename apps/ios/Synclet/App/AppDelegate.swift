import os
import SyncletKit
import UIKit

/// UIKit hooks SwiftUI does not offer: the background refresh registration (before launch
/// ends), background `URLSession` events (uploads) and the extension's Darwin notification.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !AppEnvironment.isRunningTests else { return true }
        let environment = AppEnvironment.shared
        BackgroundRefresh.register(accounts: environment.accountStore)
        observeAuthFailures()
        // Old entries pruned, waiting uploads (also the Share extension's) started.
        UploadCenter.shared.launch(accounts: environment.accounts)
        return true
    }

    /// Events of the app's upload session, or of the Share extension's once it is gone
    /// (spec §2.6); the uploader calls the handler after the session delivered them.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        nonisolated(unsafe) let handler = completionHandler
        UploadCenter.shared.handleBackgroundEvents(identifier: identifier) {
            DispatchQueue.main.async { handler() }
        }
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
