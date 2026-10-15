import AppKit
import AuthenticationServices
import Foundation

/// Opens a login page and returns the redirect URL (replaceable in tests).
@MainActor
protocol WebAuthenticating {
    /// - Throws: ``BrowserLoginError/cancelled`` when the user closes the window.
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

enum BrowserLoginError: Error, Equatable {
    case cancelled
    case failed(String)
}

/// Browser login (OAuth 2.0 authorization code + PKCE, RFC 8252) with
/// `ASWebAuthenticationSession`: the app opens `<server>/app-login`, the user signs in
/// there (password, SSO …) and comes back through `synclet://oauth?code=…&state=…`.
/// The password is never entered in the app.
@MainActor
final class BrowserLogin: NSObject, WebAuthenticating, ASWebAuthenticationPresentationContextProviding {
    /// The running session (kept alive until it completes).
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        session?.cancel()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme)) { [weak self] callback, error in
                MainActor.assumeIsolated {
                    self?.session = nil
                    if let callback {
                        continuation.resume(returning: callback)
                    } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        continuation.resume(throwing: BrowserLoginError.cancelled)
                    } else {
                        continuation.resume(throwing: BrowserLoginError.failed(error?.localizedDescription ?? "unknown"))
                    }
                }
            }
            session.presentationContextProvider = self
            // Share the browser's cookies: an existing web or SSO session signs in without a password.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: BrowserLoginError.failed(String(localized: "The login window could not be opened.")))
            }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor()
        }
    }
}
