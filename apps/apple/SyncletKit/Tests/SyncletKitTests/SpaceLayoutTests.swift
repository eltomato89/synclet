import FileProvider
import XCTest
@testable import SyncletKit

final class SpaceLayoutTests: XCTestCase {
    let personal = Fixtures.personal
    let team = SyncSpace(id: "s_team", kind: .unknown("team"), name: "Team Ablage", rootId: "d_team", canWrite: false)

    var layout: SpaceLayout { SpaceLayout(spaces: [personal, team]) }

    func testIdentifierRoundTrip() {
        let identifier = SpaceLayout.identifier(for: personal)
        XCTAssertEqual(identifier.rawValue, "space:personal")
        XCTAssertEqual(SpaceLayout.spaceID(from: identifier), "personal")
        XCTAssertEqual(layout.space(for: identifier), personal)
        XCTAssertNil(SpaceLayout.spaceID(from: NSFileProviderItemIdentifier("d_1")))
        XCTAssertNil(SpaceLayout.spaceID(from: NSFileProviderItemIdentifier("space:")))
        XCTAssertNil(SpaceLayout.spaceID(from: .rootContainer))
    }

    func testServerIdsRoundTrip() throws {
        // space root ⇄ space identifier
        XCTAssertEqual(layout.providerParent(forServerParentId: "root").rawValue, "space:personal")
        XCTAssertEqual(layout.providerParent(forServerParentId: "d_team").rawValue, "space:s_team")
        XCTAssertEqual(try layout.serverParentId(for: NSFileProviderItemIdentifier("space:personal")), "root")
        XCTAssertEqual(try layout.serverParentId(for: NSFileProviderItemIdentifier("space:s_team")), "d_team")
        // everything else passes through unchanged
        XCTAssertEqual(layout.providerParent(forServerParentId: "d_1").rawValue, "d_1")
        XCTAssertEqual(try layout.serverParentId(for: NSFileProviderItemIdentifier("d_1")), "d_1")
        for id in ["root", "d_team", "d_1", "f_2"] {
            XCTAssertEqual(layout.serverID(for: layout.providerIdentifier(forServerID: id)), id)
        }
        XCTAssertNil(layout.serverID(for: .rootContainer))
        XCTAssertNil(layout.serverID(for: .workingSet))
        XCTAssertNil(layout.serverID(for: .trashContainer))
        XCTAssertNil(layout.serverID(for: NSFileProviderItemIdentifier("space:gone")))
    }

    func testParentOfItems() {
        let topLevel = Fixtures.item(id: "f_1", parentId: "root")
        XCTAssertEqual(layout.parentIdentifier(for: topLevel).rawValue, "space:personal")
        let nested = Fixtures.item(id: "f_2", parentId: "d_5")
        XCTAssertEqual(layout.parentIdentifier(for: nested).rawValue, "d_5")
        let root = Fixtures.item(id: "root", parentId: nil, type: "folder", name: "jens", etag: "t0")
        XCTAssertEqual(layout.parentIdentifier(for: root), .rootContainer)
    }

    func testRootWritesThrow() {
        XCTAssertThrowsError(try layout.serverParentId(for: .rootContainer)) {
            XCTAssertEqual($0 as? SpaceLayoutError, .readOnlyTopLevel)
        }
        XCTAssertThrowsError(try layout.serverParentId(for: .workingSet)) {
            XCTAssertEqual($0 as? SpaceLayoutError, .readOnlyTopLevel)
        }
        XCTAssertThrowsError(try layout.serverParentId(for: NSFileProviderItemIdentifier("space:gone"))) {
            XCTAssertEqual($0 as? SpaceLayoutError, .unknownSpace("gone"))
        }
        XCTAssertTrue(layout.isTopLevel(.rootContainer))
        XCTAssertTrue(layout.isTopLevel(NSFileProviderItemIdentifier("space:personal")))
        XCTAssertFalse(layout.isTopLevel(NSFileProviderItemIdentifier("d_1")))
    }

    func testPersonalIsLocalized() {
        XCTAssertEqual(SpaceLayout.displayName(for: personal, bundle: TestBundles.lproj("de")), "Meine Dateien")
        XCTAssertEqual(SpaceLayout.displayName(for: personal, bundle: TestBundles.lproj("en")), "My Files")
        // Default path (`String(localized:)`): one of the two, depending on the test machine's language.
        XCTAssertTrue(["Meine Dateien", "My Files"].contains(SpaceLayout.displayName(for: personal)))
        // The server's suggestion is not used for known kinds.
        let renamed = SyncSpace(id: "personal", kind: .personal, name: "Whatever", rootId: "root", canWrite: true)
        XCTAssertEqual(SpaceLayout.displayName(for: renamed, bundle: TestBundles.lproj("en")), "My Files")
    }

    func testUnknownKindUsesServerName() {
        XCTAssertEqual(SpaceLayout.displayName(for: team), "Team Ablage")
        XCTAssertEqual(SpaceLayout.displayName(for: team, bundle: TestBundles.lproj("de")), "Team Ablage")
    }

    func testTopLevelItemsAreReadOnlyFolders() {
        let items = layout.topLevelItems(bundle: TestBundles.lproj("de"))
        XCTAssertEqual(items.map(\.itemIdentifier.rawValue), ["space:personal", "space:s_team"])
        XCTAssertEqual(items.map(\.filename), ["Meine Dateien", "Team Ablage"])
        for item in items {
            XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
            XCTAssertEqual(item.contentType, .folder)
            XCTAssertTrue(item.capabilities.contains(.allowsReading))
            XCTAssertTrue(item.capabilities.contains(.allowsContentEnumerating))
            XCTAssertFalse(item.capabilities.contains(.allowsRenaming))
            XCTAssertFalse(item.capabilities.contains(.allowsReparenting))
            XCTAssertFalse(item.capabilities.contains(.allowsDeleting))
            XCTAssertFalse(item.capabilities.contains(.allowsTrashing))
            XCTAssertNil(item.syncItem)
        }
        // Items can be added inside a writable space (its content is the user's tree),
        // not inside a read-only one. Note: for folders `.allowsWriting` and
        // `.allowsAddingSubItems` are the same bit.
        XCTAssertEqual(items[0].capabilities, [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems])
        XCTAssertEqual(items[1].capabilities, [.allowsReading, .allowsContentEnumerating])
    }

    func testRootContainerItemIsReadOnly() {
        let root = FileProviderItem.rootContainer()
        XCTAssertEqual(root.itemIdentifier, .rootContainer)
        XCTAssertEqual(root.capabilities, [.allowsReading, .allowsContentEnumerating])
        XCTAssertEqual(layout.virtualItem(for: .rootContainer)?.itemIdentifier, .rootContainer)
        XCTAssertEqual(layout.virtualItem(for: NSFileProviderItemIdentifier("space:s_team"))?.space, team)
        XCTAssertNil(layout.virtualItem(for: NSFileProviderItemIdentifier("d_1")))
    }

    func testServerRootItemBecomesSpaceFolder() {
        let root = Fixtures.item(id: "root", parentId: nil, type: "folder", name: "jens", etag: "t0")
        let item = FileProviderItem(root, layout: layout)
        XCTAssertEqual(item.itemIdentifier.rawValue, "space:personal")
        XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
        XCTAssertFalse(item.capabilities.contains(.allowsRenaming))
        XCTAssertFalse(item.capabilities.contains(.allowsDeleting))
    }

    func testFeedSpaces() {
        XCTAssertEqual(layout.feedSpaces, [personal])
        XCTAssertEqual(layout.rootIds, ["root", "d_team"])
    }
}
