import Foundation
import SyncletKit
import XCTest
@testable import Synclet

final class MutationErrorsTests: XCTestCase {
    func testOutcomes() {
        XCTAssertEqual(MutationErrors.outcome(for: SyncAPIError.conflict(current: nil)), .conflictReloaded)
        XCTAssertEqual(MutationErrors.outcome(for: SyncAPIError.nameConflict(existing: nil)), .nameTaken)
        XCTAssertEqual(MutationErrors.outcome(for: SyncAPIError.notFound), .gone)
        XCTAssertEqual(MutationErrors.outcome(for: SyncAPIError.invalidName(message: "Bad name")), .invalidName("Bad name"))
        XCTAssertEqual(MutationErrors.outcome(for: SyncAPIError.transport(.notConnectedToInternet, message: "x")), .offline)
        XCTAssertEqual(MutationErrors.outcome(for: URLError(.timedOut)), .offline)
        guard case .invalidName(let fallback) = MutationErrors.outcome(for: SyncAPIError.invalidName(message: nil)) else {
            return XCTFail("invalidName without message")
        }
        XCTAssertFalse(fallback.isEmpty)
        guard case .failed(let message) = MutationErrors.outcome(for: SyncAPIError.invalidMove(message: "into itself")) else {
            return XCTFail("invalidMove")
        }
        XCTAssertEqual(message, "into itself")
        guard case .failed(let forbidden) = MutationErrors.outcome(for: SyncAPIError.forbidden(message: nil)) else {
            return XCTFail("forbidden")
        }
        XCTAssertFalse(forbidden.isEmpty)
    }

    func testMessages() {
        XCTAssertNil(MutationErrors.message(.ok))
        XCTAssertEqual(MutationErrors.message(.invalidName("Bad")), "Bad")
        XCTAssertEqual(MutationErrors.message(.failed("Boom")), "Boom")
        for outcome: MutationOutcome in [.conflictReloaded, .nameTaken, .gone, .offline] {
            XCTAssertFalse((MutationErrors.message(outcome) ?? "").isEmpty, "\(outcome)")
        }
    }
}
