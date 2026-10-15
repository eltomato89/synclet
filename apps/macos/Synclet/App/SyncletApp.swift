import SwiftUI

/// Menu bar app (no Dock icon, `LSUIElement`).
@main
struct SyncletApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuView(accounts: appDelegate.accounts, actions: appDelegate.actions)
        } label: {
            MenuBarLabel(accounts: appDelegate.accounts)
        }
        .menuBarExtraStyle(.menu)
    }
}
