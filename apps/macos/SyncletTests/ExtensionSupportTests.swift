import FileProvider
import XCTest
@testable import Synclet

/// `Shared/` code of the extension (compiled into the app as well).
final class ExtensionSupportTests: XCTestCase {
    func testIsAuthenticationFailure() {
        XCTAssertTrue(AuthFailureSignal.isAuthenticationFailure(NSFileProviderError(.notAuthenticated)))
        XCTAssertFalse(AuthFailureSignal.isAuthenticationFailure(NSFileProviderError(.serverUnreachable)))
        XCTAssertFalse(AuthFailureSignal.isAuthenticationFailure(CocoaError(.fileWriteNoPermission)))
    }

    func testSignallingEnumeratorReportsErrorsAndPassesResultsThrough() {
        let inner = FakeEnumerator(itemsError: NSFileProviderError(.notAuthenticated))
        var reported: [Error] = []
        let enumerator = SignallingEnumerator(inner: inner) { reported.append($0) }

        let items = ItemObserver()
        enumerator.enumerateItems(for: items, startingAt: NSFileProviderPage.initialPageSortedByName as NSFileProviderPage)
        XCTAssertEqual((items.error as NSError?)?.code, NSFileProviderError.notAuthenticated.rawValue)
        XCTAssertEqual(reported.count, 1)

        let changes = ChangeObserver()
        enumerator.enumerateChanges(for: changes, from: NSFileProviderSyncAnchor(Data("a".utf8)))
        XCTAssertEqual(changes.finishedAnchor, NSFileProviderSyncAnchor(Data("b".utf8)))
        XCTAssertEqual(reported.count, 1)
    }

    func testSignallingEnumeratorWithoutChangeTrackingExpiresTheAnchor() {
        let enumerator = SignallingEnumerator(inner: ItemsOnlyEnumerator()) { _ in }
        let changes = ChangeObserver()
        enumerator.enumerateChanges(for: changes, from: NSFileProviderSyncAnchor(Data("a".utf8)))
        XCTAssertEqual((changes.error as NSError?)?.code, NSFileProviderError.syncAnchorExpired.rawValue)
        let anchor = expectation(description: "anchor")
        enumerator.currentSyncAnchor { value in
            XCTAssertNil(value)
            anchor.fulfill()
        }
        wait(for: [anchor], timeout: 1)
    }
}

private final class FakeEnumerator: NSObject, NSFileProviderEnumerator {
    let itemsError: Error
    init(itemsError: Error) { self.itemsError = itemsError }
    func invalidate() {}
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.finishEnumeratingWithError(itemsError)
    }
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Data("b".utf8)), moreComing: false)
    }
    func currentSyncAnchor(completionHandler: @escaping @Sendable (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("b".utf8)))
    }
}

private final class ItemsOnlyEnumerator: NSObject, NSFileProviderEnumerator {
    func invalidate() {}
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        observer.finishEnumerating(upTo: nil)
    }
}

private final class ItemObserver: NSObject, NSFileProviderEnumerationObserver {
    var error: Error?
    func didEnumerate(_ updatedItems: [NSFileProviderItemProtocol]) {}
    func finishEnumerating(upTo nextPage: NSFileProviderPage?) {}
    func finishEnumeratingWithError(_ error: Error) { self.error = error }
}

private final class ChangeObserver: NSObject, NSFileProviderChangeObserver {
    var error: Error?
    var finishedAnchor: NSFileProviderSyncAnchor?
    func didUpdate(_ updatedItems: [NSFileProviderItemProtocol]) {}
    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {}
    func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) { finishedAnchor = anchor }
    func finishEnumeratingWithError(_ error: Error) { self.error = error }
}
