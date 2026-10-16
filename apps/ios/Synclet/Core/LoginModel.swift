import Foundation
import Observation
import os
import SyncletKit

/// Errors of the login flow, shown inline in the login sheet.
enum LoginError: Error, Equatable, LocalizedError {
    case invalidAddress
    /// Health or capabilities check failed: not a Synclet server.
    case notSynclet(host: String)
    case unreachable(host: String)
    /// `state` of the redirect differs – nothing was exchanged.
    case stateMismatch
    case denied(String)

    var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return String(localized: "Please enter a valid server address, e.g. files.example.com.")
        case .notSynclet(let host):
            return String(localized: "No Synclet server at \(host)")
        case .unreachable(let host):
            return String(localized: "\(host) cannot be reached. Check the address and your connection.")
        case .stateMismatch:
            return String(localized: "The sign-in could not be verified. Please try again.")
        case .denied(let reason):
            return String(localized: "The sign-in was refused (\(reason)).")
        }
    }
}

/// "Add account":
/// 1. Server field → ``ServerURL/normalize(_:)`` → `GET /api/health` (200 JSON) →
///    `GET /api/sync/v1/capabilities` (200, 401/403 with a Sync API error body, or 404 for an
///    older Synclet); anything else ⇒ "No Synclet server at <host>".
/// 2. ``PKCE/make()`` → `ASWebAuthenticationSession` on `<server>/app-login` (`client_id=ios`,
///    `redirect_uri=synclet://oauth`, S256, `state`).
/// 3. Check `state` → ``AuthAPI/exchangeCode(server:code:verifier:)`` → ``AccountsModel/add(server:tokens:)``
///    (device registration, token, domain – an existing account with the same key is replaced).
@MainActor
@Observable
final class LoginModel {
    /// OAuth client of the iOS app (server allow-list: `macos`, `ios`, `android`).
    static let clientID = "ios"

    enum Step: Equatable {
        case server
        case done(title: String)
    }

    var serverInput: String
    /// Hint at the top (e.g. "sign in again").
    let notice: String?
    private(set) var step: Step = .server
    private(set) var isBusy = false
    var errorMessage: String?

    @ObservationIgnored private let accounts: AccountsModel
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let browser: WebAuthenticating
    @ObservationIgnored private let loginHint: String?
    /// The running sign-in (``start()``); cancelled when the window closes.
    @ObservationIgnored private var task: Task<Void, Never>?

    init(accounts: AccountsModel, prefill: StoredAccount? = nil, session: URLSession = .shared,
         browser: WebAuthenticating? = nil) {
        self.accounts = accounts
        self.session = session
        self.browser = browser ?? BrowserLogin()
        serverInput = prefill.map { Self.input(for: $0.serverURL) } ?? ""
        loginHint = prefill?.username
        notice = prefill.map { account in
            let title = "\(account.username)@\(ServerURL.displayHost(account.serverURL))"
            return String(localized: "Sign in again to reconnect \(title).")
        }
    }

    /// Server field text for a stored origin (scheme only when it is not https).
    static func input(for url: URL) -> String {
        let host = ServerURL.displayHost(url)
        return url.scheme == "https" ? host : "\(url.scheme ?? "http")://\(host)"
    }

    /// Starts ``signIn()`` as a task that ``cancel()`` can stop (buttons of the login sheet).
    func start() {
        guard !isBusy else { return }
        task = Task { await signIn() }
    }

    /// Sheet closed or "Cancel": stops the browser login. A login finished in the browser
    /// after this point is not added.
    func cancel() {
        task?.cancel()
        task = nil
    }

    /// Runs the whole flow; errors end up in ``errorMessage``.
    func signIn() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let server = try await checkServer(serverInput)
            let pkce = PKCE.make()
            let auth = AuthAPI(session: session, clientID: Self.clientID)
            let url = auth.authorizeURL(server: server, challenge: pkce.challenge, state: pkce.state, loginHint: loginHint)
            let redirect = try await browser.authenticate(url: url, callbackScheme: AuthAPI.callbackScheme)
            let code: String
            do {
                code = try AuthAPI.code(fromRedirect: redirect, expectedState: pkce.state)
            } catch AuthError.stateMismatch {
                throw LoginError.stateMismatch
            } catch AuthError.denied(let reason) {
                throw LoginError.denied(reason)
            }
            let tokens = try await auth.exchangeCode(server: server, code: code, verifier: pkce.verifier)
            try Task.checkCancellation()
            let stored = try await accounts.add(server: server, tokens: tokens)
            step = .done(title: "\(stored.username)@\(ServerURL.displayHost(stored.serverURL))")
        } catch BrowserLoginError.cancelled {
            // Browser sheet closed by the user: no message.
        } catch is CancellationError {
            // Login sheet closed meanwhile.
        } catch {
            Logger.app.error("sign-in failed: \(String(describing: error), privacy: .public)")
            errorMessage = Self.describe(error)
        }
    }

    /// Normalizes the input and checks that a Synclet server answers there. Returns the origin.
    func checkServer(_ input: String) async throws -> URL {
        let server: URL
        do {
            server = try ServerURL.normalize(input)
        } catch {
            throw LoginError.invalidAddress
        }
        let host = ServerURL.displayHost(server)

        let (healthStatus, healthBody) = try await get(server.appending(path: "api/health"), host: host)
        guard healthStatus == 200,
              (try? JSONSerialization.jsonObject(with: healthBody)) as? [String: Any] != nil else {
            throw LoginError.notSynclet(host: host)
        }

        let (capStatus, capBody) = try await get(server.appending(path: "api/sync/v1/capabilities"), host: host)
        switch capStatus {
        case 200:
            guard (try? JSONSerialization.jsonObject(with: capBody)) as? [String: Any] != nil else {
                throw LoginError.notSynclet(host: host)
            }
        case 404:
            break   // older Synclet without the route
        case 401, 403:
            // The route needs a device token: a Sync API error body proves it is Synclet.
            guard let body = try? JSONDecoder().decode(SyncErrorBody.self, from: capBody), body.code != nil else {
                throw LoginError.notSynclet(host: host)
            }
        default:
            throw LoginError.notSynclet(host: host)
        }
        return server
    }

    private func get(_ url: URL, host: String) async throws -> (Int, Data) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw LoginError.notSynclet(host: host) }
            // A redirect to another origin is not a Synclet server *at this address*.
            guard let final = http.url, Self.sameOrigin(final, url) else { throw LoginError.notSynclet(host: host) }
            return (http.statusCode, data)
        } catch let error as LoginError {
            throw error
        } catch is URLError {
            throw LoginError.unreachable(host: host)
        }
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased()
            && (a.port ?? Self.defaultPort(a)) == (b.port ?? Self.defaultPort(b))
    }

    private static func defaultPort(_ url: URL) -> Int { url.scheme?.lowercased() == "https" ? 443 : 80 }

    static func describe(_ error: Error) -> String {
        if let error = error as? LocalizedError, let text = error.errorDescription { return text }
        return error.localizedDescription
    }
}
