import AuthenticationServices
import XCTest
@testable import Synclet

/// `ASWebAuthenticationSession` calls its completion handler on an XPC queue, not on the main
/// thread. The handler must therefore not be main-actor isolated (Swift 6 would trap): this file
/// only compiles when `completionHandler` is nonisolated and returns a `@Sendable` handler.
final class BrowserLoginTests: XCTestCase {
    private func deliver(_ callback: URL?, _ error: Error?) async -> Result<URL, BrowserLoginError> {
        await withCheckedContinuation { (done: CheckedContinuation<Result<URL, BrowserLoginError>, Never>) in
            let handler = BrowserLogin.completionHandler { done.resume(returning: $0) }
            DispatchQueue.global().async { handler(callback, error) }
        }
    }

    func testCallbackFromABackgroundQueueSucceeds() async {
        let url = URL(string: "synclet://oauth?code=c&state=s")!
        let result = await deliver(url, nil)
        XCTAssertEqual(try? result.get(), url)
    }

    func testCancelFromABackgroundQueueIsCancelled() async {
        let error = ASWebAuthenticationSessionError(.canceledLogin)
        let result = await deliver(nil, error)
        guard case .failure(.cancelled) = result else { return XCTFail("expected .cancelled, got \(result)") }
    }

    func testOtherErrorsFail() async {
        let result = await deliver(nil, URLError(.notConnectedToInternet))
        guard case .failure(.failed) = result else { return XCTFail("expected .failed, got \(result)") }
    }
}
