import Foundation
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class ShareLinkModelTests: XCTestCase {
    private let linksBox = LockedBox<[ShareLink]>([])
    private var links: [ShareLink] {
        get { linksBox.value }
        set { linksBox.value = newValue }
    }
    private var requests: [RecordedRequest] { MockURLProtocol.requests }
    private var writes: [RecordedRequest] { requests.filter { $0.method != "GET" } }

    nonisolated private static let file = Items.file("a.txt")
    nonisolated private static let folder = Items.folder("Docs")
    private var file: SyncItem { Self.file }
    private var folder: SyncItem { Self.folder }

    override func setUp() async throws {
        links = []
        MockURLProtocol.reset { [linksBox] request in
            Self.respond(request, links: linksBox.value)
        }
    }

    nonisolated private static func respond(_ request: RecordedRequest, links: [ShareLink]) -> MockResponse {
        switch (request.method, request.path) {
        case ("GET", "/api/shares"):
            return AppFixtures.ok(links)
        case ("POST", "/api/shares"):
            let id = request.json?["itemId"] as? String ?? "?"
            let item = id == folder.id ? folder : file
            return AppFixtures.ok(AppFixtures.share(id: "new", item: item, url: "/s/x",
                                                    allowDownload: request.json?["allowDownload"] as? Bool ?? true),
                                  status: 201)
        case ("PATCH", let path):
            var link = links.first { path.hasSuffix("/\($0.id)") }!
            if let allow = request.json?["allowDownload"] as? Bool { link.allowDownload = allow }
            return AppFixtures.ok(link)
        case ("DELETE", _):
            return .empty(204)
        default:
            return Items.error(404, "not_found")
        }
    }

    private func makeModel(_ item: SyncItem) -> ShareLinkModel {
        ShareLinkModel(item: item, server: AppFixtures.base, api: AppFixtures.client())
    }

    func testShareCreateWhenNoneActive() async {
        let model = makeModel(file)
        await model.load()
        XCTAssertNil(model.active)
        XCTAssertEqual(AppFixtures.query(requests[0])["itemId"], file.id)
        let url = await model.createOrUpdate()
        XCTAssertEqual(url?.absoluteString, "https://files.test/s/x")
        XCTAssertEqual(writes.map(\.method), ["POST"])
        XCTAssertEqual(writes.first?.json?["itemId"] as? String, file.id)
        XCTAssertEqual(model.active?.id, "new")
    }

    func testShareReuseActiveAndPatchOnlyChanges() async {
        links = [AppFixtures.share(id: "s1", item: file, url: "https://files.test/s/abc", allowDownload: true)]
        let model = makeModel(file)
        await model.load()
        XCTAssertEqual(model.active?.id, "s1")
        XCTAssertTrue(model.allowDownload)
        model.allowDownload = false
        let url = await model.createOrUpdate()
        XCTAssertEqual(url?.absoluteString, "https://files.test/s/abc")
        XCTAssertEqual(writes.map(\.method), ["PATCH"])
        XCTAssertEqual(writes.first?.path, "/api/shares/s1")
        XCTAssertEqual(writes.first?.json?.count, 1)
        XCTAssertEqual(writes.first?.json?["allowDownload"] as? Bool, false)
    }

    func testUnchangedActiveLinkSendsNothing() async {
        links = [AppFixtures.share(id: "s1", item: file)]
        let model = makeModel(file)
        await model.load()
        let url = await model.createOrUpdate()
        XCTAssertEqual(url?.absoluteString, "https://files.test/s/tok")
        XCTAssertTrue(writes.isEmpty)
    }

    func testNewestActiveLinkWins() async {
        links = [AppFixtures.share(id: "old", item: file, createdAt: "2026-10-01T10:00:00.000Z"),
                 AppFixtures.share(id: "newest", item: file, createdAt: "2026-10-12T10:00:00.000Z"),
                 AppFixtures.share(id: "mid", item: file, createdAt: "2026-10-05T10:00:00.000Z")]
        let model = makeModel(file)
        await model.load()
        XCTAssertEqual(model.active?.id, "newest")
    }

    func testExpiredOrRevokedLinkIsNotActive() async {
        links = [AppFixtures.share(id: "revoked", item: file, revokedAt: "2026-10-11T10:00:00.000Z"),
                 AppFixtures.share(id: "expired", item: file, expiresAt: "2020-01-01T00:00:00.000Z"),
                 AppFixtures.share(id: "trashed", item: file, itemTrashed: true)]
        let model = makeModel(file)
        await model.load()
        XCTAssertNil(model.active)
        _ = await model.createOrUpdate()
        XCTAssertEqual(writes.map(\.method), ["POST"])
    }

    func testAllowUploadIgnoredForFiles() async {
        let model = makeModel(file)
        await model.load()
        model.allowUpload = true
        _ = await model.createOrUpdate()
        XCTAssertEqual(writes.map(\.method), ["POST"])
        XCTAssertNil(writes.first?.json?["allowUpload"])
    }

    func testAllowUploadSentForFolders() async {
        let model = makeModel(folder)
        await model.load()
        model.allowUpload = true
        _ = await model.createOrUpdate()
        XCTAssertEqual(writes.first?.json?["allowUpload"] as? Bool, true)
    }

    func testCreateWithPasswordAndExpiry() async {
        let model = makeModel(file)
        await model.load()
        model.usePassword = true
        model.password = "geheim"
        model.expiresAt = Date(timeIntervalSince1970: 1_900_000_000)
        _ = await model.createOrUpdate()
        let body = writes.first?.json
        XCTAssertEqual(body?["password"] as? String, "geheim")
        XCTAssertEqual(body?["expiresAt"] as? String, "2030-03-17T17:46:40Z")
    }

    func testRemovingPasswordSendsNull() async {
        links = [AppFixtures.share(id: "s1", item: file, hasPassword: true)]
        let model = makeModel(file)
        await model.load()
        XCTAssertTrue(model.usePassword)
        model.usePassword = false
        _ = await model.createOrUpdate()
        let body = writes.first?.json
        XCTAssertEqual(body?.count, 1)
        XCTAssertTrue(body?["password"] is NSNull)
    }

    func testRevoke() async {
        links = [AppFixtures.share(id: "s1", item: file)]
        let model = makeModel(file)
        await model.load()
        await model.revoke()
        XCTAssertEqual(writes.map(\.method), ["DELETE"])
        XCTAssertEqual(writes.first?.path, "/api/shares/s1")
        XCTAssertNil(model.active)
    }
}
