import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class LoginModelTests: XCTestCase {
    private var harness: Harness!

    override func setUp() async throws {
        harness = Harness()
    }

    override func tearDown() async throws {
        harness.cleanUp()
    }

    private func makeModel(_ input: String, browser: FakeBrowser) -> LoginModel {
        let model = LoginModel(accounts: harness.accounts, session: MockURLProtocol.session(), browser: browser)
        model.serverInput = input
        return model
    }

    func testNonSyncletServerIsRejectedBeforeTheBrowser() async {
        // A web server that answers everything with HTML.
        MockURLProtocol.reset { _ in .html(200) }
        let browser = FakeBrowser(redirect: FakeBrowser.echo)
        let model = makeModel("www.example.test", browser: browser)
        await model.signIn()
        XCTAssertEqual(model.errorMessage, LoginError.notSynclet(host: "www.example.test").errorDescription)
        XCTAssertEqual(model.errorMessage, String(localized: "No Synclet server at \("www.example.test")"))
        XCTAssertTrue(browser.openedURLs.isEmpty)
        XCTAssertEqual(model.step, .server)
        XCTAssertFalse(model.isBusy)
    }

    func testHealthWithoutSyncAPIIsRejected() async {
        // Health is JSON, but the capabilities route is an HTML 500 ⇒ not Synclet.
        MockURLProtocol.reset { request in
            request.path == "/api/health" ? .json(200, #"{"ok":true}"#) : .html(500)
        }
        let browser = FakeBrowser(redirect: FakeBrowser.echo)
        let model = makeModel("https://files.example.test", browser: browser)
        await model.signIn()
        XCTAssertEqual(model.errorMessage, LoginError.notSynclet(host: "files.example.test").errorDescription)
        XCTAssertTrue(browser.openedURLs.isEmpty)
    }

    func testOlderSyncletWithoutCapabilitiesIsAccepted() async throws {
        MockURLProtocol.reset { request in
            request.path == "/api/health" ? .json(200, #"{"ok":true}"#) : .json(404, #"{"statusCode":404,"message":"Not Found"}"#)
        }
        let model = makeModel("files.example.test", browser: FakeBrowser(redirect: FakeBrowser.echo))
        let server = try await model.checkServer("files.example.test")
        XCTAssertEqual(server.absoluteString, "https://files.example.test")
    }

    func testInvalidAddressAndUnreachableServer() async {
        MockURLProtocol.reset { _ in .html(200) }
        let model = makeModel("ftp://x", browser: FakeBrowser(redirect: FakeBrowser.echo))
        await model.signIn()
        XCTAssertEqual(model.errorMessage, LoginError.invalidAddress.errorDescription)

        let session = URLSession(configuration: .ephemeral)
        let offline = LoginModel(accounts: harness.accounts, session: session, browser: FakeBrowser(redirect: FakeBrowser.echo))
        offline.serverInput = "http://127.0.0.1:1"
        await offline.signIn()
        XCTAssertEqual(offline.errorMessage, LoginError.unreachable(host: "127.0.0.1:1").errorDescription)
    }

    func testStateMismatchExchangesNothing() async {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let browser = FakeBrowser { _ in URL(string: "synclet://oauth?code=c0de&state=forged")! }
        let model = makeModel("files.example.test", browser: browser)
        await model.signIn()
        XCTAssertEqual(model.errorMessage, LoginError.stateMismatch.errorDescription)
        XCTAssertEqual(browser.openedURLs.count, 1)
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/auth/app/token" })
        XCTAssertFalse(MockURLProtocol.requests.contains { $0.path == "/api/sync/v1/devices" })
        XCTAssertTrue(harness.accounts.isEmpty)
    }

    func testCancelledBrowserShowsNoError() async {
        Harness.serve(["files.example.test": FakeSynclet(serverId: "srv1")])
        let model = makeModel("files.example.test", browser: FakeBrowser { _ in throw BrowserLoginError.cancelled })
        await model.signIn()
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.step, .server)
    }

    func testSuccessfulLoginUpsertsTheAccount() async throws {
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["localhost": server])
        let browser = FakeBrowser(redirect: FakeBrowser.echo)
        let model = makeModel("http://localhost:18140", browser: browser)
        await model.signIn()

        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.step, .done(title: "jens@localhost:18140"))

        // Browser opened at /app-login with the exact OAuth parameters.
        let opened = try XCTUnwrap(browser.openedURLs.first)
        XCTAssertEqual(opened.scheme, "http")
        XCTAssertEqual(opened.host(), "localhost")
        XCTAssertEqual(opened.port, 18140)
        XCTAssertEqual(opened.path(), "/app-login")
        let query = FakeBrowser.query(opened)
        XCTAssertEqual(query["client_id"], "macos")
        XCTAssertEqual(query["redirect_uri"], "synclet://oauth")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(query["code_challenge"]?.count, 43)
        XCTAssertFalse(query["state"]?.isEmpty ?? true)

        // Code exchanged with the verifier that belongs to the challenge.
        let exchange = try XCTUnwrap(MockURLProtocol.requests.first { $0.path == "/api/auth/app/token" }?.json)
        XCTAssertEqual(exchange["code"] as? String, "c0de")
        XCTAssertEqual(exchange["clientId"] as? String, "macos")
        XCTAssertEqual(exchange["redirectUri"] as? String, "synclet://oauth")
        let verifier = try XCTUnwrap(exchange["codeVerifier"] as? String)
        XCTAssertEqual(PKCE.challenge(for: verifier), query["code_challenge"])

        // Account stored, token saved, one domain added.
        XCTAssertEqual(harness.accounts.entries.map(\.id), ["srv1:u1"])
        XCTAssertEqual(harness.accounts.entries.first?.status, .ok)
        XCTAssertEqual(harness.manager.credentials.token(for: "srv1:u1"), "syd_srv1_1")
        XCTAssertEqual(harness.domains.addCalls.map(\.displayName), ["Synclet – jens@localhost:18140"])
        XCTAssertEqual(harness.domains.addCalls.map(\.identifier), [AccountStore.key16(for: "srv1:u1")])
    }

    func testPrefillForSigningInAgain() {
        let account = StoredAccount(key: "srv1:u1", serverURL: URL(string: "http://localhost:18140")!, userId: "u1",
                                    username: "jens", displayName: "Jens", spaces: [.personal()])
        let model = LoginModel(accounts: harness.accounts, prefill: account, session: MockURLProtocol.session(),
                               browser: FakeBrowser(redirect: FakeBrowser.echo))
        XCTAssertEqual(model.serverInput, "http://localhost:18140")
        XCTAssertNotNil(model.notice)
        XCTAssertEqual(LoginModel.input(for: URL(string: "https://files.example.test")!), "files.example.test")
    }
}
