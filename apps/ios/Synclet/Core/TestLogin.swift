#if DEBUG
import Foundation
import os
import SyncletKit

/// DEBUG builds only (UI tests, scripted checks): signs in with a device token that was
/// registered beforehand, without the browser.
///
/// Launch arguments: `-SyncletTestServer <origin> -SyncletTestToken <syd_…>` (both required).
enum TestLogin {
    struct Request: Equatable {
        var server: URL
        var token: String
    }

    /// The request in `arguments`, if both values are present and valid.
    static func request(from arguments: [String]) -> Request? {
        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            let value = arguments[index + 1]
            return value.isEmpty || value.hasPrefix("-") ? nil : value
        }
        guard let serverText = value(after: "-SyncletTestServer"), let token = value(after: "-SyncletTestToken"),
              let server = try? ServerURL.normalize(serverText) else { return nil }
        return Request(server: server, token: token)
    }

    /// Stores the account (``AccountManager/addRegistered(server:deviceToken:)``) and selects it.
    static func run(arguments: [String] = ProcessInfo.processInfo.arguments, accounts: AccountsModel) async {
        guard let request = request(from: arguments) else { return }
        do {
            let stored = try await accounts.manager.addRegistered(server: request.server, deviceToken: request.token)
            await accounts.didSignIn(stored)
            Logger.app.notice("test login: signed in as \(stored.username, privacy: .public)")
        } catch {
            Logger.app.error("test login failed: \(String(describing: error), privacy: .public)")
        }
    }
}
#endif
