import SyncletKit
import UniformTypeIdentifiers
import XCTest
@testable import Synclet

final class ShareTargetTests: XCTestCase {
    private func account(_ key: String, root: String = "root") -> StoredAccount {
        StoredAccount(key: key, serverURL: URL(string: "https://files.test")!, userId: "u1", username: "jens",
                      displayName: "Jens", spaces: [SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien",
                                                              rootId: root, canWrite: true)])
    }

    func testShareTargetFallsBackWhenAccountGone() {
        let stored = ShareTarget(accountKey: "k_gone", folderId: "f1", folderName: "Urlaub")

        let target = ShareTarget.resolve(stored: stored, accounts: [account("k1")])

        XCTAssertEqual(target, ShareTarget(accountKey: "k1", folderId: "root", folderName: String(localized: "My Files")))
    }

    func testShareTargetKeepsTheLastTarget() {
        let stored = ShareTarget(accountKey: "k2", folderId: "f1", folderName: "Urlaub")
        XCTAssertEqual(ShareTarget.resolve(stored: stored, accounts: [account("k1"), account("k2")]), stored)
    }

    func testShareTargetWithoutAccounts() {
        XCTAssertNil(ShareTarget.resolve(stored: nil, accounts: []))
        XCTAssertEqual(ShareTarget.resolve(stored: nil, accounts: [account("k1", root: "r1")])?.folderId, "r1")
    }

    func testShareTargetPersistence() throws {
        let suite = "share-target-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        XCTAssertNil(ShareTarget.load(from: defaults))
        let target = ShareTarget(accountKey: "k1", folderId: "f1", folderName: "Urlaub")

        target.save(to: defaults)

        XCTAssertEqual(ShareTarget.load(from: defaults), target)
        XCTAssertNotNil(defaults.data(forKey: "shareLastTarget"))
    }
}

final class ShareNamingTests: XCTestCase {
    func testUploadTypeSkipsLinks() {
        XCTAssertEqual(ShareNaming.uploadType([.url, .heic, .jpeg]), .heic)
        XCTAssertEqual(ShareNaming.uploadType([.fileURL, .pdf]), .pdf)
        XCTAssertNil(ShareNaming.uploadType([.url]))
    }

    func testFileNames() {
        let file = URL(filePath: "/tmp/x/IMG_0001.HEIC")
        XCTAssertEqual(ShareNaming.fileName(suggested: nil, file: file, type: .heic), "IMG_0001.HEIC")
        XCTAssertEqual(ShareNaming.fileName(suggested: "Urlaub", file: file, type: .heic), "Urlaub.HEIC")
        XCTAssertEqual(ShareNaming.fileName(suggested: "Bericht.pdf", file: URL(filePath: "/tmp/x/abc"), type: .pdf), "Bericht.pdf")
        XCTAssertEqual(ShareNaming.fileName(suggested: "Notiz", file: URL(filePath: "/tmp/x/abc"), type: .plainText), "Notiz.txt")
        XCTAssertEqual(ShareNaming.fileName(suggested: "a/b", file: file, type: .heic), "a_b.HEIC")
    }
}
