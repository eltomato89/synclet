import FileProvider
import UniformTypeIdentifiers
import XCTest
@testable import SyncletKit

final class ConflictNamingTests: XCTestCase {
    let utc = TimeZone(identifier: "UTC")!
    let date = Date(timeIntervalSince1970: 1_791_031_815) // 2026-10-03 12:50:15 UTC

    func testNameWithExtension() {
        XCTAssertEqual(ConflictNaming.name(original: "Angebot 2026.docx", device: "Jens' MacBook", date: date, timeZone: utc),
                       "Angebot 2026 (Konflikt Jens' MacBook 2026-10-03 12-50).docx")
    }

    func testNameWithoutExtension() {
        XCTAssertEqual(ConflictNaming.name(original: "README", device: "Mac", date: date, timeZone: utc),
                       "README (Konflikt Mac 2026-10-03 12-50)")
    }

    func testDotfileHasNoExtension() {
        XCTAssertEqual(ConflictNaming.name(original: ".profile", device: "Mac", date: date, timeZone: utc),
                       ".profile (Konflikt Mac 2026-10-03 12-50)")
        XCTAssertEqual(ConflictNaming.name(original: ".env.local", device: "Mac", date: date, timeZone: utc),
                       ".env (Konflikt Mac 2026-10-03 12-50).local")
    }

    func testMultipleDotsSplitAtLastDot() {
        XCTAssertEqual(ConflictNaming.name(original: "Archiv.tar.gz", device: "Mac", date: date, timeZone: utc),
                       "Archiv.tar (Konflikt Mac 2026-10-03 12-50).gz")
        let trailingDot = ConflictNaming.split("Name.")
        XCTAssertEqual(trailingDot.base, "Name.")
        XCTAssertNil(trailingDot.ext)
    }

    func testDeviceNameIsSanitized() {
        XCTAssertEqual(ConflictNaming.sanitizedDeviceName(" A/B\\C:D "), "A-B-C-D")
        XCTAssertEqual(ConflictNaming.sanitizedDeviceName("  "), "Mac")
    }

    func testTimestampUsesTimeZone() {
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        XCTAssertEqual(ConflictNaming.timestamp(date, timeZone: berlin), "2026-10-03 14-50")
    }
}

final class ItemMappingTests: XCTestCase {
    let layout = Fixtures.layout

    func testIdentifierMapping() {
        XCTAssertEqual(ItemMapping.identifier(forServerID: "root", layout: layout).rawValue, "space:personal")
        XCTAssertEqual(ItemMapping.identifier(forServerID: "f_1", layout: layout).rawValue, "f_1")
        XCTAssertEqual(ItemMapping.serverID(for: NSFileProviderItemIdentifier("space:personal"), layout: layout), "root")
        XCTAssertNil(ItemMapping.serverID(for: .rootContainer, layout: layout))
        XCTAssertNil(ItemMapping.serverID(for: .workingSet, layout: layout))
        XCTAssertNil(ItemMapping.serverID(for: .trashContainer, layout: layout))
        XCTAssertEqual(ItemMapping.serverID(for: NSFileProviderItemIdentifier("d_1"), layout: layout), "d_1")
    }

    func testTopLevelFolderSitsInPersonalSpace() {
        let folder = Fixtures.item(id: "d_1", parentId: "root", type: "folder", name: "Fotos", etag: "t1")
        let item = FileProviderItem(folder, layout: layout)
        XCTAssertEqual(item.itemIdentifier.rawValue, "d_1")
        XCTAssertEqual(item.parentItemIdentifier.rawValue, "space:personal")
        XCTAssertEqual(item.contentType, .folder)
        XCTAssertNil(item.documentSize)
        XCTAssertEqual(item.itemVersion.contentVersion, Data("t1".utf8))
        XCTAssertEqual(item.capabilities, [.allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming,
                                           .allowsReparenting, .allowsDeleting])
        XCTAssertFalse(item.capabilities.contains(.allowsTrashing))
        XCTAssertEqual(item.fileSystemFlags, [.userReadable, .userExecutable, .userWritable])
    }

    func testFileItemVersionAndCapabilities() {
        let file = Fixtures.item(id: "f_1", parentId: "d_1", contentEtag: "v3", etag: "v3")
        let item = FileProviderItem(file, layout: layout)
        XCTAssertEqual(item.parentItemIdentifier.rawValue, "d_1")
        XCTAssertEqual(item.itemVersion.contentVersion, Data("v3".utf8))
        XCTAssertEqual(item.documentSize, 1234)
        XCTAssertEqual(item.contentType, .pdf)
        XCTAssertEqual(item.capabilities, [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting])
        XCTAssertEqual(ItemMapping.contentEtag(from: item.itemVersion), "v3")
        XCTAssertEqual(item.syncItem, file)

        // Renaming changes the metadata version, not the content version.
        var renamed = file
        renamed.name = "Neu.pdf"
        XCTAssertNotEqual(ItemMapping.metadataVersion(for: renamed), ItemMapping.metadataVersion(for: file))
        XCTAssertEqual(ItemMapping.contentVersion(for: renamed), ItemMapping.contentVersion(for: file))
    }

    func testCapabilitiesFollowServerFlags() {
        var file = Fixtures.item(id: "f_1")
        file.capabilities = SyncCapabilities(read: true, write: false, rename: false, move: false, delete: true, addChildren: false)
        XCTAssertEqual(ItemMapping.capabilities(for: file), [.allowsReading, .allowsDeleting])
        XCTAssertEqual(ItemMapping.fileSystemFlags(for: file), [.userReadable])

        var folder = Fixtures.item(id: "d_1", type: "folder", name: "A", etag: "t1")
        folder.capabilities = SyncCapabilities(read: true, write: false, rename: true, move: false, delete: false, addChildren: false)
        XCTAssertEqual(ItemMapping.capabilities(for: folder), [.allowsContentEnumerating, .allowsRenaming])
        XCTAssertEqual(ItemMapping.fileSystemFlags(for: folder), [.userReadable, .userExecutable])
    }

    func testContentTypeFallbacks() {
        XCTAssertEqual(ItemMapping.contentType(forFileName: "Foto.JPG", mime: nil), .jpeg)
        XCTAssertEqual(ItemMapping.contentType(forFileName: "ohne-endung", mime: "application/pdf"), .pdf)
        XCTAssertEqual(ItemMapping.contentType(forFileName: "ohne-endung", mime: "text/plain; charset=utf-8"), .plainText)
        XCTAssertEqual(ItemMapping.contentType(forFileName: "x.unbekannt123", mime: nil), .data)
    }

    func testIgnoredNames() {
        for name in [".DS_Store", "Thumbs.db", "._Foto.jpg", "~$Bericht.docx", "~WRL0001.tmp", ".~lock.Tabelle.ods#",
                     ".synclet-tmp-abc", ".synclet-trash-abc", "@eaDir", "desktop.ini"] {
            XCTAssertTrue(ItemMapping.isIgnoredName(name), name)
        }
        for name in ["Foto.jpg", ".profile", "Bericht.docx", "~notes.txt", ".env"] {
            XCTAssertFalse(ItemMapping.isIgnoredName(name), name)
        }
    }
}

final class ErrorMappingTests: XCTestCase {
    private func code(_ error: Error) -> Int { (ErrorMapping.fileProviderError(error) as NSError).code }
    private func domain(_ error: Error) -> String { (ErrorMapping.fileProviderError(error) as NSError).domain }

    func testSyncAPIErrors() {
        XCTAssertEqual(code(SyncAPIError.deviceRevoked), NSFileProviderError.Code.notAuthenticated.rawValue)
        XCTAssertEqual(domain(SyncAPIError.deviceRevoked), NSFileProviderErrorDomain)
        XCTAssertEqual(code(SyncAPIError.unauthorized(message: nil)), NSFileProviderError.Code.notAuthenticated.rawValue)
        XCTAssertEqual(code(SyncAPIError.notFound), NSFileProviderError.Code.noSuchItem.rawValue)
        XCTAssertEqual(code(SyncAPIError.cursorExpired), NSFileProviderError.Code.syncAnchorExpired.rawValue)
        XCTAssertEqual(code(SyncAPIError.nameConflict(existing: nil)), NSFileProviderError.Code.filenameCollision.rawValue)
        XCTAssertEqual(code(SyncAPIError.tooLarge(message: nil)), NSFileProviderError.Code.insufficientQuota.rawValue)
        XCTAssertEqual(code(SyncAPIError.insufficientStorage(message: nil)), NSFileProviderError.Code.insufficientQuota.rawValue)
        XCTAssertEqual(code(SyncAPIError.transport(.timedOut, message: "")), NSFileProviderError.Code.serverUnreachable.rawValue)
        XCTAssertEqual(code(SyncAPIError.rateLimited(retryAfter: 3)), NSFileProviderError.Code.serverUnreachable.rawValue)
        XCTAssertEqual(code(SyncAPIError.http(status: 502, code: nil, message: nil)), NSFileProviderError.Code.serverUnreachable.rawValue)
        XCTAssertEqual(code(SyncAPIError.http(status: 423, code: nil, message: nil)), NSFileProviderError.Code.serverUnreachable.rawValue)
        XCTAssertEqual(code(SyncAPIError.conflict(current: nil)), NSFileProviderError.Code.cannotSynchronize.rawValue)
        XCTAssertEqual(code(SyncAPIError.preconditionRequired), NSFileProviderError.Code.cannotSynchronize.rawValue)
        XCTAssertEqual(code(SyncAPIError.invalidName(message: nil)), CocoaError.fileWriteInvalidFileName.rawValue)
        XCTAssertEqual(code(SyncAPIError.forbidden(message: nil)), CocoaError.fileWriteNoPermission.rawValue)
        XCTAssertEqual(domain(SyncAPIError.forbidden(message: nil)), NSCocoaErrorDomain)
        XCTAssertEqual(code(SyncAPIError.invalidMove(message: nil)), CocoaError.fileWriteNoPermission.rawValue)
        XCTAssertEqual(code(CancellationError()), CocoaError.userCancelled.rawValue)
    }

    func testTopLevelErrors() {
        XCTAssertEqual(code(SpaceLayoutError.readOnlyTopLevel), NSFileProviderError.Code.cannotSynchronize.rawValue)
        XCTAssertEqual(domain(SpaceLayoutError.readOnlyTopLevel), NSFileProviderErrorDomain)
        XCTAssertEqual(code(SpaceLayoutError.unknownSpace("x")), NSFileProviderError.Code.noSuchItem.rawValue)
        XCTAssertEqual(code(CocoaError(.featureUnsupported)), CocoaError.featureUnsupported.rawValue)
    }
}
