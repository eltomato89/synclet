import FileProvider
import XCTest
@testable import SyncletKit

final class AuthFailureSignalTests: XCTestCase {
    private var container: URL!

    override func setUp() {
        container = FileManager.default.temporaryDirectory.appending(path: "synclet-signal-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: container)
    }

    func testIsAuthenticationFailure() {
        XCTAssertTrue(AuthFailureSignal.isAuthenticationFailure(NSFileProviderError(.notAuthenticated)))
        XCTAssertFalse(AuthFailureSignal.isAuthenticationFailure(NSFileProviderError(.serverUnreachable)))
        XCTAssertFalse(AuthFailureSignal.isAuthenticationFailure(CocoaError(.fileWriteNoPermission)))
    }

    func testRoundTripThroughTheAppGroupDirectory() throws {
        let key16 = AccountStore.key16(for: "srv1:u1")
        // Signed out (no account directory) ⇒ nothing is written.
        XCTAssertFalse(AuthFailureSignal.report(container: container, key16: key16, post: false))
        XCTAssertNil(AuthFailureSignal.pending(container: container, key16: key16))

        try FileManager.default.createDirectory(
            at: container.appending(path: "accounts/\(key16)"), withIntermediateDirectories: true)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(AuthFailureSignal.report(container: container, key16: key16, now: start, post: false))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: container.appending(path: "accounts/\(key16)/auth-failed").path))
        XCTAssertEqual(AuthFailureSignal.pending(container: container, key16: key16), start)

        // Throttled within a minute, accepted after.
        XCTAssertFalse(AuthFailureSignal.report(container: container, key16: key16, now: start.addingTimeInterval(30), post: false))
        XCTAssertEqual(AuthFailureSignal.pending(container: container, key16: key16), start)
        XCTAssertTrue(AuthFailureSignal.report(container: container, key16: key16, now: start.addingTimeInterval(61), post: false))
        XCTAssertEqual(AuthFailureSignal.pending(container: container, key16: key16), start.addingTimeInterval(61))

        AuthFailureSignal.clear(container: container, key16: key16)
        XCTAssertNil(AuthFailureSignal.pending(container: container, key16: key16))
    }

    /// M3: a 401 of a request that started with the previous (revoked) token, arriving after
    /// the new sign-in, neither writes a marker nor counts as pending.
    func testFailureOfAnOperationOlderThanTheSignInIsIgnored() throws {
        let signedInAt = Date(timeIntervalSince1970: 1_800_000_000)
        let store = AccountStore(directory: container)
        let stored = try store.upsert(StoredAccount(key: "srv1:u1", serverURL: URL(string: "https://synclet.example.test")!,
                                                    userId: "u1", username: "jens", displayName: "Jens", spaces: [.personal()],
                                                    signedInAt: signedInAt))
        let late = signedInAt.addingTimeInterval(5)
        XCTAssertFalse(AuthFailureSignal.report(container: container, key16: stored.key16, now: late,
                                                startedAt: signedInAt.addingTimeInterval(-2), post: false))
        XCTAssertNil(AuthFailureSignal.pending(container: container, key16: stored.key16))

        // A marker that is already there from before the sign-in is stale too (and removed).
        let marker = AuthFailureSignal.markerURL(container: container, key16: stored.key16)
        try Data("2027-01-15T07:59:00Z".utf8).write(to: marker)
        XCTAssertNil(AuthFailureSignal.pending(container: container, key16: stored.key16))
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))

        // An operation that started after the sign-in counts.
        XCTAssertTrue(AuthFailureSignal.report(container: container, key16: stored.key16, now: late,
                                               startedAt: signedInAt.addingTimeInterval(1), post: false))
        XCTAssertEqual(AuthFailureSignal.pending(container: container, key16: stored.key16), signedInAt.addingTimeInterval(1))
    }

    func testDarwinNotificationReachesAnObserver() {
        let received = expectation(description: "darwin notification")
        let box = Unmanaged.passRetained(received)
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), box.toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<XCTestExpectation>.fromOpaque(observer).takeUnretainedValue().fulfill()
            },
            AuthFailureSignal.notificationName as CFString, nil, .deliverImmediately)
        AuthFailureSignal.postNotification()
        wait(for: [received], timeout: 5)
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), box.toOpaque())
        box.release()
    }
}
