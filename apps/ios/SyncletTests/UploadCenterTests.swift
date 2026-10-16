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
        XCTAssertEqual(UploadFailure.readOnly.displayText, String(localized: "Read Only"))
        XCTAssertEqual(UploadFailure.spaceUnavailable.displayText, String(localized: "Space Not Available"))
        let german = Bundle(path: Bundle(for: AccountsModel.self).path(forResource: "de", ofType: "lproj") ?? "")
        XCTAssertEqual(german?.localizedString(forKey: "Space Not Available", value: nil, table: nil), "Bereich nicht verfügbar")
        XCTAssertEqual(german?.localizedString(forKey: "Read Only", value: nil, table: nil), "Nur lesen")
    }
}
