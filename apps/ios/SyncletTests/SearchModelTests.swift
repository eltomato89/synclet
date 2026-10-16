import Foundation
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class SearchModelTests: XCTestCase {
    private var requests: [RecordedRequest] { MockURLProtocol.requests }
    private var searches: [RecordedRequest] { requests.filter { $0.path == "/api/sync/v1/search" } }

    /// Answers every search with `total` hits in total, paged by `limit`/`offset`.
    private func serve(total: Int) {
        MockURLProtocol.reset { Self.respond($0, total: total) }
    }

    nonisolated private static func respond(_ request: RecordedRequest, total: Int) -> MockResponse {
        let query = AppFixtures.query(request)
        let offset = Int(query["offset"] ?? "0") ?? 0
        let limit = Int(query["limit"] ?? "20") ?? 20
        let hits = (offset..<min(total, offset + limit)).map { AppFixtures.hit("hit\($0).txt") }
        return AppFixtures.ok(SyncSearchResult(hits: hits, total: total))
    }

    func testSearchDebouncesAndCancels() async {
        serve(total: 1)
        let model = SearchModel(api: AppFixtures.client())
        for text in ["ku", "kum", "kumq"] {
            model.query = text
            model.queryChanged()
            try? await Task.sleep(for: .milliseconds(30))
        }
        let loaded = await eventually { model.hits.count == 1 }
        XCTAssertTrue(loaded)
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(searches.count, 1)
        XCTAssertEqual(searches.first.map(AppFixtures.query)?["q"], "kumq")
        XCTAssertEqual(model.state, .loaded)
    }

    func testSearchMinTwoChars() async {
        serve(total: 3)
        let model = SearchModel(api: AppFixtures.client())
        model.query = "k"
        model.queryChanged()
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertTrue(searches.isEmpty)
        XCTAssertTrue(model.hits.isEmpty)
    }

    func testShorterQueryClearsHits() async {
        serve(total: 3)
        let model = SearchModel(api: AppFixtures.client())
        model.query = "kum"
        model.queryChanged()
        _ = await eventually { model.hits.count == 3 }
        model.query = "k"
        model.queryChanged()
        XCTAssertTrue(model.hits.isEmpty)
        XCTAssertEqual(model.state, .idle)
    }

    func testSearchPaging() async {
        serve(total: 45)
        let model = SearchModel(api: AppFixtures.client())
        model.query = "report"
        model.queryChanged()
        let first = await eventually { model.hits.count == 20 }
        XCTAssertTrue(first)
        await model.loadMore()
        XCTAssertEqual(model.hits.count, 40)
        await model.loadMore()
        XCTAssertEqual(model.hits.count, 45)
        await model.loadMore()
        XCTAssertEqual(model.hits.count, 45)
        XCTAssertEqual(searches.count, 3)
        XCTAssertEqual(searches.map { AppFixtures.query($0)["offset"] }, ["0", "20", "40"])
        XCTAssertEqual(searches.map { AppFixtures.query($0)["limit"] }, ["20", "20", "20"])
    }

    func testScopeFolderIsSent() async {
        serve(total: 1)
        let model = SearchModel(api: AppFixtures.client())
        model.scopeFolderId = "d-Docs"
        model.query = "kum"
        model.queryChanged()
        _ = await eventually { !model.hits.isEmpty }
        XCTAssertEqual(searches.last.map(AppFixtures.query)?["folder"], "d-Docs")
    }

    func testOfflineState() async {
        MockURLProtocol.reset { _ in .failure(.notConnectedToInternet) }
        let model = SearchModel(api: AppFixtures.client())
        model.query = "kum"
        model.queryChanged()
        let offline = await eventually { model.state == .offline }
        XCTAssertTrue(offline)
    }

    func testHighlightedRemovesMarkers() {
        let text = SearchModel.highlighted("a «b» c")
        XCTAssertEqual(String(text.characters), "a b c")
        for run in text.runs {
            let part = String(text[run.range].characters)
            let bold = run.inlinePresentationIntent?.contains(.stronglyEmphasized) ?? false
            XCTAssertEqual(bold, part == "b", "run \(part)")
        }
        XCTAssertEqual(text.runs.count, 3)
    }

    func testHighlightedWithoutMarkersAndUnclosed() {
        XCTAssertEqual(String(SearchModel.highlighted("plain").characters), "plain")
        XCTAssertEqual(String(SearchModel.highlighted("x «y").characters), "x y")
    }
}
