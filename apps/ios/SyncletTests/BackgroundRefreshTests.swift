import FileProvider
import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class BackgroundRefreshTests: XCTestCase {
    func testRefreshSignalsTheWorkingSetOfEveryDomain() async {
        let domains = FakeDomains()
        await BackgroundRefresh.signalWorkingSets(domainIdentifiers: ["aaaa", "bbbb"], domains: domains)
        XCTAssertEqual(domains.signalled.map(\.domain), ["aaaa", "bbbb"])
        XCTAssertEqual(domains.signalled.map(\.container), [.workingSet, .workingSet])
    }

    func testRequestStartsIn30MinutesAtTheEarliest() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let request = BackgroundRefresh.makeRequest(now: now)
        XCTAssertEqual(request.identifier, "tech.jensk.synclet.ios.refresh")
        XCTAssertEqual(request.earliestBeginDate, now.addingTimeInterval(30 * 60))
    }
}
