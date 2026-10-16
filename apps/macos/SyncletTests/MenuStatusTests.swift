import FileProvider
import Foundation
import SyncletKit
import XCTest
@testable import Synclet

/// A monitor stand-in (Task 6's `ChangeMonitor` conforms the same way).
struct FakeStatus: AccountStatusProviding {
    var connectionState: SyncConnectionState
    var lastSync: Date?
}

@MainActor
final class MenuStatusTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_791_000_000)
    let key = "srv1:u1"

    private func problem(minutesAgo: Double, code: String = "too_large", account: String = "srv1:u1") -> ErrorLogEntry {
        ErrorLogEntry(date: now.addingTimeInterval(-minutesAgo * 60), accountKey: account, fileName: "Film.mov",
                      message: "x", code: code, itemIdentifier: "f_1")
    }

    private func derive(_ connection: SyncConnectionState, status: AccountStatus = .ok, lastSync: Date? = nil,
                        problems: [ErrorLogEntry] = []) -> AccountMenuState.Kind {
        AccountMenuState.derive(status: status, connection: connection, lastSync: lastSync,
                                problems: problems, accountKey: key, now: now).kind
    }

    // MARK: Derivation

    func testStateDerivationTable() {
        let synced = now.addingTimeInterval(-120)
        XCTAssertEqual(derive(.connected, lastSync: synced), .connected(lastSync: synced))
        XCTAssertEqual(derive(.connected), .connected(lastSync: nil))
        XCTAssertEqual(derive(.connecting), .connecting)
        XCTAssertEqual(derive(.offline), .offline)
        XCTAssertEqual(derive(.authFailed), .needsLogin)
        XCTAssertEqual(derive(.unknown), .unknown)
        // The extension's auth-failure marker wins over any connection state.
        for connection: SyncConnectionState in [.connected, .connecting, .offline, .unknown] {
            XCTAssertEqual(derive(connection, status: .needsLogin), .needsLogin, "\(connection)")
        }
    }

    func testRecentProblemShowsErrorUnlessOfflineOrSignInRequired() {
        let recent = [problem(minutesAgo: 5)]
        XCTAssertEqual(derive(.connected, problems: recent), .error)
        XCTAssertEqual(derive(.unknown, problems: recent), .error)
        XCTAssertEqual(derive(.offline, problems: recent), .offline)
        XCTAssertEqual(derive(.connected, status: .needsLogin, problems: recent), .needsLogin)
        // Old problems, info entries and other accounts' problems do not count.
        XCTAssertEqual(derive(.connected, problems: [problem(minutesAgo: 61)]), .connected(lastSync: nil))
        XCTAssertEqual(derive(.connected, problems: [problem(minutesAgo: 1, code: "conflict_copy")]), .connected(lastSync: nil))
        XCTAssertEqual(derive(.connected, problems: [problem(minutesAgo: 1, account: "srv2:u1")]), .connected(lastSync: nil))
    }

    func testBadgeOnAuthFailureOrRecentError() {
        XCTAssertFalse(AccountMenuState.showsBadge(statuses: [.ok, .ok], problems: [], now: now))
        XCTAssertTrue(AccountMenuState.showsBadge(statuses: [.ok, .needsLogin], problems: [], now: now))
        XCTAssertTrue(AccountMenuState.showsBadge(statuses: [.ok], problems: [problem(minutesAgo: 10, account: "other")], now: now))
        XCTAssertFalse(AccountMenuState.showsBadge(statuses: [.ok], problems: [problem(minutesAgo: 90)], now: now))
        XCTAssertFalse(AccountMenuState.showsBadge(statuses: [.ok], problems: [problem(minutesAgo: 1, code: "conflict_copy")], now: now))
    }

    func testSignInAgainAndSymbols() {
        XCTAssertTrue(AccountMenuState(kind: .needsLogin).showsSignInAgain)
        for kind: AccountMenuState.Kind in [.connected(lastSync: nil), .connecting, .offline, .error, .unknown] {
            XCTAssertFalse(AccountMenuState(kind: kind).showsSignInAgain)
        }
        let symbols = [AccountMenuState.Kind.connected(lastSync: nil), .connecting, .offline, .needsLogin, .error, .unknown]
            .map { AccountMenuState(kind: $0).symbol }
        XCTAssertEqual(Set(symbols).count, symbols.count)
    }

    func testRelativeSyncTimeInBothLanguages() {
        let twoMinutes = now.addingTimeInterval(-120)
        XCTAssertEqual(AccountMenuState.relative(twoMinutes, now: now, locale: Locale(identifier: "de_DE")), "vor 2 Minuten")
        XCTAssertEqual(AccountMenuState.relative(twoMinutes, now: now, locale: Locale(identifier: "en_US")), "2 minutes ago")
        XCTAssertEqual(AccountMenuState.relative(now.addingTimeInterval(-3), now: now, locale: Locale(identifier: "de_DE")), "jetzt")
        let label = AccountMenuState(kind: .connected(lastSync: twoMinutes)).label(now: now, locale: Locale(identifier: "de_DE"))
        XCTAssertTrue(label.hasSuffix("vor 2 Minuten"), label)
    }

    func testGermanStringsExist() throws {
        let url = try XCTUnwrap(Bundle(for: AccountsModel.self).url(forResource: "de", withExtension: "lproj"))
        let de = try XCTUnwrap(Bundle(url: url))
        let table: [String: String] = [
            "Connected": "Verbunden", "Connected · Synced %@": "Verbunden · Synchronisiert %@",
            "Connecting…": "Verbinde…", "Offline": "Offline", "Sign-in required": "Anmeldung erforderlich",
            "Error": "Fehler", "Status unknown": "Status unbekannt", "Recent Problems": "Letzte Probleme",
            "Clear List": "Liste leeren", "Sign In Again…": "Erneut anmelden…", "Open in Finder": "Im Finder öffnen",
            "Open Web": "Web öffnen", "Add Account…": "Konto hinzufügen…", "Settings…": "Einstellungen…", "Quit Synclet": "Beenden",
        ]
        for (key, german) in table {
            XCTAssertEqual(de.localizedString(forKey: key, value: "MISSING", table: nil), german, key)
        }
    }

    // MARK: AccountsModel / ProblemsModel

    func testAccountsModelReadsTheStatusProvider() async throws {
        let harness = Harness()
        defer { harness.cleanUp() }
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        let entry = try XCTUnwrap(harness.accounts.entries.first)

        // Without a monitor: unknown (fallback), or sign-in required after an auth failure.
        XCTAssertEqual(harness.accounts.menuState(for: entry, problems: [], now: now).kind, .unknown)
        var failed = entry
        failed.status = .needsLogin
        XCTAssertEqual(FallbackAccountStatus(entry: failed).connectionState, .authFailed)
        XCTAssertEqual(harness.accounts.menuState(for: failed, problems: [], now: now).kind, .needsLogin)

        let synced = now.addingTimeInterval(-60)
        harness.accounts.statusProvider = { _ in FakeStatus(connectionState: .connected, lastSync: synced) }
        XCTAssertEqual(harness.accounts.menuState(for: entry, problems: [], now: now).kind, .connected(lastSync: synced))
        harness.accounts.statusProvider = { _ in FakeStatus(connectionState: .offline, lastSync: synced) }
        XCTAssertEqual(harness.accounts.menuState(for: entry, problems: [], now: now).kind, .offline)
    }

    func testSignOutDropsTheAccountsProblems() async throws {
        let harness = Harness()
        defer { harness.cleanUp() }
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        let log = ErrorLog(container: harness.accounts.container)
        log.append(problem(minutesAgo: 1, account: stored.key), post: false)
        log.append(problem(minutesAgo: 1, account: "other:u1"), post: false)
        await harness.accounts.signOut(key: stored.key)
        XCTAssertEqual(log.entries().map(\.accountKey), ["other:u1"])
    }

    func testProblemsRevealTheFileOrFallBackToTheAccountFolder() async throws {
        let harness = Harness()
        defer { harness.cleanUp() }
        let server = FakeSynclet(serverId: "srv1")
        Harness.serve(["files.example.test": server])
        let stored = try await harness.accounts.add(server: URL(string: "https://files.example.test")!, tokens: harness.tokens(server))
        var opened: [URL] = []
        harness.accounts.openURL = { opened.append($0) }

        let log = ErrorLog(container: harness.accounts.container)
        log.append(problem(minutesAgo: 2, account: stored.key), post: false)
        log.append(problem(minutesAgo: 1, code: "conflict_copy", account: stored.key), post: false)
        let model = ProblemsModel(container: harness.accounts.container)
        XCTAssertEqual(model.entries.map(\.code), ["conflict_copy", "too_large"], "newest first")

        var revealed: [URL] = []
        var existing: Set<String> = ["/tmp/CloudStorage/f_1"]
        model.itemURL = { _, id in URL(filePath: "/tmp/CloudStorage/\(id)") }
        model.fileExists = { existing.contains($0.path) }
        model.reveal = { revealed.append($0) }

        await model.reveal(model.entries[0], accounts: harness.accounts)
        XCTAssertEqual(revealed.map(\.path), ["/tmp/CloudStorage/f_1"])
        XCTAssertEqual(opened, [])

        // The file is gone ⇒ the account's folder opens instead.
        existing = []
        await model.reveal(model.entries[0], accounts: harness.accounts)
        XCTAssertEqual(revealed.count, 1)
        XCTAssertEqual(opened.map(\.path), ["/tmp/CloudStorage/\(stored.key16)"])

        // An entry of a signed-out account does nothing.
        var foreign = model.entries[0]
        foreign.accountKey = "gone:u1"
        await model.reveal(foreign, accounts: harness.accounts)
        XCTAssertEqual(opened.count, 1)

        model.clear()
        XCTAssertEqual(model.entries, [])
        XCTAssertEqual(log.entries(), [])
    }

    func testErrorListTitles() {
        let entry = ErrorLogEntry(date: now, accountKey: key, fileName: "Film.mov", message: "Zu groß.", code: "future_code")
        XCTAssertEqual(ErrorListView.title(entry, accountTitle: nil), "Film.mov – Zu groß.")
        XCTAssertEqual(ErrorListView.title(entry, accountTitle: "jens@host"), "Film.mov – Zu groß. (jens@host)")
    }

    func testMessagesAreLocalizedByTheReaderFromTheCode() {
        // Written by an extension running in another language: the app rebuilds the text.
        let entry = ErrorLogEntry(date: now, accountKey: key, fileName: "a.txt", message: "Changed elsewhere – …",
                                  code: "conflict_copy", itemIdentifier: "f_c", detail: "a (Konflikt Mac 2026-10-16 10-00).txt")
        let expected = SyncProblem(code: .conflictCopy, fileName: "a.txt", itemIdentifier: "f_c",
                                   detail: "a (Konflikt Mac 2026-10-16 10-00).txt").message()
        XCTAssertEqual(entry.localizedMessage, expected)
        XCTAssertTrue(entry.localizedMessage.contains("a (Konflikt Mac 2026-10-16 10-00).txt"))
        XCTAssertEqual(ErrorLogEntry(date: now, accountKey: key, fileName: "x", message: "stored", code: "other").localizedMessage, "stored")
    }

    func testRecentWindowBoundary() {
        XCTAssertTrue(AccountMenuState.hasRecentProblem([problem(minutesAgo: 59.99)], accountKey: key, now: now))
        XCTAssertFalse(AccountMenuState.hasRecentProblem([problem(minutesAgo: 60)], accountKey: key, now: now))
    }

    // MARK: Expiry (I1)

    func testNextExpiryIgnoresInfoAndExpiredEntries() {
        let entries = [problem(minutesAgo: 70), problem(minutesAgo: 30), problem(minutesAgo: 10),
                       problem(minutesAgo: 50, code: "conflict_copy")]
        XCTAssertEqual(ProblemsModel.nextExpiry(entries, after: now), now.addingTimeInterval(30 * 60))
        XCTAssertNil(ProblemsModel.nextExpiry([problem(minutesAgo: 61), problem(minutesAgo: 1, code: "conflict_copy")], after: now))
    }

    func testProblemExpiryUpdatesTheObservedTimeOnItsOwn() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "synclet-expiry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        ErrorLog(container: directory).append(problem(minutesAgo: 59), post: false)

        let clock = FakeTimer(start: now)
        let model = ProblemsModel(container: directory, clock: { clock.current }, sleeper: { try await clock.sleep($0) })
        XCTAssertEqual(model.now, now)
        XCTAssertTrue(AccountMenuState.showsBadge(statuses: [.ok], problems: model.entries, now: model.now))

        // One timer, armed for the expiry (60 s from now) plus the slack.
        try await waitUntil { clock.requested.count == 1 }
        XCTAssertEqual(clock.requested, [.milliseconds(60_500)])

        let changed = ChangeFlag()
        withObservationTracking { _ = model.now } onChange: { changed.set() }
        clock.fire()   // advances the clock by the requested time and wakes the sleeper
        try await waitUntil { model.now == self.now.addingTimeInterval(60.5) }
        XCTAssertTrue(changed.value, "views reading `now` are invalidated")
        XCTAssertFalse(AccountMenuState.showsBadge(statuses: [.ok], problems: model.entries, now: model.now))
        // Nothing recent left ⇒ no new timer.
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(clock.requested.count, 1)
    }

    func testReloadRearmsTheTimerForANewerProblem() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "synclet-expiry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let clock = FakeTimer(start: now)
        let model = ProblemsModel(container: directory, clock: { clock.current }, sleeper: { try await clock.sleep($0) })
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(clock.requested.isEmpty, "no problem, no timer")
        ErrorLog(container: directory).append(problem(minutesAgo: 0), post: false)
        model.reload()
        try await waitUntil { clock.requested.count == 1 }
        XCTAssertEqual(clock.requested, [.milliseconds(3_600_500)])
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "condition not reached")
    }
}

/// Clock plus sleeper for ``ProblemsModel``: records requested sleeps and wakes them on `fire()`.
@MainActor
final class FakeTimer {
    private(set) var current: Date
    private(set) var requested: [Duration] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(start: Date) { current = start }

    func sleep(_ duration: Duration) async throws {
        requested.append(duration)
        await withCheckedContinuation { waiting.append($0) }
    }

    func fire() {
        if let last = requested.last {
            current += Double(last.components.seconds) + Double(last.components.attoseconds) / 1e18
        }
        let pending = waiting
        waiting = []
        pending.forEach { $0.resume() }
    }
}

final class ChangeFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.withLock { flag = true } }
    var value: Bool { lock.withLock { flag } }
}

extension MenuStatusTests {
    // MARK: Offline line (spec §2.5)

    private func pinnedAccount(pins: PinSet, measured: [String: Int64] = [:], folders: [PinningModel.Folder] = []) -> PinningModel.AccountState {
        var space = PinningModel.SpaceState(space: .personal(), title: "Meine Dateien")
        space.pins = pins
        space.measured = measured
        space.folders = folders
        return PinningModel.AccountState(key: key, title: "jens@host", spaces: [space])
    }

    func testOfflineLineOnlyWhenSomethingIsPinned() {
        XCTAssertNil(OfflineMenuLine.text(for: nil, refreshing: false))
        XCTAssertNil(OfflineMenuLine.text(for: pinnedAccount(pins: PinSet()), refreshing: true))
    }

    func testOfflineLineShowsMeasuredBytes() throws {
        let account = pinnedAccount(pins: PinSet(folders: ["d_fotos"]), measured: ["d_fotos": 5_000_000])
        let text = try XCTUnwrap(OfflineMenuLine.text(for: account, refreshing: false))
        XCTAssertTrue(text.contains(Int64(5_000_000).formatted(.byteCount(style: .file))), text)
    }

    func testOfflineLineWhileNotMeasured() {
        let account = pinnedAccount(pins: PinSet(wholeSpace: true))
        XCTAssertNotEqual(OfflineMenuLine.text(for: account, refreshing: true),
                          OfflineMenuLine.text(for: account, refreshing: false))
        XCTAssertNotNil(OfflineMenuLine.text(for: account, refreshing: false))
    }
}
