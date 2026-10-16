#if os(macOS)
import FileProvider
import Foundation
import XCTest
@testable import SyncletKit

/// Per-space change feeds against a running server (Phase 4, opt-in): skipped unless
/// `SYNCLET_LIVE_URL` and `SYNCLET_LIVE_TOKEN` are set, and skipped when `/account` lists no
/// team folder (`kind: shared`) – a server without spaces, or a stack without a seeded team
/// folder. `scripts/macos-live-tests.sh` seeds `/teams/Test` and makes the live user a writing
/// member through the admin API.
///
/// Covered: the team folder's own feed (`?space=`) reports an item created in it (with its
/// `spaceId`), the personal feed does not; the working-set enumerator drains both feeds into
/// one anchor; a move from the personal space into the team folder (`PATCH parentId` =
/// `r_<uuid>`) keeps the item (the old space's `delete` is ignored); SSE `hello` carries the
/// team folder's cursor.
final class LiveSpacesTests: XCTestCase {
    private struct Live {
        let origin: URL
        let token: String
        let client: SyncAPIClient
        let personal: SyncSpace
        let team: SyncSpace
        var layout: SpaceLayout
    }

    private func live() async throws -> Live {
        let env = ProcessInfo.processInfo.environment
        guard let urlText = env["SYNCLET_LIVE_URL"], let origin = URL(string: urlText),
              let token = env["SYNCLET_LIVE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("SYNCLET_LIVE_URL / SYNCLET_LIVE_TOKEN not set")
        }
        let client = SyncAPIClient(baseURL: origin, token: token)
        let account = try await client.account()
        let wanted = env["SYNCLET_LIVE_TEAM"] ?? "Test"
        guard let personal = account.spaces.first(where: { $0.kind == .personal }),
              let team = account.spaces.first(where: { $0.kind == .shared && $0.name == wanted })
                ?? account.spaces.first(where: { $0.kind == .shared }) else {
            throw XCTSkip("the server lists no team folder for this user (no spaces support or none seeded)")
        }
        return Live(origin: origin, token: token, client: client, personal: personal, team: team,
                    layout: SpaceLayout(spaces: account.spaces))
    }

    private func name(_ prefix: String) -> String { "\(prefix)-\(UUID().uuidString.prefix(8))" }

    /// Drains a space's feed from `cursor` (all pages).
    private func drain(_ client: SyncAPIClient, space: String, from cursor: String) async throws -> [SyncChange] {
        var changes: [SyncChange] = []
        var cursor = cursor
        while true {
            let page = try await client.changes(space: space, since: cursor)
            changes += page.changes
            cursor = page.cursor
            if !page.hasMore { return changes }
        }
    }

    func testTeamFolderHasItsOwnFeed() async throws {
        let live = try await live()
        XCTAssertTrue(live.team.rootId.hasPrefix("r_"), live.team.rootId)
        XCTAssertTrue(live.team.canWrite, "the live user must be a writing member")
        let teamCursor = try await live.client.cursor(space: live.team.id)
        let personalCursor = try await live.client.cursor()

        let folder = try await live.client.createFolder(parentID: live.team.rootId, name: name("t8-team"))
        defer { Task { try? await live.client.deleteItem(id: folder.id) } }
        XCTAssertEqual(folder.parentId, live.team.rootId)
        XCTAssertEqual(folder.spaceId, live.team.id)

        let teamChanges = try await drain(live.client, space: live.team.id, from: teamCursor)
        let upserted = teamChanges.contains { (change: SyncChange) -> Bool in
            if case .upsert(let item) = change { return item.id == folder.id && item.spaceId == live.team.id }
            return false
        }
        XCTAssertTrue(upserted, "\(teamChanges)")
        let personalChanges = try await drain(live.client, space: live.personal.id, from: personalCursor)
        XCTAssertFalse(personalChanges.contains { $0.itemID == folder.id }, "\(personalChanges)")

        // The children of the space root carry the space's cursor and items.
        let children = try await live.client.children(of: live.team.rootId)
        XCTAssertTrue(children.items.contains { $0.id == folder.id })
    }

    func testWorkingSetDrainsBothFeedsAndKeepsACrossSpaceMove() async throws {
        let live = try await live()
        let layout = live.layout
        let enumerator = FileProviderEnumerator(containerIdentifier: .workingSet, client: live.client, layout: { layout })
        let anchor = try await currentAnchor(enumerator)
        XCTAssertNotNil(anchor[live.personal.id])
        XCTAssertNotNil(anchor[live.team.id])

        let inTeam = try await live.client.createFolder(parentID: live.team.rootId, name: name("t8-ws-team"))
        let moving = try await live.client.createFolder(parentID: SyncItem.rootID, name: name("t8-move"))
        defer {
            Task {
                try? await live.client.deleteItem(id: inTeam.id)
                try? await live.client.deleteItem(id: moving.id)
            }
        }
        // First round: both creations.
        let first = try await changes(enumerator, from: anchor)
        XCTAssertTrue(first.updated.contains(inTeam.id), "\(first.updated)")
        XCTAssertTrue(first.updated.contains(moving.id), "\(first.updated)")
        XCTAssertEqual(first.parents[inTeam.id], SpaceLayout.identifier(for: live.team).rawValue)

        // Cross-space move as Finder does it: PATCH parentId = the team folder's root id.
        let moved = try await live.client.move(id: moving.id, toParent: live.team.rootId)
        XCTAssertEqual(moved.id, moving.id)
        XCTAssertEqual(moved.parentId, live.team.rootId)
        XCTAssertEqual(moved.spaceId, live.team.id)
        let second = try await changes(enumerator, from: first.anchor)
        XCTAssertFalse(second.deleted.contains(moving.id), "a moved item must not be deleted: \(second)")
        XCTAssertTrue(second.updated.contains(moving.id), "\(second.updated)")
        XCTAssertEqual(second.parents[moving.id], SpaceLayout.identifier(for: live.team).rawValue)
        XCTAssertNotEqual(second.anchor[live.team.id], anchor[live.team.id])
    }

    func testHelloCarriesTheTeamCursor() async throws {
        let live = try await live()
        let stream = EventStream(url: EventStream.url(origin: live.origin), token: { live.token })
        let first = Task { () -> [String: String]? in
            for try await signal in stream.events() {
                if case .connected(_, let cursors) = signal { return cursors }
            }
            return nil
        }
        let timeout = Task {
            try await Task.sleep(for: .seconds(5))
            first.cancel()
        }
        let hello = try? await first.value
        timeout.cancel()
        let cursors = try XCTUnwrap(hello ?? nil, "no hello within 5 s")
        XCTAssertNotNil(cursors[live.personal.id], "\(cursors)")
        XCTAssertNotNil(cursors[live.team.id], "\(cursors)")
    }

    // MARK: - Enumerator helpers

    private func currentAnchor(_ enumerator: FileProviderEnumerator) async throws -> [String: String] {
        let box = AnchorBox()
        let done = expectation(description: "anchor")
        enumerator.currentSyncAnchor { box.value = $0; done.fulfill() }
        await fulfillment(of: [done], timeout: 10)
        return try XCTUnwrap(box.value.flatMap(SyncAnchorCodec.decode))
    }

    private struct Round: CustomStringConvertible {
        var updated: [String] = []
        var parents: [String: String] = [:]
        var deleted: [String] = []
        var anchor: [String: String] = [:]
        var description: String { "updated \(updated), deleted \(deleted), anchor \(anchor)" }
    }

    /// Enumerates changes until `moreComing` is false.
    private func changes(_ enumerator: FileProviderEnumerator, from start: [String: String]) async throws -> Round {
        var round = Round(anchor: start)
        for _ in 0..<20 {
            let observer = MockChangeObserver(expectation(description: "changes"))
            enumerator.enumerateChanges(for: observer, from: SyncAnchorCodec.encode(round.anchor))
            await fulfillment(of: [observer.finished], timeout: 10)
            if let error = observer.error { throw error }
            for item in observer.updated {
                round.updated.append(item.itemIdentifier.rawValue)
                round.parents[item.itemIdentifier.rawValue] = item.parentItemIdentifier.rawValue
            }
            round.deleted += observer.deleted.map(\.rawValue)
            round.anchor = try XCTUnwrap(observer.anchor.flatMap(SyncAnchorCodec.decode))
            if observer.moreComing != true { break }
        }
        return round
    }
}
#endif
