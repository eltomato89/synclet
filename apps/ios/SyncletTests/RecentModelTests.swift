import Foundation
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class RecentModelTests: XCTestCase {
    func testRecentLoads() async {
        let items = [Items.file("new.txt"), Items.file("old.txt")]
        MockURLProtocol.reset { request in
            request.path == "/api/sync/v1/recent" ? AppFixtures.ok(items) : Items.error(404, "not_found")
        }
        let model = RecentModel(api: AppFixtures.client())
        XCTAssertEqual(model.state, .idle)
        await model.load()
        XCTAssertEqual(model.state, .loaded)
        XCTAssertEqual(model.items.map(\.name), ["new.txt", "old.txt"])
        XCTAssertEqual(MockURLProtocol.requests.first.map(AppFixtures.query)?["limit"], "50")
    }

    func testRecentOffline() async {
        MockURLProtocol.reset { _ in .failure(.notConnectedToInternet) }
        let model = RecentModel(api: AppFixtures.client())
        await model.load()
        XCTAssertEqual(model.state, .offline)
    }
}
