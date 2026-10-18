import XCTest

/// The iPhone half of the website's hero animation (`apps/site/scripts/hero-motion.ts`): sample
/// data on a throwaway server, English UI, grid layout. Opens „Photos“, scrolls through it and
/// previews a photo. Hand-shake with the script through files in `SYNCLET_UITEST_HERO_DIR` (the
/// simulator shares the host's file system): `ready` → the script starts recording and writes `go`
/// → the scene → `end` → the script stops recording. Skipped unless that variable is set.
final class HeroFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testHeroFlow() throws {
        guard let live = UITestSupport.live, let dirPath = ProcessInfo.processInfo.environment["SYNCLET_UITEST_HERO_DIR"], !dirPath.isEmpty else {
            throw XCTSkip("only for apps/site/scripts/hero-motion.ts")
        }
        let app = UITestSupport.launchApp(live, language: "en", extraArguments: ["-browserLayout", "grid"])

        // The „Files“ tab lists the spaces (the sample server has a team folder): open My Files.
        let myFiles = app.navigationBars["My Files"]
        let spaceRow = app.element("spaces.My Files")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !myFiles.exists, !spaceRow.exists { _ = myFiles.waitForExistence(timeout: 1) }
        if !myFiles.exists, spaceRow.exists { spaceRow.tap() }
        XCTAssertTrue(myFiles.waitForExistence(timeout: 10), "My Files")
        let photos = app.element("browser.item.Photos")
        XCTAssertTrue(photos.waitForExistence(timeout: 20), "folder Photos")
        Thread.sleep(forTimeInterval: 2.5) // thumbnails of the folder mosaics
        let window = app.windows.firstMatch
        let photosCenter = photos.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))

        // Rehearsal: the same gestures once, so the photo is downloaded and the preview opens at once.
        scene(photosCenter, window)
        let done = app.navigationBars.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "QuickLook")
        Thread.sleep(forTimeInterval: 3)
        done.tap()
        app.navigationBars["Photos"].buttons.firstMatch.tap() // back to My Files
        XCTAssertTrue(photos.waitForExistence(timeout: 10), "back in My Files")
        Thread.sleep(forTimeInterval: 1.5)

        // The recorded take.
        let dir = URL(filePath: dirPath, directoryHint: .isDirectory)
        try Data().write(to: dir.appending(path: "ready"))
        let go = dir.appending(path: "go").path()
        let deadline2 = Date().addingTimeInterval(60)
        while !FileManager.default.fileExists(atPath: go), Date() < deadline2 { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: go), "the script started recording")
        Thread.sleep(forTimeInterval: 0.5)
        scene(photosCenter, window)
        Thread.sleep(forTimeInterval: 6) // QuickLook draws the photo; the script cuts the still stretches
        try Data().write(to: dir.appending(path: "end"))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(done.exists, "QuickLook is showing")
    }

    /// Open „Photos“, scroll calmly, preview the photo in the middle. Coordinate gestures only: element
    /// queries in between would wait for the app to idle.
    private func scene(_ photosCenter: XCUICoordinate, _ window: XCUIElement) {
        photosCenter.tap()
        Thread.sleep(forTimeInterval: 0.7)
        let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
        let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42))
        from.press(forDuration: 0.02, thenDragTo: to, withVelocity: 600, thenHoldForDuration: 0.05)
        Thread.sleep(forTimeInterval: 0.2)
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
}
