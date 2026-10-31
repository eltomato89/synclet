import XCTest

/// Upload on a physical device with the account already signed in there (no test login): a random
/// file of `SYNCLET_DEVICE_UPLOAD_SIZE` bytes (`TEST_RUNNER_SYNCLET_DEVICE_UPLOAD_SIZE`; DEBUG hook
/// `-SyncletTestUploadSize`) goes into "My Files" and must show up there. Skipped without that variable.
final class DeviceUploadUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testUploadIntoMyFiles() throws {
        guard let size = ProcessInfo.processInfo.environment["SYNCLET_DEVICE_UPLOAD_SIZE"].flatMap(Int.init) else {
            throw XCTSkip("SYNCLET_DEVICE_UPLOAD_SIZE not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-SyncletTestUploadSize", String(size)]
        app.launch()

        let myFiles = app.navigationBars["My Files"]
        let spaceRow = app.element("spaces.My Files")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !myFiles.exists, !spaceRow.exists {
            _ = myFiles.waitForExistence(timeout: 1)
        }
        if !myFiles.exists, spaceRow.exists { spaceRow.tap() }
        require(myFiles, "My Files", timeout: 10, in: app)

        app.buttons["browser.addMenu"].tap()
        let files = app.buttons["upload.files"]
        require(files, "Files in the + menu", timeout: 5, in: app)
        files.tap()
        require(app.element("browser.item.uitest-\(size).bin"), "uploaded file row", timeout: 180, in: app)
    }
}
