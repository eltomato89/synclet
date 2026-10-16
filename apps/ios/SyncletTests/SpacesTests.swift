import SyncletKit
import XCTest
@testable import Synclet

/// Spaces in the browser, the pickers, search, recent and trash (Phase 4, Task 9).
@MainActor
final class SpacesTests: XCTestCase {
    private let personal = SyncSpace(id: "personal", kind: .personal, name: "Meine Dateien", rootId: "root", canWrite: true)
    private let team = SyncSpace(id: "s1", kind: .shared, name: "Team", rootId: "r_s1", canWrite: true, status: "available")
    private let readOnlyTeam = SyncSpace(id: "s2", kind: .shared, name: "Handbuch", rootId: "r_s2", canWrite: false)
    private let missing = SyncSpace(id: "s3", kind: .external, name: "Archiv", rootId: "r_s3", canWrite: false, status: "missing")

    private func account(_ spaces: [SyncSpace], key: String = "k1") -> StoredAccount {
        StoredAccount(key: key, serverURL: URL(string: "https://files.test")!, userId: "u1", username: "jens",
                      displayName: "Jens", spaces: spaces)
    }

    private static let myFiles = String(localized: "My Files")

    // MARK: - Browser root

    func testAccountWithTwoSpacesListsBothBesideMyFiles() {
        let directory = SpaceDirectory(spaces: [personal, team, readOnlyTeam])

        XCTAssertTrue(directory.hasSpaces)
        XCTAssertEqual(directory.personal.title, Self.myFiles)
        XCTAssertEqual(directory.personal.space.rootId, "root")
        XCTAssertEqual(directory.others.map(\.title), ["Team", "Handbuch"], "server order")
        XCTAssertEqual(directory.others.map(\.space.rootId), ["r_s1", "r_s2"])
        XCTAssertEqual(directory.others.map(\.systemImage), ["person.2", "person.2"])
        XCTAssertEqual(directory.others.map(\.isReadOnly), [false, true])
    }

    func testOnlyPersonalSpaceShowsNoSpaceList() {
        XCTAssertFalse(SpaceDirectory(spaces: [personal]).hasSpaces)
        XCTAssertFalse(SpaceDirectory(spaces: []).hasSpaces)
        XCTAssertEqual(SpaceDirectory(spaces: []).personal.space.rootId, "root", "older server: synthesized")
    }

    func testSpaceRoutesCarryTheWriteAccess() {
        let directory = SpaceDirectory(spaces: [personal, team, readOnlyTeam, missing])
        let routes = directory.all.map(\.route)

        XCTAssertEqual(routes.map(\.id), ["root", "r_s1", "r_s2", "r_s3"])
        XCTAssertEqual(routes.map(\.spaceId), ["personal", "s1", "s2", "s3"])
        XCTAssertEqual(routes.map(\.canAddChildren), [true, true, false, false])
        XCTAssertEqual(directory.others.map(\.isAvailable), [true, true, false])
        XCTAssertEqual(directory.others.last?.systemImage, "externaldrive")
    }

    func testMissingSpaceSaysNotAvailable() {
        let entry = SpaceDirectory(spaces: [personal, missing]).others[0]
        XCTAssertFalse(entry.isAvailable)
        XCTAssertTrue(["Not Available", "Nicht verfügbar"].contains(entry.subtitle ?? ""), entry.subtitle ?? "nil")
        XCTAssertTrue(["Read Only", "Nur lesen"].contains(SpaceDirectory(spaces: [personal, readOnlyTeam]).others[0].subtitle ?? ""))
        XCTAssertNil(SpaceDirectory(spaces: [personal, team]).others[0].subtitle)
    }

    func testSpaceListStringsAreLocalized() {
        XCTAssertFalse(String(localized: "Spaces").isEmpty)
        let german = Bundle(path: Bundle(for: AccountsModel.self).path(forResource: "de", ofType: "lproj") ?? "")
        XCTAssertEqual(german?.localizedString(forKey: "Spaces", value: nil, table: nil), "Bereiche")
        XCTAssertEqual(german?.localizedString(forKey: "Read Only", value: nil, table: nil), "Nur lesen")
        XCTAssertEqual(german?.localizedString(forKey: "Not Available", value: nil, table: nil), "Nicht verfügbar")
    }

    // MARK: - iPad sidebar

    func testSidebarFallsBackToMyFilesWhenTheSpaceIsGone() {
        let selection = SidebarSelection(accountKey: "k1", destination: .files, spaceId: "s1")
        XCTAssertEqual(selection.validated(spaces: [personal, team]), selection)
        XCTAssertEqual(selection.validated(spaces: [personal]),
                       SidebarSelection(accountKey: "k1", destination: .files, spaceId: nil))
    }

    // MARK: - Read-only

    func testReadOnlyItemsOfferNoWriteActions() {
        var item = Items.file("Plan.pdf")
        item.capabilities = SyncCapabilities(read: true, write: false, rename: false, move: false, delete: false,
                                             addChildren: false)
        XCTAssertEqual(ItemAction.available(for: item), [], "no rename, move, delete and no share link")
        XCTAssertEqual(ItemAction.available(for: Items.file("Plan.pdf")), [.share, .rename, .move, .delete])
    }

    func testFolderRouteOfAnItemFollowsItsCapabilities() {
        var folder = Items.folder("Docs", parent: "r_s2")
        folder.spaceId = "s2"
        folder.capabilities.addChildren = false
        let route = FolderRoute(item: folder)
        XCTAssertEqual(route.id, folder.id)
        XCTAssertEqual(route.spaceId, "s2")
        XCTAssertFalse(route.canAddChildren)
        XCTAssertTrue(FolderRoute(item: Items.folder("Mine")).canAddChildren)
    }

    func testUnavailableSpaceLoadsAsUnavailable() async {
        let server = FakeFolderServer([:])
        server.override = { _ in Items.error(503, "space_unavailable") }
        server.install()
        let model = FolderModel(accountKey: "acc", folderId: "r_s3", title: "Archiv", api: server.client(), signal: { _ in })

        await model.load()

        XCTAssertEqual(model.state, .unavailable)
    }

    func testSpaceUnavailableMutationSaysNotAvailable() {
        let error = SyncAPIError.http(status: 503, code: "space_unavailable", message: "space_unavailable message")
        let message = MutationErrors.message(MutationErrors.outcome(for: error))
        XCTAssertTrue(["Not Available", "Nicht verfügbar"].contains(message ?? ""), message ?? "nil")
    }

    // MARK: - Live write access (review fix 2)

    func testSpaceRootFollowsTheLiveSpaceList() {
        let route = SpaceEntry(space: team).route
        XCTAssertTrue(SpaceDirectory(spaces: [personal, team]).canAddChildren(to: route, folder: nil))

        var readOnly = team
        readOnly.canWrite = false
        XCTAssertFalse(SpaceDirectory(spaces: [personal, readOnly]).canAddChildren(to: route, folder: nil),
                       "the space turned read-only while open")
        var gone = team
        gone.status = "missing"
        XCTAssertFalse(SpaceDirectory(spaces: [personal, gone]).canAddChildren(to: route, folder: nil),
                       "the storage went missing while open")
        XCTAssertFalse(SpaceDirectory(spaces: [personal]).canAddChildren(to: route, folder: nil), "access removed")
    }

    func testSubfolderFollowsItsSpaceAndItsReloadedCapabilities() {
        var folder = Items.folder("Docs", parent: "r_s1")
        folder.spaceId = "s1"
        let route = FolderRoute(item: folder)
        XCTAssertTrue(route.canAddChildren)
        XCTAssertTrue(SpaceDirectory(spaces: [personal, team]).canAddChildren(to: route, folder: folder))

        var readOnly = team
        readOnly.canWrite = false
        XCTAssertFalse(SpaceDirectory(spaces: [personal, readOnly]).canAddChildren(to: route, folder: nil))

        var reloaded = folder
        reloaded.capabilities.addChildren = false
        XCTAssertFalse(SpaceDirectory(spaces: [personal, team]).canAddChildren(to: route, folder: reloaded),
                       "the reloaded folder says read-only")
        XCTAssertTrue(SpaceDirectory(spaces: [personal]).canAddChildren(to: FolderRoute(item: Items.folder("Mine")), folder: nil),
                      "personal folder of an older server")
    }

    func testFolderModelReloadsTheFolderItsCapabilities() async {
        var docs = Items.folder("Docs", id: "d_docs", parent: "r_s1")
        docs.capabilities.addChildren = false
        let server = FakeFolderServer(["d_docs": [Items.file("a.txt", parent: "d_docs")]])
        server.override = { request in
            request.method == "GET" && request.path == "/api/sync/v1/items/d_docs"
                ? .data(200, Items.json(docs), contentType: "application/json") : nil
        }
        server.install()
        let model = FolderModel(accountKey: "acc", folderId: "d_docs", title: "Docs", api: server.client(),
                                fetchesFolder: true, signal: { _ in })

        await model.load()

        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.folder?.capabilities.addChildren, false)
    }

    // MARK: - Lists across spaces (review fix 3)

    func testListModelsShowNotAvailableForAMissingSpace() async {
        MockURLProtocol.reset { _ in Items.error(503, "space_unavailable") }
        let trash = TrashModel(accountKey: "acc", api: AppFixtures.client(), signal: { _ in })
        await trash.load()
        XCTAssertEqual(trash.state, .unavailable)
        let recent = RecentModel(api: AppFixtures.client())
        await recent.load()
        XCTAssertEqual(recent.state, .unavailable)
    }

    // MARK: - Move picker and share target

    func testMoveTargetsAreTheWritableAvailableSpaces() {
        let directory = SpaceDirectory(spaces: [personal, team, readOnlyTeam, missing])
        XCTAssertEqual(directory.writable.map(\.space.id), ["personal", "s1"])
    }

    func testShareTargetCanPickATeamFolder() {
        let stored = account([personal, team, readOnlyTeam, missing])

        let targets = ShareTarget.spaceTargets(of: stored)

        XCTAssertEqual(targets.map(\.folderId), ["root", "r_s1"])
        XCTAssertEqual(targets.map(\.folderName), [Self.myFiles, "Team"])
        XCTAssertEqual(targets.last?.spaceId, "s1")
        XCTAssertEqual(targets.first, ShareTarget.root(of: stored))
    }

    func testStoredShareTargetInALostSpaceFallsBackToMyFiles() {
        let inTeam = ShareTarget(accountKey: "k1", folderId: "d_9", folderName: "Fotos", spaceId: "s1")
        XCTAssertEqual(ShareTarget.resolve(stored: inTeam, accounts: [account([personal, team])]), inTeam)
        XCTAssertEqual(ShareTarget.resolve(stored: inTeam, accounts: [account([personal])])?.folderId, "root",
                       "access to the team folder was removed")
        let readOnly = ShareTarget(accountKey: "k1", folderId: "d_8", folderName: "x", spaceId: "s2")
        XCTAssertEqual(ShareTarget.resolve(stored: readOnly, accounts: [account([personal, readOnlyTeam])])?.folderId, "root")
    }

    func testOldStoredShareTargetWithoutSpaceStillDecodes() throws {
        let json = #"{"accountKey":"k1","folderId":"f1","folderName":"Urlaub"}"#
        let target = try JSONDecoder().decode(ShareTarget.self, from: Data(json.utf8))
        XCTAssertNil(target.spaceId)
        XCTAssertEqual(ShareTarget.resolve(stored: target, accounts: [account([personal])]), target)
    }

    // MARK: - Search, recent, trash

    func testSpaceNamesOnlyWithSpaces() {
        let names = SpaceDirectory(spaces: [personal, team])
        XCTAssertEqual(names.label(for: "s1"), "Team")
        XCTAssertEqual(names.label(for: "personal"), Self.myFiles)
        XCTAssertEqual(names.label(for: nil), Self.myFiles, "older servers: personal")
        XCTAssertNil(names.label(for: "unknown"))
        XCTAssertNil(SpaceDirectory(spaces: [personal]).label(for: "personal"), "no label without spaces")
    }

    func testSearchHitPathShowsTheSpace() {
        var item = Items.file("Plan.pdf", parent: "r_s1")
        item.spaceId = "s1"
        let hit = SyncSearchHit(item: item, path: "/Docs/Plan.pdf", snippet: nil, matched: "name")
        XCTAssertEqual(SpaceDirectory(spaces: [personal, team]).location(of: hit), "Team · /Docs/Plan.pdf")
        XCTAssertEqual(SpaceDirectory(spaces: [personal]).location(of: hit), "/Docs/Plan.pdf")
    }

    func testTrashSubtitleShowsTheSpace() {
        var entry = AppFixtures.trashEntry("Alt.pdf")
        entry.spaceId = "s1"
        XCTAssertEqual(SpaceDirectory(spaces: [personal, team]).location(spaceId: entry.spaceId, path: entry.originalPath),
                       "Team · /Docs/Alt.pdf")
    }
}
