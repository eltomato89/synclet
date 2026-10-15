import CryptoKit
import XCTest
@testable import SyncletKit

final class AuthAPITests: XCTestCase {
    func testPKCEShapes() {
        let pkce = PKCE.make()
        XCTAssertEqual(pkce.verifier.count, 43)
        XCTAssertEqual(pkce.challenge.count, 43)
        XCTAssertFalse(pkce.state.isEmpty)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        XCTAssertTrue(pkce.verifier.unicodeScalars.allSatisfy(allowed.contains))
        XCTAssertFalse(pkce.challenge.contains("="))
        XCTAssertEqual(pkce.challenge, PKCE.challenge(for: pkce.verifier))
        XCTAssertNotEqual(PKCE.make().verifier, pkce.verifier)
        // RFC 7636 appendix B
        XCTAssertEqual(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testAuthorizeURL() throws {
        let url = AuthAPI().authorizeURL(server: URL(string: "https://synclet.dw83.de")!, challenge: "c+1", state: "s1",
                                         loginHint: "jens")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/app-login")
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["client_id"], "macos")
        XCTAssertEqual(query["redirect_uri"], "synclet://oauth")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(query["state"], "s1")
        XCTAssertEqual(query["login_hint"], "jens")
        XCTAssertTrue(url.absoluteString.contains("code_challenge=c%2B1"))
    }

    func testCodeFromRedirectChecksState() throws {
        let redirect = URL(string: "synclet://oauth?code=abc&state=s1")!
        XCTAssertEqual(try AuthAPI.code(fromRedirect: redirect, expectedState: "s1"), "abc")
        XCTAssertThrowsError(try AuthAPI.code(fromRedirect: redirect, expectedState: "other")) {
            XCTAssertEqual($0 as? AuthError, .stateMismatch)
        }
        XCTAssertThrowsError(try AuthAPI.code(fromRedirect: URL(string: "synclet://oauth?state=s1")!, expectedState: "s1")) {
            XCTAssertEqual($0 as? AuthError, .missingCode)
        }
    }

    func testExchangeCode() async throws {
        MockURLProtocol.reset { _ in
            .json(200, #"{"accessToken":"jwt.a.b","refreshToken":"syr_r","user":{"id":"u1","username":"jens","displayName":"Jens","email":null,"role":"user"}}"#)
        }
        let tokens = try await AuthAPI(session: MockURLProtocol.session())
            .exchangeCode(server: URL(string: "http://localhost:8080")!, code: "the-code", verifier: "the-verifier")
        XCTAssertEqual(tokens.accessToken, "jwt.a.b")
        XCTAssertEqual(tokens.user.username, "jens")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.request.url?.absoluteString, "http://localhost:8080/api/auth/app/token")
        XCTAssertNil(request.header("Authorization"))
        XCTAssertEqual(request.header("Content-Type"), "application/json")
        XCTAssertEqual(request.json?["code"] as? String, "the-code")
        XCTAssertEqual(request.json?["codeVerifier"] as? String, "the-verifier")
        XCTAssertEqual(request.json?["clientId"] as? String, "macos")
        XCTAssertEqual(request.json?["redirectUri"] as? String, "synclet://oauth")
    }

    func testExchangeCodeErrors() async {
        MockURLProtocol.reset { _ in .error(400, "invalid_request") }
        await assertThrows(.invalidRequest(message: "invalid_request")) {
            _ = try await AuthAPI(session: MockURLProtocol.session()).exchangeCode(server: Fixtures.server, code: "c", verifier: "v")
        }
        MockURLProtocol.reset { _ in .error(429, "rate_limited", headers: ["Retry-After": "9"]) }
        await assertThrows(.rateLimited(retryAfter: 9)) {
            _ = try await AuthAPI(session: MockURLProtocol.session()).exchangeCode(server: Fixtures.server, code: "c", verifier: "v")
        }
    }

    func testRegisterDevice() async throws {
        MockURLProtocol.reset { _ in .json(201, Fixtures.registrationJSON()) }
        let registration = try await AuthAPI(session: MockURLProtocol.session())
            .registerDevice(server: Fixtures.server, accessToken: "jwt.a.b", name: "Jens' MacBook",
                            platform: .macos, installationId: "inst", appVersion: "0.1.0")
        XCTAssertTrue(registration.token.hasPrefix("syd_"))
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.path, "/api/sync/v1/devices")
        XCTAssertEqual(request.header("Authorization"), "Bearer jwt.a.b")
        XCTAssertEqual(request.json?["name"] as? String, "Jens' MacBook")
        XCTAssertEqual(request.json?["platform"] as? String, "macos")
        XCTAssertEqual(request.json?["appVersion"] as? String, "0.1.0")
        XCTAssertEqual(request.json?["installationId"] as? String, "inst")
    }

    func testDeviceNameIsTruncatedByUTF16Units() {
        let emoji = String(repeating: "👩‍💻", count: 30) // 5 UTF-16 units each
        let truncated = AuthAPI.truncated(emoji, utf16Units: 100)
        XCTAssertEqual(truncated.utf16.count, 100)
        XCTAssertEqual(truncated.count, 20)
        XCTAssertEqual(AuthAPI.truncated("Mac", utf16Units: 100), "Mac")
        XCTAssertEqual(AuthAPI.truncated("ab👩‍💻", utf16Units: 4), "ab")
    }

    func testEndSessionSendsRefreshCookie() async throws {
        MockURLProtocol.reset { _ in .empty(204) }
        await AuthAPI(session: MockURLProtocol.session()).endSession(server: Fixtures.server, refreshToken: "syr_r")
        let request = try XCTUnwrap(MockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/auth/logout")
        XCTAssertEqual(request.header("Cookie"), "synclet_refresh=syr_r")
    }
}
