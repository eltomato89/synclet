import SyncletKit
import XCTest
@testable import Synclet

@MainActor
final class UploadCenterTests: XCTestCase {
    private var directory: URL!
    private var queue: UploadQueue!
    private var driver: FakeUploadDriver!
    private var signals: SignalRecorder!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "synclet-uploads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        queue = UploadQueue(directory: directory.appending(path: "uploads"))
        driver = FakeUploadDriver()
        signals = SignalRecorder()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeCenter() -> UploadCenter {
        let driver = driver!
        return UploadCenter(queue: queue, signal: signals.callback) { _ in driver }
    }

    private func tempFile(_ name: String, _ text: String) throws -> URL {
        let url = directory.appending(path: "source-\(UUID().uuidString)").appending(path: name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        return url
    }

    func testEnqueueURLsCopiesAndPumps() async throws {
        let center = makeCenter()
        let a = try tempFile("a.txt", "hello")
        let b = try tempFile("b.pdf", "world!")

        await center.enqueue(urls: [a, b], accountKey: "k1", parentId: "root", parentName: "Meine Dateien")

        XCTAssertEqual(Set(center.entries.map(\.name)), ["a.txt", "b.pdf"])
        XCTAssertTrue(center.entries.allSatisfy { [.waiting, .uploading].contains($0.status) })
        XCTAssertTrue(center.entries.allSatisfy { $0.accountKey == "k1" && $0.parentId == "root" && $0.parentName == "Meine Dateien" })
        for entry in center.entries {
            XCTAssertTrue(FileManager.default.fileExists(atPath: queue.fileURL(for: entry.id).path))
        }
        XCTAssertEqual(center.activeCount, 2)
        let pumped = await eventually { self.driver.pumps >= 1 }
        XCTAssertTrue(pumped)
    }

    func testEnqueueSkipsFolders() async throws {
        let center = makeCenter()
        let folder = directory.appending(path: "a-folder", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        await center.enqueue(urls: [folder], accountKey: "k1", parentId: "root", parentName: "Meine Dateien")

        XCTAssertTrue(center.entries.isEmpty)
        XCTAssertNotNil(center.notice)
    }

    func testSignOutRemovesAccountUploads() async throws {
        let harness = Harness()
        defer { harness.cleanUp() }
        let a = FakeSynclet(serverId: "srvA")
        let b = FakeSynclet(serverId: "srvB")
        Harness.serve(["a.example.test": a, "b.example.test": b])
        let first = try await harness.accounts.add(server: URL(string: "https://a.example.test")!, tokens: harness.tokens(a))
        let second = try await harness.accounts.add(server: URL(string: "https://b.example.test")!, tokens: harness.tokens(b))
        let center = makeCenter()
        center.bind(to: harness.accounts)
        await center.enqueue(urls: [try tempFile("1.txt", "1")], accountKey: first.key, parentId: "root", parentName: "Meine Dateien")
        await center.enqueue(urls: [try tempFile("2.txt", "2")], accountKey: second.key, parentId: "root", parentName: "Meine Dateien")
        XCTAssertEqual(center.entries.count, 2)

        await harness.accounts.signOut(key: first.key)

        XCTAssertEqual(center.entries.map(\.accountKey), [second.key])
        XCTAssertEqual(queue.all().map(\.accountKey), [second.key])
    }

    func testFailedCountAndRetry() async throws {
        let center = makeCenter()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { e in
            e.status = .failed
            e.failure = .targetGone
        }
        center.reload()
        XCTAssertEqual(center.failedCount, 1)
        XCTAssertEqual(center.activeCount, 0)
        let pumpsBefore = driver.pumps

        center.retry(entry.id)

        XCTAssertEqual(center.failedCount, 0)
        XCTAssertEqual(center.entries.first?.status, .waiting)
        XCTAssertNil(center.entries.first?.failure)
        let pumped = await eventually { self.driver.pumps > pumpsBefore }
        XCTAssertTrue(pumped)
    }

    func testCancelGoesThroughTheUploader() async throws {
        let center = makeCenter()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        center.reload()

        await center.cancel(entry.id)

        XCTAssertEqual(driver.cancelled, [entry.id])
    }

    // MARK: Share extension session (final review, finding 2)

    private func makeCenterWithShare() -> (UploadCenter, () -> [FakeUploadDriver]) {
        let driver = driver!
        var made: [FakeUploadDriver] = []
        let center = UploadCenter(queue: queue, signal: signals.callback,
                                  shareUploader: { _ in let d = FakeUploadDriver(); made.append(d); return d },
                                  uploader: { _ in driver })
        return (center, { made })
    }

    private func shareOwnedEntry(_ name: String = "s.txt", accountKey: String = "k1") throws -> UploadEntry {
        let entry = try queue.enqueue(source: try tempFile(name, "x"), name: name, accountKey: accountKey,
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { e in
            e.status = .uploading
            e.owner = UploadSignal.shareSessionIdentifier
            e.leaseUntil = Date().addingTimeInterval(3600)
        }
        return entry
    }

    func testCancellingAShareUploadCancelsItInTheShareSessionAndGivesItBack() async throws {
        let (center, shares) = makeCenterWithShare()
        let entry = try shareOwnedEntry()
        center.reload()

        await center.cancel(entry.id)

        XCTAssertEqual(shares().count, 1)
        XCTAssertEqual(shares().first?.cancelled, [entry.id])
        XCTAssertEqual(shares().first?.relinquished, 1)
        XCTAssertEqual(driver.cancelled, [entry.id])
    }

    func testCancellingAnAppUploadLeavesTheShareSessionAlone() async throws {
        let (center, shares) = makeCenterWithShare()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { e in e.status = .uploading; e.owner = UploadSignal.appSessionIdentifier }
        center.reload()

        await center.cancel(entry.id)

        XCTAssertTrue(shares().isEmpty)
        XCTAssertEqual(driver.cancelled, [entry.id])
    }

    func testSignOutCancelsShareUploadsInTheShareSession() async throws {
        let (center, shares) = makeCenterWithShare()
        let mine = try shareOwnedEntry("a.txt", accountKey: "k1")
        let other = try shareOwnedEntry("b.txt", accountKey: "k2")
        center.reload()

        await center.accountSignedOut("k1")

        XCTAssertEqual(shares().first?.cancelled, [mine.id])
        XCTAssertEqual(shares().first?.relinquished, 1)
        XCTAssertEqual(queue.all().map(\.id), [other.id])
    }

    func testShareSessionEventsAreDrainedThenTheSessionIsGivenBack() async throws {
        let (center, shares) = makeCenterWithShare()
        let handled = expectation(description: "system handler")
        center.handleBackgroundEvents(identifier: UploadSignal.shareSessionIdentifier) { handled.fulfill() }
        await fulfillment(of: [handled], timeout: 3)
        XCTAssertEqual(shares().count, 1)
        XCTAssertEqual(shares().first?.relinquished, 1)

        // Invalid: dropped; the next delivery attaches a fresh uploader.
        shares().first?.isInvalidated = true
        center.shareUploaderInvalidated()
        XCTAssertNil(center.shareUploader)
        let again = expectation(description: "second handler")
        center.handleBackgroundEvents(identifier: UploadSignal.shareSessionIdentifier) { again.fulfill() }
        await fulfillment(of: [again], timeout: 3)
        XCTAssertEqual(shares().count, 2)
    }

    func testCancelDuringShareEventsWaitsForTheEventsBeforeGivingTheSessionBack() async throws {
        let (center, shares) = makeCenterWithShare()
        let entry = try shareOwnedEntry()
        center.reload()
        let handled = expectation(description: "system handler")
        center.handleBackgroundEvents(identifier: UploadSignal.shareSessionIdentifier) { handled.fulfill() }
        let share = try XCTUnwrap(shares().first)
        share.holdEvents = true
        // The fake answered the first handler right away; hold the next delivery.
        await fulfillment(of: [handled], timeout: 3)
        let relinquishedBefore = share.relinquished
        let second = expectation(description: "second handler")
        center.handleBackgroundEvents(identifier: UploadSignal.shareSessionIdentifier) { second.fulfill() }
        await center.cancel(entry.id)
        XCTAssertEqual(share.cancelled, [entry.id])
        XCTAssertEqual(share.relinquished, relinquishedBefore, "not while the system's handler is outstanding")
        share.finishEvents()
        await fulfillment(of: [second], timeout: 3)
        XCTAssertEqual(share.relinquished, relinquishedBefore + 1)
    }

    func testShareUploaderChangesWakeTheAppUploader() async throws {
        let (center, _) = makeCenterWithShare()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        let before = driver.pumps
        center.shareUploaderChanged(entry)
        let pumped = await eventually { self.driver.pumps > before }
        XCTAssertTrue(pumped)
    }

    func testFinishedUploadSignalsWorkingSet() async throws {
        let center = makeCenter()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { $0.status = .uploading }
        center.reload()

        let done = queue.update(id: entry.id) { e in
            e.status = .done
            e.finishedAt = Date()
        }!
        center.uploaderChanged(done)
        center.uploaderChanged(done)

        let signalled = await eventually { !self.signals.keys.isEmpty }
        XCTAssertTrue(signalled)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(signals.keys, ["k1"])
    }

    func testDoneEntriesAtLaunchAreNotSignalled() async throws {
        let entry = try queue.enqueue(source: try tempFile("x.txt", "x"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { e in
            e.status = .done
            e.finishedAt = Date()
        }
        let center = makeCenter()
        center.reload()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(signals.keys, [])
    }

    func testProgressFraction() async throws {
        let center = makeCenter()
        let entry = try queue.enqueue(source: try tempFile("x.txt", "0123456789"), name: "x.txt", accountKey: "k1",
                                      parentId: "root", parentName: "Meine Dateien")
        queue.update(id: entry.id) { $0.status = .uploading }
        center.reload()

        center.uploaderProgress(entryId: entry.id, bytesSent: 5)

        XCTAssertEqual(center.fraction(for: center.entries[0]) ?? -1, 0.5, accuracy: 0.001)
    }

    func testFailureTexts() {
        XCTAssertEqual(UploadFailure.insufficientStorage.displayText, String(localized: "Storage Full"))
        XCTAssertEqual(UploadFailure.targetGone.displayText, String(localized: "Target Folder Deleted"))
        XCTAssertEqual(UploadFailure.signedOut.displayText, String(localized: "Sign In Again"))
        XCTAssertEqual(UploadFailure.other.displayText, String(localized: "Error"))
    }
}
