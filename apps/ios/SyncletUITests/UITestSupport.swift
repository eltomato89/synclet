import XCTest

/// Launch configuration and helpers of the UI tests against a throwaway server
/// (`scripts/ios-live-tests.sh`).
///
/// The script passes the server and a registered device token as `TEST_RUNNER_SYNCLET_UITEST_SERVER`
/// / `TEST_RUNNER_SYNCLET_UITEST_TOKEN`; `xcodebuild` hands them to the test runner without the
/// `TEST_RUNNER_` prefix. They become the DEBUG launch arguments `-SyncletTestServer` /
/// `-SyncletTestToken` of the app (``TestLogin``). Without them the live flows are skipped.
enum UITestSupport {
    struct Live {
        let server: String
        let token: String
    }

    static var live: Live? {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["SYNCLET_UITEST_SERVER"], !server.isEmpty,
              let token = env["SYNCLET_UITEST_TOKEN"], !token.isEmpty else { return nil }
        return Live(server: server, token: token)
    }

    /// The app signed in to the live server, in German (the product terms are asserted).
    @MainActor
    static func launchApp(_ live: Live, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-SyncletTestServer", live.server,
            "-SyncletTestToken", live.token,
            "-AppleLanguages", "(de)",
            "-AppleLocale", "de_DE",
        ] + extraArguments
        app.launch()
        return app
    }

    /// A small text file in the runner's temporary directory (the simulator app reads host paths).
    static func makeTextFile(named name: String, contents: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: "synclet-uitest-\(UUID().uuidString)",
                                                                   directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: name, directoryHint: .notDirectory)
        try Data(contents.utf8).write(to: url)
        return url
    }
}

extension XCUIElement {
    /// Any element with this accessibility identifier.
    @MainActor
    func element(_ identifier: String) -> XCUIElement {
        descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Waits until the element no longer exists.
    @MainActor
    @discardableResult
    func waitForDisappearance(timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: self)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    /// Replaces the text of a text field: cursor to the end (tap right of the text), delete, type.
    @MainActor
    func replaceText(_ text: String) {
        coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let current = (value as? String) ?? ""
        if !current.isEmpty {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        typeText(text)
    }
}

extension XCTestCase {
    /// Fails (with the app's hierarchy attached) unless `element` appears within `timeout`.
    @MainActor
    func require(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 15,
                 in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        guard element.waitForExistence(timeout: timeout) else {
            let attachment = XCTAttachment(string: app.debugDescription)
            attachment.name = "hierarchy (\(what))"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("\(what) did not appear", file: file, line: line)
            return
        }
    }

    /// Opens the context menu of `element` and taps the action with `identifier`.
    @MainActor
    func contextAction(_ identifier: String, on element: XCUIElement, in app: XCUIApplication,
                       file: StaticString = #filePath, line: UInt = #line) {
        element.press(forDuration: 1.2)
        let button = app.buttons[identifier]
        require(button, "context action \(identifier)", timeout: 5, in: app, file: file, line: line)
        button.tap()
    }
}
