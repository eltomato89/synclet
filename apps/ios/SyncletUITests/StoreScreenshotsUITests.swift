import XCTest

/// App Store screenshots with the website's sample data (`scripts/ios-store-screenshots.sh`): one
/// PNG per scene into `SYNCLET_UITEST_SHOTS_DIR` (the simulator shares the host's file system), in
/// the language `SYNCLET_UITEST_LANGUAGE` (default `en`), grid layout. Works in the iPhone (tab bar)
/// and the iPad layout (sidebar). Skipped unless the shots folder is set.
final class StoreScreenshotsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testStoreScreenshots() throws {
        let env = ProcessInfo.processInfo.environment
        guard let live = UITestSupport.live, let dirPath = env["SYNCLET_UITEST_SHOTS_DIR"], !dirPath.isEmpty else {
            throw XCTSkip("only for scripts/ios-store-screenshots.sh")
        }
        let dir = URL(filePath: dirPath, directoryHint: .isDirectory)
        let language = env["SYNCLET_UITEST_LANGUAGE"].flatMap { $0.isEmpty ? nil : $0 } ?? "en"
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        // The iPad in landscape: sidebar and a wide grid (2752 × 2064).
        if pad { XCUIDevice.shared.orientation = .landscapeLeft }
        func launch() -> XCUIApplication {
            UITestSupport.launchApp(live, language: language, extraArguments: ["-browserLayout", "grid", "-SyncletTestDisplayHost", "files.example.com"])
        }
        func shot(_ name: String, settle: TimeInterval = 2.5) throws {
            Thread.sleep(forTimeInterval: settle) // thumbnails, animations
            // Redrawn: the screenshot of a rotated device carries only an orientation tag, App Store
            // Connect wants the pixels upright. Opaque, at the screen's scale (no alpha channel).
            let image = XCUIScreen.main.screenshot().image
            let format = UIGraphicsImageRendererFormat()
            format.scale = image.scale
            format.opaque = true
            let png = UIGraphicsImageRenderer(size: image.size, format: format).pngData { _ in image.draw(at: .zero) }
            try png.write(to: dir.appending(path: "\(name).png"))
        }

        // 1. My Files
        var app = launch()
        openMyFiles(in: app, pad: pad)
        require(app.element("browser.item.Photos"), "folder Photos", timeout: 20, in: app)
        try shot("01-files", settle: 4)

        // 2. Photos
        app.element("browser.item.Photos").tap()
        require(app.element("browser.item.Fjord morning.jpg"), "Photos opened", timeout: 20, in: app)
        try shot("02-photos", settle: 4)

        // 3. Preview of a photo (QuickLook)
        app.element("browser.item.Fjord morning.jpg").tap()
        require(app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "Fertig"])).firstMatch,
                "QuickLook", timeout: 30, in: app)
        try shot("03-preview", settle: 8) // QuickLook draws the photo late

        // 4. The team folder „Family“ (iPad: from the sidebar; iPhone: from the list of spaces)
        app = launch()
        let family = app.element(pad ? "sidebar.space.Family.alex" : "spaces.Family")
        require(family, "team folder Family", timeout: 30, in: app)
        family.tap()
        require(app.element("browser.item.Holidays 2026"), "Family opened", timeout: 20, in: app)
        try shot("04-spaces", settle: 3)

        // 5. Search (names and contents: the photo and the itinerary PDF)
        if pad {
            app.element("sidebar.search.alex").tap()
        } else {
            app.tabBars.buttons.element(boundBy: 2).tap()
        }
        let searchField = app.searchFields.firstMatch
        require(searchField, "search field", in: app)
        searchField.tap()
        searchField.typeText("fjord\n") // return hides the keyboard
        require(app.element("search.hit.Fjord morning.jpg"), "search hits", timeout: 45, in: app)
        try shot("05-search", settle: 3)

        // 6. Share link for a document
        app = launch()
        openMyFiles(in: app, pad: pad)
        let itinerary = app.element("browser.item.Itinerary.pdf")
        require(itinerary, "Itinerary.pdf", timeout: 20, in: app)
        contextAction("item.share", on: itinerary, in: app)
        require(app.buttons["share.submit"], "„Share Link“ sheet", timeout: 15, in: app)
        try shot("06-share", settle: 2)
    }

    /// „My Files“: on the iPad selected in the sidebar at launch; on the iPhone through the list of
    /// spaces (the sample server has a team folder).
    @MainActor
    private func openMyFiles(in app: XCUIApplication, pad: Bool) {
        if pad {
            let row = app.element("sidebar.files.alex")
            require(row, "sidebar My Files", timeout: 60, in: app) // a fresh simulator starts slowly
            row.tap()
            return
        }
        let photos = app.element("browser.item.Photos")
        let spaceRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier IN %@", ["spaces.My Files", "spaces.Meine Dateien"])).firstMatch
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !photos.exists, !spaceRow.exists { _ = photos.waitForExistence(timeout: 1) }
        if !photos.exists, spaceRow.exists { spaceRow.tap() }
    }
}
