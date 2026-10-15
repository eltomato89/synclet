import CryptoKit
import Foundation
import Security

/// PKCE values for the browser login (SYNC_API.md §2.1, RFC 7636 S256).
public enum PKCE {
    /// `verifier`: 43 characters of base64url; `challenge`: `BASE64URL(SHA256(verifier))`
    /// without padding (43 characters); `state`: random, checked on the redirect.
    public static func make() -> (verifier: String, challenge: String, state: String) {
        let verifier = base64URL(randomBytes(32))
        return (verifier, challenge(for: verifier), base64URL(randomBytes(16)))
    }

    /// `BASE64URL(SHA256(verifier))` without padding.
    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) != errSecSuccess {
            var generator = SystemRandomNumberGenerator()
            bytes = (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        }
        return Data(bytes)
    }
}

/// The app-login routes (`/api/auth/app/*`) and the device registration.
///
/// The app never sees the password: it opens ``authorizeURL(server:challenge:state:loginHint:)``
/// in `ASWebAuthenticationSession`, checks `state` on the `synclet://oauth` redirect and
/// exchanges the code here.
public struct AuthAPI: Sendable {
    /// OAuth client of the macOS app.
    public static let clientID = "macos"
    /// Redirect URI registered for `macos`/`ios`/`android`.
    public static let redirectURI = "synclet://oauth"
    /// URL scheme of the redirect (for `ASWebAuthenticationSession`).
    public static let callbackScheme = "synclet"

    public let clientID: String
    public let redirectURI: String
    private let session: URLSession

    public init(session: URLSession = .shared, clientID: String = AuthAPI.clientID,
                redirectURI: String = AuthAPI.redirectURI) {
        self.session = session
        self.clientID = clientID
        self.redirectURI = redirectURI
    }

    /// `<server>/app-login?client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…`.
    public func authorizeURL(server: URL, challenge: String, state: String, loginHint: String? = nil) -> URL {
        var components = URLComponents(url: server, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = "/app-login"
        components.fragment = nil
        var items = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        if let loginHint, !loginHint.isEmpty { items.append(URLQueryItem(name: "login_hint", value: loginHint)) }
        components.queryItems = items
        // `+` is literal in query items; encode it so the server does not read a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url ?? server
    }

    /// Reads `code` from the redirect after checking `state`.
    /// - Throws: ``AuthError/stateMismatch`` or ``AuthError/missingCode``.
    public static func code(fromRedirect url: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == expectedState else { throw AuthError.stateMismatch }
        if let error = value("error") { throw AuthError.denied(error) }
        guard let code = value("code"), !code.isEmpty else { throw AuthError.missingCode }
        return code
    }

    /// `POST /api/auth/app/token` `{ code, codeVerifier, clientId, redirectUri }` → tokens.
    public func exchangeCode(server: URL, code: String, verifier: String) async throws -> AppTokens {
        struct Body: Encodable { let code: String; let codeVerifier: String; let clientId: String; let redirectUri: String }
        let client = SyncAPIClient(baseURL: server, token: "", session: session)
        return try await post(client, ["auth", "app", "token"],
                              body: Body(code: code, codeVerifier: verifier, clientId: clientID, redirectUri: redirectURI))
    }

    /// `POST /api/sync/v1/devices` with the access token → device token `syd_…` + account.
    public func registerDevice(server: URL, accessToken: String, name: String,
                               platform: SyncPlatform = .current, installationId: String?,
                               appVersion: String = SyncletKitInfo.appVersion) async throws -> DeviceRegistration {
        let client = SyncAPIClient(baseURL: server, token: accessToken, session: session)
        return try await client.registerDevice(name: Self.truncated(name, utf16Units: 100), platform: platform,
                                               appVersion: Self.truncated(appVersion, utf16Units: 40),
                                               installationId: installationId)
    }

    /// Longest prefix of whole characters within `utf16Units` UTF-16 code units (the
    /// server counts JavaScript string length).
    static func truncated(_ text: String, utf16Units: Int) -> String {
        var result = ""
        var count = 0
        for character in text {
            let length = character.utf16.count
            if count + length > utf16Units { break }
            result.append(character)
            count += length
        }
        return result
    }

    /// `POST /api/auth/logout` with the refresh token as cookie – ends the login session the
    /// app does not need after the device registration (§2.1 step 5). Best effort.
    public func endSession(server: URL, refreshToken: String) async {
        let client = SyncAPIClient(baseURL: server, token: "", session: session)
        guard var request = try? await client.makeRequest(.post, ["auth", "logout"]) else { return }
        request.setValue("synclet_refresh=\(refreshToken)", forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 5
        _ = try? await session.data(for: request)
    }

    private func post<T: Decodable>(_ client: SyncAPIClient, _ segments: [String], body: some Encodable) async throws -> T {
        var request = try await client.makeRequest(.post, segments)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw SyncAPIError.transport(error.code, message: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw SyncAPIError.invalidResponse("Not an HTTP response") }
        guard (200...299).contains(http.statusCode) else { throw SyncAPIClient.error(http, data: data) }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SyncAPIError.invalidResponse(String(describing: error))
        }
    }
}

/// Errors of the browser login.
public enum AuthError: Error, Sendable, Equatable {
    /// `state` of the redirect differs – possible forgery; nothing is exchanged.
    case stateMismatch
    /// Redirect without `code`.
    case missingCode
    /// Redirect with `error=…`.
    case denied(String)
}

/// Static facts about the kit.
public enum SyncletKitInfo {
    /// `CFBundleShortVersionString` of the main bundle, else the marketing version.
    public static var appVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
            .flatMap { $0.isEmpty ? nil : $0 } ?? "0.1.0"
    }
}
