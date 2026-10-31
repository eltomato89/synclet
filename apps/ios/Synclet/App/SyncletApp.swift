import os
import SwiftUI
import SyncletKit

@main
struct SyncletApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    private let environment = AppEnvironment.shared

    var body: some Scene {
        WindowGroup {
            RootView(environment: environment)
                .task { await launch() }
                // `synclet://oauth` outside a running browser login (the session receives its own redirect).
                .onOpenURL { url in
                    Logger.app.info("ignoring URL \(url.scheme ?? "", privacy: .public)://\(url.host() ?? "", privacy: .public)")
                }
        }
        .onChange(of: scenePhase) { _, phase in
            guard !AppEnvironment.isRunningTests else { return }
            switch phase {
            case .active:
                environment.didBecomeActive()
                UploadCenter.shared.didBecomeActive()
            case .background:
                environment.didEnterBackground()
                UploadCenter.shared.didEnterBackground()
            default: break
            }
        }
    }

    private func launch() async {
        guard !AppEnvironment.isRunningTests else { return }
        await environment.launchOnce()
        if scenePhase == .active { environment.didBecomeActive() }
    }
}
