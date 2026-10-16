import Foundation
import XCTest
@testable import Synclet

final class ErrorLogTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-errorlog-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    static func entry(_ index: Int, account: String = "srv1:u1", code: String = "too_large",
                      date: Date = Date(timeIntervalSince1970: 1_791_000_000)) -> ErrorLogEntry {
        ErrorLogEntry(date: date.addingTimeInterval(Double(index)), accountKey: account, fileName: "Datei \(index).mov",
                      message: "Zu groß für den Server – nicht hochgeladen.", code: code, itemIdentifier: "f_\(index)")
    }

    func testRoundTripAsJSONLinesInTheContainer() throws {
        let log = ErrorLog(container: directory)
        log.append(Self.entry(1), post: false)
        log.append(Self.entry(2, code: "conflict_copy"), post: false)
        XCTAssertEqual(log.url, directory.appending(path: "error-log.jsonl"))
        let lines = try String(contentsOf: log.url, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        let first = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any])
        XCTAssertEqual(Set(first.keys), ["v", "date", "accountKey", "fileName", "message", "code", "itemIdentifier"])
        XCTAssertEqual(first["v"] as? Int, 1)
        XCTAssertEqual(first["date"] as? String, "2026-10-03T04:00:01Z")
        XCTAssertEqual(log.entries(), [Self.entry(1), Self.entry(2, code: "conflict_copy")])
        XCTAssertTrue(log.entries()[1].isInfo)
        XCTAssertFalse(log.entries()[0].isInfo)
    }

    func testKeepsTheLast20() {
        let log = ErrorLog(container: directory)
        for index in 1...25 { log.append(Self.entry(index), post: false) }
        let entries = log.entries()
        XCTAssertEqual(entries.count, 20)
        XCTAssertEqual(entries.first?.fileName, "Datei 6.mov")
        XCTAssertEqual(entries.last?.fileName, "Datei 25.mov")
    }

    func testSameFileAndCodeReplacesTheOlderEntry() {
        let log = ErrorLog(container: directory)
        var retry = Self.entry(1)
        log.append(retry, post: false)
        log.append(Self.entry(2), post: false)
        retry.date = retry.date.addingTimeInterval(600)
        log.append(retry, post: false)
        XCTAssertEqual(log.entries().map(\.fileName), ["Datei 2.mov", "Datei 1.mov"])
        // Another code or account for the same file is a separate entry.
        var other = retry
        other.code = "insufficient_storage"
        log.append(other, post: false)
        other.accountKey = "srv2:u1"
        log.append(other, post: false)
        XCTAssertEqual(log.entries().count, 4)
    }

    func testMalformedLinesAreSkipped() throws {
        let log = ErrorLog(container: directory)
        log.append(Self.entry(1), post: false)
        var text = try String(contentsOf: log.url, encoding: .utf8)
        text += "{not json\n\n{\"date\":\"2026-10-02T17:46:41Z\"}\n"
        try text.write(to: log.url, atomically: true, encoding: .utf8)
        XCTAssertEqual(log.entries(), [Self.entry(1)])
        log.append(Self.entry(2), post: false)
        XCTAssertEqual(log.entries(), [Self.entry(1), Self.entry(2)])
        XCTAssertFalse(try String(contentsOf: log.url, encoding: .utf8).contains("not json"))
    }

    func testMissingFileIsEmpty() {
        XCTAssertEqual(ErrorLog(container: directory.appending(path: "nowhere")).entries(), [])
    }

    func testConcurrentAppendsFromSeveralWritersLoseNothing() {
        // Each writer opens its own lock descriptor, like separate extension processes.
        let container = directory!
        DispatchQueue.concurrentPerform(iterations: 18) { index in
            ErrorLog(container: container).append(Self.entry(index), post: false)
        }
        let names = Set(ErrorLog(container: container).entries().map(\.fileName))
        XCTAssertEqual(names, Set((0..<18).map { "Datei \($0).mov" }))
    }

    func testConcurrentAppendsAboveTheCapKeepExactly20() {
        let container = directory!
        DispatchQueue.concurrentPerform(iterations: 60) { index in
            ErrorLog(container: container).append(Self.entry(index), post: false)
        }
        XCTAssertEqual(ErrorLog(container: container).entries().count, 20)
    }

    func testRemoveAccountAndClear() {
        let log = ErrorLog(container: directory)
        log.append(Self.entry(1), post: false)
        log.append(Self.entry(2, account: "srv2:u1"), post: false)
        log.remove(accountKey: "srv1:u1", post: false)
        XCTAssertEqual(log.entries().map(\.accountKey), ["srv2:u1"])
        log.clear(post: false)
        XCTAssertEqual(log.entries(), [])
    }

    func testAppendPostsTheDarwinNotification() {
        let expectation = expectation(description: "notification")
        let observer = DarwinObserver(name: ErrorLog.notificationName) { expectation.fulfill() }
        ErrorLog(container: directory).append(Self.entry(1))
        wait(for: [expectation], timeout: 2)
        withExtendedLifetime(observer) {}
    }
}

/// Observes a Darwin notification for the lifetime of the object.
final class DarwinObserver: @unchecked Sendable {
    private let handler: () -> Void
    private let name: String

    init(name: String, handler: @escaping () -> Void) {
        self.name = name
        self.handler = handler
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<DarwinObserver>.fromOpaque(observer).takeUnretainedValue().handler()
            },
            name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }
}
