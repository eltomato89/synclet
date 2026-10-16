import XCTest
@testable import SyncletKit

final class UploadQueueTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var t: Date
        init(_ t: Date) { self.t = t }
        var now: Date { lock.withLock { t } }
        func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
    }

    private func enqueue(_ q: UploadQueue, _ name: String = "a.txt", account: String = "k") throws -> UploadEntry {
        try q.enqueue(source: Fixtures.tempFile("hello"), name: name, accountKey: account, parentId: "root", parentName: "M")
    }

    func testEnqueueCopiesSourceSoDeletingSourceIsHarmless() throws {
        let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
        let src = Fixtures.tempFile("hello")
        let e = try q.enqueue(source: src, name: "a.txt", accountKey: "k", parentId: "root", parentName: "Meine Dateien")
        try FileManager.default.removeItem(at: src)
        XCTAssertEqual(try String(contentsOf: q.fileURL(for: e.id), encoding: .utf8), "hello")
        XCTAssertEqual(e.status, .waiting); XCTAssertEqual(e.size, 5)
    }

    func testPersistsAcrossInstances() throws {
        let dir = Fixtures.tempDirectory()
        let e = try enqueue(UploadQueue(directory: dir))
        let q2 = UploadQueue(directory: dir)
        XCTAssertEqual(q2.all(), [e])
        XCTAssertEqual(q2.entry(id: e.id), e)
    }

    func testWritesVersionedJSON() throws {
        let dir = Fixtures.tempDirectory()
        _ = try enqueue(UploadQueue(directory: dir))
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appending(path: "queue.json"))) as? [String: Any]
        XCTAssertEqual(json?["v"] as? Int, 1)
        XCTAssertEqual((json?["entries"] as? [Any])?.count, 1)
    }

    private func corruptFiles(_ dir: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("queue.json.corrupt-") }
    }

    func testCorruptFileIsSetAsideAndQueueStartsEmpty() throws {
        let dir = Fixtures.tempDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: dir.appending(path: "queue.json"))
        let q = UploadQueue(directory: dir)
        XCTAssertEqual(q.all(), [])
        XCTAssertEqual(try corruptFiles(dir).count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appending(path: "queue.json").path))
    }

    func testUnknownVersionIsSetAside() throws {
        let dir = Fixtures.tempDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"v":99,"entries":[]}"#.utf8).write(to: dir.appending(path: "queue.json"))
        let q = UploadQueue(directory: dir)
        XCTAssertEqual(q.all(), [])
        XCTAssertEqual(try corruptFiles(dir).count, 1)
    }

    func testCorruptQueuePrunesOrphanCopies() throws {
        let dir = Fixtures.tempDirectory()
        let q = UploadQueue(directory: dir)
        let e = try enqueue(q)
        try Data("garbage".utf8).write(to: dir.appending(path: "queue.json"))
        XCTAssertEqual(q.all(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
    }

    func testConcurrentEnqueueFromTwoStoresKeepsAll() async throws {
        let dir = Fixtures.tempDirectory(); let a = UploadQueue(directory: dir), b = UploadQueue(directory: dir)
        let src = Fixtures.tempFile("x")
        await withTaskGroup(of: Void.self) { g in
            for i in 0..<40 { let q = i.isMultiple(of: 2) ? a : b
                g.addTask { _ = try? q.enqueue(source: src, name: "f\(i)", accountKey: "k", parentId: "root", parentName: "M") } }
        }
        XCTAssertEqual(a.all().count, 40)
    }

    func testRunnableRespectsNextAttemptAndOrder() throws {
        let clock = Clock(Date(timeIntervalSince1970: 1_800_000_000))
        let q = UploadQueue(directory: Fixtures.tempDirectory(), now: { clock.now })
        let e1 = try enqueue(q, "1"); clock.advance(1)
        let e2 = try enqueue(q, "2"); clock.advance(1)
        let e3 = try enqueue(q, "3"); clock.advance(1)
        let e4 = try enqueue(q, "4")
        q.update(id: e2.id) { $0.nextAttemptAt = clock.now.addingTimeInterval(60) }
        q.update(id: e3.id) { $0.nextAttemptAt = clock.now.addingTimeInterval(-5) }
        q.update(id: e4.id) { $0.status = .uploading }
        XCTAssertEqual(q.runnable().map(\.id), [e1.id, e3.id])
        XCTAssertEqual(q.all().map(\.id), [e4.id, e3.id, e2.id, e1.id])
        clock.advance(120)
        XCTAssertEqual(q.runnable().map(\.id), [e1.id, e2.id, e3.id])
    }

    func testRetryResetsFailure() throws {
        let q = UploadQueue(directory: Fixtures.tempDirectory())
        let e = try enqueue(q)
        q.update(id: e.id) { $0.status = .failed; $0.failure = .network; $0.failureMessage = "x"; $0.attempts = 10 }
        q.retry(id: e.id)
        let r = q.entry(id: e.id)
        XCTAssertEqual(r?.status, .waiting); XCTAssertEqual(r?.attempts, 0)
        XCTAssertNil(r?.failure); XCTAssertNil(r?.failureMessage); XCTAssertNil(r?.nextAttemptAt)
    }

    func testPruneDropsOldDoneAndOrphans() throws {
        let clock = Clock(Date(timeIntervalSince1970: 1_800_000_000))
        let q = UploadQueue(directory: Fixtures.tempDirectory(), now: { clock.now })
        let old = try enqueue(q, "old"), recent = try enqueue(q, "recent"), waiting = try enqueue(q, "w")
        q.update(id: old.id) { $0.status = .done; $0.finishedAt = clock.now.addingTimeInterval(-25 * 3600) }
        q.update(id: recent.id) { $0.status = .done; $0.finishedAt = clock.now.addingTimeInterval(-3600) }
        let orphan = q.fileURL(for: "random-orphan")
        try Data("o".utf8).write(to: orphan)
        q.prune()
        let fm = FileManager.default
        XCTAssertNil(q.entry(id: old.id))
        XCTAssertNotNil(q.entry(id: recent.id))
        XCTAssertFalse(fm.fileExists(atPath: q.fileURL(for: old.id).path))
        XCTAssertFalse(fm.fileExists(atPath: q.fileURL(for: recent.id).path))
        XCTAssertFalse(fm.fileExists(atPath: orphan.path))
        XCTAssertTrue(fm.fileExists(atPath: q.fileURL(for: waiting.id).path))
    }

    func testRemoveAllForAccount() throws {
        let q = UploadQueue(directory: Fixtures.tempDirectory())
        let a = try enqueue(q, "a", account: "k1"), b = try enqueue(q, "b", account: "k2")
        q.removeAll(accountKey: "k1")
        XCTAssertEqual(q.all().map(\.id), [b.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: q.fileURL(for: a.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: q.fileURL(for: b.id).path))
    }

    func testRemoveDeletesEntryAndCopy() throws {
        let q = UploadQueue(directory: Fixtures.tempDirectory())
        let e = try enqueue(q)
        q.remove(id: e.id)
        XCTAssertTrue(q.all().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
    }

    func testEnqueueUnreadableSourceThrowsAndLeavesNoEntry() {
        let q = UploadQueue(directory: Fixtures.tempDirectory())
        XCTAssertThrowsError(try q.enqueue(source: URL(fileURLWithPath: "/nonexistent/zzz"), name: "n", accountKey: "k", parentId: "r", parentName: "M"))
        XCTAssertTrue(q.all().isEmpty)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: q.filesDirectory.path)) ?? []
        XCTAssertTrue(files.isEmpty)
    }

    func testStagingFileIsNotPrunedWhileYoungButWhenStale() throws {
        let clock = Clock(Date())
        let dir = Fixtures.tempDirectory()
        let q = UploadQueue(directory: dir, now: { clock.now })
        let staging = dir.appending(path: "staging", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let f = staging.appending(path: "inflight")
        try Data("partial".utf8).write(to: f)
        _ = q.all(); q.prune()
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.path))
        clock.advance(25 * 3600)
        q.prune()
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.path))
    }

    func testEnqueueMovesStagedCopyIntoFiles() throws {
        // A source that is a FIFO-less large file is impractical; assert instead that after enqueue
        // nothing remains in staging and the copy ended up in files/.
        let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
        let e = try enqueue(q)
        let staged = (try? FileManager.default.contentsOfDirectory(atPath: dir.appending(path: "staging").path)) ?? []
        XCTAssertTrue(staged.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
    }

    func testUnreadableQueueFileKeepsCopiesAndCreatesNoCorruptFile() throws {
        let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
        let e = try enqueue(q)
        let qf = dir.appending(path: "queue.json").path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: qf)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: qf) }
        if geteuid() == 0 { throw XCTSkip("root ignores file modes") }
        XCTAssertEqual(q.all(), [])
        q.prune()
        XCTAssertNil(q.update(id: e.id) { $0.name = "x" })
        XCTAssertThrowsError(try enqueue(q))
        XCTAssertTrue(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
        XCTAssertEqual(try corruptFiles(dir).count, 0)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: qf)
        XCTAssertEqual(q.all().map(\.id), [e.id])
        XCTAssertEqual(q.entry(id: e.id)?.name, "a.txt")
    }

    func testEntryWithoutOwnerFieldsDecodes() throws {
        let dir = Fixtures.tempDirectory()
        // Written by a build before `owner`/`leaseUntil` existed.
        let json = #"{"v":1,"entries":[{"id":"e1","accountKey":"k","parentId":"root","parentName":"M","name":"a.txt","size":5,"status":"uploading","attempts":0,"tusOffset":0,"createdAt":"2026-10-16T08:00:00.000Z"}]}"#
        try Data(json.utf8).write(to: dir.appending(path: "queue.json"))
        let e = try XCTUnwrap(UploadQueue(directory: dir).entry(id: "e1"))
        XCTAssertEqual(e.status, .uploading)
        XCTAssertNil(e.owner)
        XCTAssertNil(e.leaseUntil)
    }

    func testOwnerAndLeaseRoundTripAndRetryClearsThem() throws {
        let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
        let e = try enqueue(q)
        let lease = Date(timeIntervalSince1970: 1_800_000_600)
        q.update(id: e.id) { $0.status = .uploading; $0.owner = "tech.jensk.synclet.upload.share"; $0.leaseUntil = lease }
        let read = try XCTUnwrap(UploadQueue(directory: dir).entry(id: e.id))
        XCTAssertEqual(read.owner, "tech.jensk.synclet.upload.share")
        XCTAssertEqual(read.leaseUntil, lease)
        XCTAssertTrue(q.runnable().isEmpty, "uploading entries are never runnable")
        q.update(id: e.id) { $0.status = .failed }
        q.retry(id: e.id)
        let retried = try XCTUnwrap(q.entry(id: e.id))
        XCTAssertNil(retried.owner); XCTAssertNil(retried.leaseUntil)
        XCTAssertEqual(q.runnable().map(\.id), [e.id])
    }

    /// A remove whose queue write fails keeps the entry and its copy together.
    func testRemoveKeepsTheCopyWhenTheWriteFails() throws {
        let dir = Fixtures.tempDirectory(); let q = UploadQueue(directory: dir)
        let e = try enqueue(q)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        q.remove(id: e.id)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        XCTAssertNotNil(q.entry(id: e.id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
        q.remove(id: e.id)
        XCTAssertNil(q.entry(id: e.id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: q.fileURL(for: e.id).path))
    }
}
