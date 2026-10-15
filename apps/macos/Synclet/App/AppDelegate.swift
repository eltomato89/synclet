import AppKit
import os
import SwiftUI
import SyncletKit

/// Wiring of the app: models, the extension's signals and the windows (login, settings).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let accounts: AccountsModel
    let loginItem = LoginItemController()

    private var loginWindow: NSWindow?
    private var settingsWindow: NSWindow?

    /// Running as the XCTest host – no side effects at launch.
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    override init() {
        let configuration = SharedConfiguration.fromInfoPlist()
        if configuration.appGroup == nil { Logger.app.fault("SyncletAppGroup missing in the Info.plist") }
        let store = AccountStore(appGroup: configuration.appGroup ?? "group.tech.jensk.synclet")
        let manager = AccountManager(credentials: CredentialStore(configuration: configuration), accounts: store)
        accounts = AccountsModel(manager: manager)
        super.init()
        accounts.onFirstAccountAdded = { [loginItem] in loginItem.enableByDefaultIfUnconfigured() }
    }

    var actions: AppActions {
        AppActions(
            openInFinder: { [weak self] key in
                guard let self else { return }
                Task {
                    await self.accounts.openInFinder(key: key)
                    self.presentActionError()
                }
            },
            openWeb: { [weak self] key in self?.accounts.openWeb(key: key) },
            signIn: { [weak self] account in self?.showLogin(prefill: account) },
            signOut: { [weak self] key in
                guard let self else { return }
                Task { await self.confirmSignOut(key: key) }
            },
            showSettings: { [weak self] in self?.showSettings() },
            quit: { NSApp.terminate(nil) }
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !Self.isRunningTests else { return }
        observeExtensionSignals()
        Task {
            // Domains the system lost (e.g. after an update) are added again.
            do {
                try await accounts.manager.restoreMissingDomains()
            } catch {
                Logger.app.error("restoring domains failed: \(String(describing: error), privacy: .public)")
            }
            accounts.reload()
        }
        if accounts.isEmpty || ProcessInfo.processInfo.arguments.contains("-SyncletShowLogin") {
            showLogin(prefill: nil)
        }
        if ProcessInfo.processInfo.arguments.contains("-SyncletShowSettings") {
            showSettings()
        }
    }

    /// `synclet://` URLs outside a running browser login (the session receives its own redirect).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            Logger.app.info("ignoring URL \(url.scheme ?? "", privacy: .public)://\(url.host() ?? "", privacy: .public)")
        }
    }

    // MARK: - Signals

    private func observeExtensionSignals() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), observer,
            { _, observer, _, _, _ in
                guard let observer else { return }
                let delegate = Unmanaged<AppDelegate>.fromOpaque(observer).takeUnretainedValue()
                Task { @MainActor in delegate.accounts.processAuthFailures() }
            },
            AuthFailureSignal.notificationName as CFString, nil, .deliverImmediately
        )
    }

    // MARK: - Windows

    func showLogin(prefill: StoredAccount?) {
        loginWindow?.close()
        let model = LoginModel(accounts: accounts, prefill: prefill)
        let view = LoginView(model: model) { [weak self] in self?.loginWindow?.close() }
        let window = makeWindow(title: String(localized: "Add Account"), content: view)
        loginWindow = window
        present(window)
    }

    func showSettings() {
        let window = settingsWindow ?? makeWindow(
            title: String(localized: "Synclet Settings"),
            content: SettingsView(accounts: accounts, loginItem: loginItem, actions: actions))
        settingsWindow = window
        present(window)
    }

    /// Window with a fixed size taken from its content.
    private func makeWindow(title: String, content: some View) -> NSWindow {
        let hosting = NSHostingController(rootView: content)
        // Size once from the content – automatic resizing (`sizingOptions`) loops with wrapping text.
        hosting.sizingOptions = []
        let window = NSWindow(contentViewController: hosting)
        window.setContentSize(hosting.view.fittingSize)
        window.styleMask = [.titled, .closable]
        window.title = title
        window.isReleasedWhenClosed = false
        return window
    }

    private func present(_ window: NSWindow) {
        window.center()
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: - Sign out

    private func confirmSignOut(key: String) async {
        guard let entry = accounts.entry(key: key) else { return }
        let pending = await accounts.pendingChanges(key: key)
        let alert = NSAlert()
        alert.messageText = String(localized: "Sign out \(entry.title)?")
        var info = String(localized: "Your files stay on the server. The folder and the copies downloaded to this Mac are removed.")
        switch pending {
        case .none:
            break
        case .some(let count):
            info += "\n\n" + String(localized: "\(count) local changes have not been uploaded yet and will be lost.")
            alert.alertStyle = .critical
        case .unknown:
            info += "\n\n" + String(localized: "Changes that have not been uploaded will be lost.")
            alert.alertStyle = .warning
        }
        alert.informativeText = info
        alert.addButton(withTitle: String(localized: "Sign Out"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        await accounts.signOut(key: key)
    }

    private func presentActionError() {
        guard let message = accounts.lastActionError else { return }
        accounts.lastActionError = nil
        let alert = NSAlert()
        alert.messageText = message
        NSApp.activate()
        alert.runModal()
    }
}
