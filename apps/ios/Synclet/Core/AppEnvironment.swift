import FileProvider
import Foundation
import Observation
import os
import SyncletKit

extension Logger {
    static let app = Logger(subsystem: "tech.jensk.synclet", category: "app")
}

/// The app's shared objects: configuration (Info.plist), stores, the account manager and the
/// accounts model. One instance for the process (``shared``).
@MainActor
@Observable
final class AppEnvironment {
    static let shared = AppEnvironment()

    /// Running as the XCTest host – no side effects at launch.
    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    let configuration: SharedConfiguration
    let accountStore: AccountStore
    let credentials: CredentialStore
    let manager: AccountManager
    let accounts: AccountsModel
    @ObservationIgnored private let domains: FileProviderDomainControlling
    @ObservationIgnored private var launched = false

    init(configuration: SharedConfiguration = .fromInfoPlist(),
         domains: FileProviderDomainControlling = SystemFileProviderDomains()) {
        if configuration.appGroup == nil { Logger.app.fault("SyncletAppGroup missing in the Info.plist") }
        self.configuration = configuration
        self.domains = domains
        accountStore = AccountStore(appGroup: configuration.appGroup ?? "group.tech.jensk.synclet")
        credentials = CredentialStore(configuration: configuration)
        manager = AccountManager(credentials: credentials, accounts: accountStore, domains: domains,
                                 deviceName: AccountManager.iOSDeviceName())
        accounts = AccountsModel(manager: manager)
    }

    /// API client of an account (token read from the keychain per request).
    func client(for accountKey: String) -> SyncAPIClient? {
        manager.client(for: accountKey)
    }

    /// Lets the Files app catch up after a change made in the app.
    func signalWorkingSet(accountKey: String) async {
        await domains.signalEnumerator(domainIdentifier: AccountStore.key16(for: accountKey), container: .workingSet)
    }

    // MARK: - Lifecycle

    /// First scene of the process (iPad windows share it): domains the system lost come
    /// back; DEBUG test login.
    func launchOnce() async {
        guard !launched else { return }
        launched = true
        await restoreDomains()
        #if DEBUG
        await TestLogin.run(accounts: accounts)
        #endif
    }

    /// Re-adds domains the system lost.
    func restoreDomains() async {
        do {
            try await manager.restoreMissingDomains()
        } catch {
            Logger.app.error("restoring domains failed: \(String(describing: error), privacy: .public)")
        }
        accounts.reload()
    }

    /// Scene became active: auth markers, live changes.
    func didBecomeActive() {
        accounts.processAuthFailures()
        accounts.startMonitoring()
    }

    /// App went to the background: streams stop, the background refresh takes over.
    func didEnterBackground() {
        accounts.stopMonitoring()
        BackgroundRefresh.schedule()
    }
}
