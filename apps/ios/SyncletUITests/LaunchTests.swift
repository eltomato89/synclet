import XCTest

/// Smoke test: a fresh install shows the empty state. Task 10 adds the flows against a
/// throwaway server (`scripts/ios-live-tests.sh`).
final class LaunchTests: XCTestCase {
    @MainActor
    func testEmptyStateOffersAddingAnAccount() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["root.addAccount"].waitForExistence(timeout: 10))
    }
}
