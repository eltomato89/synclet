import AuthenticationServices
import Foundation
import UIKit

/// Opens a login page and returns the redirect URL (replaceable in tests).
@MainActor
protocol WebAuthenticating {
    /// - Throws: ``BrowserLoginError/cancelled`` when the user closes the window.
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

enum BrowserLoginError: Error, Equatable, LocalizedError {
    case cancelled
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .cancelled: return nil
        case .failed(let message): return message
        }
    }
}

/// Browser login (OAuth 2.0 authorization code + PKCE, RFC 8252) with
/// `ASWebAuthenticationSession`: the app opens `<server>/app-login`, the user signs in
/// there (password, SSO …) and comes back through `synclet://oauth?code=…&state=…`.
/// The password is never entered in the app.
@MainActor
final class BrowserLogin: NSObject, WebAuthenticating, ASWebAuthenticationPresentationContextProviding {
    /// The running session (kept alive until it completes).
    private var session: ASWebAuthenticationSession?
    /// Window the browser sheet is presented on (found when the login starts).
    private var anchor: ASPresentationAnchor?

    /// Cancelling the calling task cancels the session (closes the browser sheet).
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        session?.cancel()
        guard let anchor = Self.currentWindow() else {
            throw BrowserLoginError.failed(String(localized: "The login window could not be opened."))
        }
        self.anchor = anchor
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme),
                                                         completionHandler: Self.completionHandler { result in
                    Task { @MainActor [weak self] in
                        self?.session = nil
                        continuation.resume(with: result)
                    }
                })
                session.presentationContextProvider = self
                // Share the browser's cookies: an existing web or SSO session signs in without a password.
                session.prefersEphemeralWebBrowserSession = false
                self.session = session
                if !session.start() {
                    self.session = nil
                    continuation.resume(throwing: BrowserLoginError.failed(String(localized: "The login window could not be opened.")))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.session?.cancel() }
        }
    }

    /// The session's completion handler. It runs on an undocumented queue (not the main thread),
    /// so it must not be main-actor isolated – Swift 6 would trap on the isolation check. It only
    /// builds a Sendable result and hands it to `deliver`, which hops to the main actor itself.
    nonisolated static func completionHandler(
        _ deliver: @escaping @Sendable (Result<URL, BrowserLoginError>) -> Void
    ) -> @Sendable (URL?, Error?) -> Void {
        { @Sendable callback, error in
            if let callback {
                deliver(.success(callback))
            } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                deliver(.failure(.cancelled))
            } else {
                deliver(.failure(.failed(error?.localizedDescription
                    ?? String(localized: "The login window could not be opened."))))
            }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            // `anchor` is set before the session starts.
            anchor ?? Self.currentWindow()!
        }
    }

    /// The key window of the frontmost scene.
    private static func currentWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let ordered = scenes.filter { $0.activationState == .foregroundActive } + scenes
        return ordered.lazy.compactMap { $0.keyWindow ?? $0.windows.first }.first
    }
}
