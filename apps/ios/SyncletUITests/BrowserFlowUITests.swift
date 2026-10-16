import XCTest

/// One browser flow against a throwaway server (`scripts/ios-live-tests.sh`, iPhone layout):
/// folder, name conflict, upload, QuickLook, rename, delete, trash, search, share link.
/// Skipped without the live server environment (see ``UITestSupport``).
final class BrowserFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBrowserFlow() throws {
        guard let live = UITestSupport.live else {
            throw XCTSkip("SYNCLET_UITEST_SERVER / SYNCLET_UITEST_TOKEN not set (scripts/ios-live-tests.sh)")
        }
        let fileName = "uitest.txt"
        let upload = try UITestSupport.makeTextFile(named: fileName,
                                                    contents: "Synclet UI test \(UUID().uuidString)\n")
        defer { try? FileManager.default.removeItem(at: upload.deletingLastPathComponent()) }
        let app = UITestSupport.launchApp(live, extraArguments: ["-SyncletTestUpload", upload.path])

        // 1. „Meine Dateien“
        require(app.navigationBars["Meine Dateien"], "„Meine Dateien“", timeout: 30, in: app)

        // 2. New folder „UITest“
        createFolder("UITest", in: app)
        require(app.element("browser.item.UITest"), "folder UITest", in: app)

        // (a) The same name again: inline „Name bereits vergeben“, the sheet stays open.
        openNameSheetForNewFolder(in: app)
        app.textFields["name.field"].typeText("UITest")
        app.buttons["name.confirm"].tap()
        let nameError = app.staticTexts["name.error"]
        require(nameError, "inline name error", timeout: 10, in: app)
        XCTAssertEqual(nameError.label, "Name bereits vergeben")
        XCTAssertTrue(app.textFields["name.field"].exists, "the name sheet stays open")
        app.navigationBars.buttons["Abbrechen"].tap()
        XCTAssertTrue(app.textFields["name.field"].waitForDisappearance(timeout: 5))

        // 3. Open it
        app.element("browser.item.UITest").tap()
        require(app.navigationBars["UITest"], "folder UITest opened", in: app)

        // 4. Upload a file („Dateien“ → DEBUG hook -SyncletTestUpload) and 5. wait for its row
        app.buttons["browser.addMenu"].tap()
        let files = app.buttons["upload.files"]
        require(files, "„Dateien“ in the + menu", timeout: 5, in: app)
        files.tap()
        let fileRow = app.element("browser.item.\(fileName)")
        require(fileRow, "uploaded file row", timeout: 60, in: app)

        // (c) QuickLook opens and can be dismissed with „Fertig“.
        fileRow.tap()
        let quickLookDone = app.navigationBars.buttons["Fertig"]
        require(quickLookDone, "QuickLook „Fertig“", timeout: 30, in: app)
        quickLookDone.tap()
        XCTAssertTrue(quickLookDone.waitForDisappearance(timeout: 10), "QuickLook dismissed")
        require(app.navigationBars["UITest"], "back in the folder", timeout: 5, in: app)

        // 6. Rename to „renamed.txt“
        contextAction("item.rename", on: fileRow, in: app)
        let nameField = app.textFields["name.field"]
        require(nameField, "rename sheet", timeout: 5, in: app)
        nameField.replaceText("renamed.txt")
        app.buttons["name.confirm"].tap()
        let renamedRow = app.element("browser.item.renamed.txt")
        require(renamedRow, "renamed row", in: app)
        XCTAssertTrue(fileRow.waitForDisappearance(timeout: 5), "old name gone")

        // 7. Delete (confirmed)
        contextAction("item.delete", on: renamedRow, in: app)
        // The dialog exposes its action twice (sheet and its accessibility container).
        let confirm = app.buttons.matching(identifier: "item.confirmDelete").firstMatch
        require(confirm, "delete confirmation", timeout: 5, in: app)
        confirm.tap()
        XCTAssertTrue(renamedRow.waitForDisappearance(timeout: 15), "deleted item leaves the folder")

        // 8. „Papierkorb“ → restore
        app.tabBars.buttons["Mehr"].tap()
        let trash = app.element("more.trash")
        require(trash, "„Papierkorb“ in „Mehr“", timeout: 5, in: app)
        trash.tap()
        require(app.navigationBars["Papierkorb"], "„Papierkorb“", in: app)
        let trashRow = app.element("trash.item.renamed.txt")
        require(trashRow, "trash entry", in: app)
        contextAction("trash.restore.renamed.txt", on: trashRow, in: app)
        XCTAssertTrue(trashRow.waitForDisappearance(timeout: 15), "restored item leaves the trash")

        // 9. „Suche“ for „renamed“ → hit (the search index may lag a little)
        app.tabBars.buttons["Suche"].tap()
        let searchField = app.searchFields.firstMatch
        require(searchField, "search field", in: app)
        searchField.tap()
        searchField.typeText("renamed")
        let hit = app.element("search.hit.renamed.txt")
        require(hit, "search hit", timeout: 45, in: app)

        // 10. „Link teilen“ → link created, share sheet with an http(s)://…/s/… URL
        contextAction("item.share", on: hit, in: app)
        let submit = app.buttons["share.submit"]
        require(submit, "„Link teilen“ sheet", timeout: 15, in: app)
        submit.tap()
        let sheet = app.element("share.sheet")
        require(sheet, "share sheet", timeout: 15, in: app)
        let url = sheet.label
        XCTAssertNotNil(url.range(of: #"^https?://[^/]+(/.*)?/s/[^/]+"#, options: .regularExpression),
                        "share URL: \(url)")
        print("UITEST: share URL \(url)")
    }

    // MARK: - Steps

    @MainActor
    private func openNameSheetForNewFolder(in app: XCUIApplication) {
        let add = app.buttons["browser.addMenu"]
        require(add, "+ menu", in: app)
        add.tap()
        let newFolder = app.buttons["browser.newFolder"]
        require(newFolder, "„Neuer Ordner“", timeout: 5, in: app)
        newFolder.tap()
        require(app.textFields["name.field"], "name sheet", timeout: 5, in: app)
    }

    @MainActor
    private func createFolder(_ name: String, in app: XCUIApplication) {
        openNameSheetForNewFolder(in: app)
        app.textFields["name.field"].typeText(name)
        app.buttons["name.confirm"].tap()
        XCTAssertTrue(app.textFields["name.field"].waitForDisappearance(timeout: 10), "name sheet closes")
    }
}
