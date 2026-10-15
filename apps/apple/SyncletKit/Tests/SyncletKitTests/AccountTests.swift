import FileProvider
import XCTest
@testable import SyncletKit

final class MockDomains: FileProviderDomainControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var domains: [String: String] = [:]
    private(set) var addCalls = 0

    var all: [String: String] { lock.withLock { domains } }

    func addDomain(identifier: String, displayName: String) async throws {
        lock.withLock {
            addCalls += 1
            domains[identifier] = displayName
        }
    }
    func removeDomain(identifier: String) async throws {
        _ = lock.withLock { domains.removeValue(forKey: identifier) }
    }
    func domainIdentifiers() async throws -> [String] {
        lock.withLock { Array(domains.keys) }
    }
    func signalEnumerator(domainIdentifier: String, container: NSFileProviderItemIdentifier) async {}
}

final class AccountStoreTests: XCTestCase {
    var directory: URL!

    override func setUp() { directory = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    private func account(key: String = "srv1:u1", server: String = "https://synclet.dw83.de", username: String = "jens",
                         displayName: String = "Jens", addedAt: Date = Date(timeIntervalSince1970: 1_000)) -> StoredAccount {
        StoredAccount(key: key, serverURL: URL(string: server)!, userId: "u1", username: username,
                      displayName: displayName, spaces: [Fixtures.personal], addedAt: addedAt, deviceName: "Mac")
    }

    func testKey16() {
        XCTAssertEqual(AccountStore.key16(for: "srv1:u1").count, 16)
        XCTAssertEqual(AccountStore.key16(for: "srv1:u1"), AccountStore.key16(for: "srv1:u1"))
        XCTAssertNotEqual(AccountStore.key16(for: "srv1:u1"), AccountStore.key16(for: "srv2:u1"))
        XCTAssertTrue(AccountStore.key16(for: "x").allSatisfy(\.isHexDigit))
    }

    func testUpsertWritesJSONPerAccount() throws {
        let store = AccountStore(directory: directory)
        let stored = try store.upsert(account())
        let file = directory.appending(path: "accounts/\(stored.key16)/account.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(json["key"] as? String, "srv1:u1")
        XCTAssertEqual(json["serverURL"] as? String, "https://synclet.dw83.de")
        XCTAssertEqual(json["username"] as? String, "jens")
        XCTAssertNotNil(json["spaces"])
        XCTAssertNotNil(json["addedAt"])
        XCTAssertEqual(store.all(), [stored])
        XCTAssertEqual(store.account(key16: stored.key16), stored)
        XCTAssertEqual(store.account(key: "srv1:u1"), stored)
    }

    func testUpsertByKeyReplacesAndKeepsAddedAtAndState() throws {
        let store = AccountStore(directory: directory)
        try store.upsert(account(addedAt: Date(timeIntervalSince1970: 1_000)))
        let stateDir = try store.spaceStateDirectory(key: "srv1:u1", spaceId: "personal")
        try Data("pins".utf8).write(to: stateDir.appending(path: "pins.json"))

        let replaced = try store.upsert(account(displayName: "Jens K.", addedAt: Date(timeIntervalSince1970: 9_999)))
        XCTAssertEqual(store.all().count, 1)
        XCTAssertEqual(store.all().first?.displayName, "Jens K.")
        XCTAssertEqual(replaced.addedAt, Date(timeIntervalSince1970: 1_000))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stateDir.appending(path: "pins.json").path))
    }

    func testDifferentServersSameUsernameAreTwoAccounts() throws {
        let store = AccountStore(directory: directory)
        try store.upsert(account(key: "srvA:u1", server: "https://a.example.com"))
        try store.upsert(account(key: "srvB:u1", server: "https://b.example.com", addedAt: Date(timeIntervalSince1970: 2_000)))
        XCTAssertEqual(store.all().map(\.key), ["srvA:u1", "srvB:u1"])
        XCTAssertNotEqual(store.all()[0].key16, store.all()[1].key16)
    }

    func testRemoveDeletesAccountAndState() throws {
        let store = AccountStore(directory: directory)
        try store.upsert(account())
        let stateDir = try store.spaceStateDirectory(key: "srv1:u1", spaceId: "personal")
        XCTAssertTrue(stateDir.path.hasSuffix("accounts/\(AccountStore.key16(for: "srv1:u1"))/spaces/personal"))
        try store.remove(key: "srv1:u1")
        XCTAssertTrue(store.all().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stateDir.path))
        try store.remove(key: "srv1:u1") // idempotent
    }

    func testSyncStatePerSpace() throws {
        let store = AccountStore(directory: directory)
        try store.saveSyncState(SpaceSyncState(cursor: "42", updatedAt: Date(timeIntervalSince1970: 5)), key: "k", spaceId: "personal")
        try store.saveSyncState(SpaceSyncState(cursor: "7"), key: "k", spaceId: "s/../x")
        XCTAssertEqual(store.syncState(key: "k", spaceId: "personal")?.cursor, "42")
        XCTAssertEqual(store.syncState(key: "k", spaceId: "s/../x")?.cursor, "7")
        XCTAssertNil(store.syncState(key: "k", spaceId: "other"))
        XCTAssertEqual(AccountStore.safeComponent(".."), "%2E%2E")
    }

    func testDomainDisplayName() {
        XCTAssertEqual(account().domainDisplayName, "Synclet – jens@synclet.dw83.de")
        XCTAssertEqual(account(server: "http://localhost:8080").domainDisplayName, "Synclet – jens@localhost:8080")
    }
}

final class CredentialStoreTests: XCTestCase {
    func testSaveReadDelete() throws {
        let store = CredentialStore(storage: InMemorySecureStorage())
        XCTAssertNil(store.token(for: "srv1:u1"))
        try store.save(token: "syd_1", for: "srv1:u1")
        try store.save(token: "syd_2", for: "srv2:u1")
        XCTAssertEqual(store.token(for: "srv1:u1"), "syd_1")
        try store.save(token: "syd_1b", for: "srv1:u1")
        XCTAssertEqual(store.token(for: "srv1:u1"), "syd_1b")
        store.delete(for: "srv1:u1")
        XCTAssertNil(store.token(for: "srv1:u1"))
        XCTAssertEqual(store.token(for: "srv2:u1"), "syd_2")
    }

    func testFailingStorageThrows() {
        struct Failing: SecureStorage {
            func read(account: String) -> String? { nil }
            func write(_ value: String, account: String) -> OSStatus { errSecMissingEntitlement }
            func remove(account: String) {}
        }
        XCTAssertThrowsError(try CredentialStore(storage: Failing()).save(token: "t", for: "k")) {
            XCTAssertEqual($0 as? CredentialStoreError, .saveFailed(errSecMissingEntitlement))
        }
    }

    func testKeychainStorageConfiguration() {
        let storage = KeychainStorage(service: CredentialStore.defaultService, accessGroup: "JC32M95WLZ.tech.jensk.synclet.shared")
        XCTAssertEqual(storage.service, "tech.jensk.synclet.sync")
        XCTAssertEqual(storage.accessGroup, "JC32M95WLZ.tech.jensk.synclet.shared")
    }

    func testSharedConfigurationIgnoresMissingValues() {
        let config = SharedConfiguration.fromInfoPlist(Bundle(for: CredentialStoreTests.self))
        XCTAssertNil(config.appGroup)
        XCTAssertNil(config.keychainAccessGroup)
        XCTAssertEqual(SharedConfiguration.appGroupInfoKey, "SyncletAppGroup")
        XCTAssertEqual(SharedConfiguration.keychainAccessGroupInfoKey, "SyncletKeychainAccessGroup")
    }
}

final class AccountManagerTests: XCTestCase {
    var directory: URL!

    override func setUp() { directory = Fixtures.tempDirectory() }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    private func makeManager() -> (AccountManager, MockDomains, CredentialStore, AccountStore) {
        let credentials = CredentialStore(storage: InMemorySecureStorage())
        let accounts = AccountStore(directory: directory)
        let domains = MockDomains()
        let manager = AccountManager(credentials: credentials, accounts: accounts, domains: domains,
                                     session: MockURLProtocol.session(), deviceName: "Jens' MacBook",
                                     installationID: { "inst-hash" })
        return (manager, domains, credentials, accounts)
    }

    private let tokens = AppTokens(accessToken: "jwt.access", refreshToken: "syr_refresh",
                                   user: PublicUser(id: "u1", username: "jens", displayName: "Jens"))

    /// Stub of a server: registration, account (optionally without spaces), logout, revoke.
    private func serve(token: String = "syd_1", serverId: String = "srv1", accountJSON: String? = nil) {
        MockURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("POST", "/api/sync/v1/devices"):
                return .json(201, Fixtures.registrationJSON(serverId: serverId, token: token))
            case ("GET", "/api/sync/v1/account"):
                return .json(200, accountJSON ?? Fixtures.accountJSON(serverId: serverId))
            case ("POST", "/api/auth/logout"), ("DELETE", "/api/sync/v1/devices/current"):
                return .empty(204)
            default:
                return .empty(500)
            }
        }
    }

    func testAddRegistersStoresAndAddsDomain() async throws {
        let (manager, domains, credentials, accounts) = makeManager()
        serve()
        let stored = try await manager.add(server: URL(string: "https://synclet.dw83.de")!, tokens: tokens)

        XCTAssertEqual(stored.key, "srv1:u1")
        XCTAssertEqual(stored.username, "jens")
        XCTAssertEqual(stored.deviceName, "Jens' MacBook")
        XCTAssertEqual(stored.spaces, [Fixtures.personal])
        XCTAssertEqual(credentials.token(for: "srv1:u1"), "syd_1")
        XCTAssertEqual(accounts.all(), [stored])
        XCTAssertEqual(domains.all, [stored.key16: "Synclet – jens@synclet.dw83.de"])

        let requests = MockURLProtocol.requests
        XCTAssertEqual(requests.map(\.path), ["/api/sync/v1/devices", "/api/sync/v1/account", "/api/auth/logout"])
        XCTAssertEqual(requests[0].header("Authorization"), "Bearer jwt.access")
        XCTAssertEqual(requests[0].json?["name"] as? String, "Jens' MacBook")
        XCTAssertEqual(requests[0].json?["platform"] as? String, "macos")
        XCTAssertEqual(requests[0].json?["installationId"] as? String, "inst-hash")
        XCTAssertEqual(requests[1].header("Authorization"), "Bearer syd_1")
        XCTAssertEqual(requests[2].header("Cookie"), "synclet_refresh=syr_refresh")
    }

    func testAddAgainWithSameKeyReplacesTokenAndKeepsDomain() async throws {
        let (manager, domains, credentials, accounts) = makeManager()
        serve(token: "syd_1")
        let first = try await manager.add(server: URL(string: "https://synclet.dw83.de")!, tokens: tokens)
        serve(token: "syd_2")
        let second = try await manager.add(server: URL(string: "https://synclet.dw83.de")!, tokens: tokens)

        XCTAssertEqual(first.key16, second.key16)
        XCTAssertEqual(accounts.all().count, 1)
        XCTAssertEqual(credentials.token(for: "srv1:u1"), "syd_2")
        XCTAssertEqual(domains.all.count, 1)
        XCTAssertEqual(domains.addCalls, 1)
        XCTAssertEqual(second.addedAt, first.addedAt)
    }

    func testTwoServersSameUserAreTwoAccounts() async throws {
        let (manager, domains, _, accounts) = makeManager()
        serve(serverId: "srvA")
        _ = try await manager.add(server: URL(string: "https://a.example.com")!, tokens: tokens)
        serve(serverId: "srvB")
        _ = try await manager.add(server: URL(string: "https://b.example.com")!, tokens: tokens)
        XCTAssertEqual(Set(accounts.all().map(\.key)), ["srvA:u1", "srvB:u1"])
        XCTAssertEqual(Set(domains.all.values), ["Synclet – jens@a.example.com", "Synclet – jens@b.example.com"])
    }

    func testAddWithPhase1cServerSynthesizesPersonalSpace() async throws {
        let (manager, _, _, _) = makeManager()
        serve(accountJSON: Fixtures.phase1cAccountJSON)
        let stored = try await manager.add(server: URL(string: "http://localhost:8080")!, tokens: tokens)
        XCTAssertEqual(stored.spaces.map(\.id), ["personal"])
        XCTAssertEqual(stored.spaces.first?.rootId, "root")
        XCTAssertEqual(stored.domainDisplayName, "Synclet – jens@localhost:8080")
    }

    func testAddFailsWhenRegistrationFails() async {
        let (manager, domains, _, accounts) = makeManager()
        MockURLProtocol.reset { _ in .error(401, "unauthorized") }
        await assertThrows(.unauthorized(message: "unauthorized")) {
            _ = try await manager.add(server: Fixtures.server, tokens: self.tokens)
        }
        XCTAssertTrue(accounts.all().isEmpty)
        XCTAssertTrue(domains.all.isEmpty)
    }

    func testRemoveRevokesAndCleansUp() async throws {
        let (manager, domains, credentials, accounts) = makeManager()
        serve()
        let stored = try await manager.add(server: Fixtures.server, tokens: tokens)
        _ = try accounts.spaceStateDirectory(key: stored.key, spaceId: "personal")

        await manager.remove(key: stored.key)
        let revoke = MockURLProtocol.requests.first { $0.method == "DELETE" }
        XCTAssertEqual(revoke?.path, "/api/sync/v1/devices/current")
        XCTAssertEqual(revoke?.header("Authorization"), "Bearer syd_1")
        XCTAssertTrue(domains.all.isEmpty)
        XCTAssertNil(credentials.token(for: stored.key))
        XCTAssertTrue(accounts.all().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: accounts.accountDirectory(key: stored.key).path))
    }

    func testRemoveSucceedsOffline() async throws {
        let (manager, domains, credentials, accounts) = makeManager()
        serve()
        let stored = try await manager.add(server: Fixtures.server, tokens: tokens)
        MockURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        await manager.remove(key: stored.key)
        XCTAssertTrue(domains.all.isEmpty)
        XCTAssertNil(credentials.token(for: stored.key))
        XCTAssertTrue(accounts.all().isEmpty)
    }

    func testDomainForKeyAndClient() async throws {
        let (manager, _, _, _) = makeManager()
        serve()
        let stored = try await manager.add(server: Fixtures.server, tokens: tokens)
        let domain = manager.domain(for: stored.key)
        XCTAssertEqual(domain.identifier.rawValue, stored.key16)
        XCTAssertEqual(domain.displayName, "Synclet – jens@synclet.example.test")

        MockURLProtocol.reset { _ in .json(200, #"{"cursor":"3"}"#) }
        let cursor = try await XCTUnwrap(manager.client(for: stored.key)).cursor()
        XCTAssertEqual(cursor, "3")
        XCTAssertEqual(MockURLProtocol.requests.first?.header("Authorization"), "Bearer syd_1")
        XCTAssertNil(manager.client(for: "unknown"))
    }

    func testRestoreMissingDomainsAndUpdateSpaces() async throws {
        let (manager, domains, _, _) = makeManager()
        serve()
        let stored = try await manager.add(server: Fixtures.server, tokens: tokens)
        try await domains.removeDomain(identifier: stored.key16)
        let restored = try await manager.restoreMissingDomains()
        XCTAssertEqual(restored, [stored.key])
        XCTAssertNotNil(domains.all[stored.key16])

        XCTAssertFalse(try manager.updateSpaces(key: stored.key, spaces: [Fixtures.personal]))
        let more = [Fixtures.personal, SyncSpace(id: "s", kind: .shared, name: "S", rootId: "d_s", canWrite: true)]
        XCTAssertTrue(try manager.updateSpaces(key: stored.key, spaces: more))
        XCTAssertEqual(manager.accounts.account(key: stored.key)?.spaces, more)
    }
}

final class InstallationIDTests: XCTestCase {
    func testHashIsStableAndHidesRawValue() {
        let a = InstallationID.hashed("ABC-123")
        XCTAssertEqual(a, InstallationID.hashed("ABC-123"))
        XCTAssertNotEqual(a, InstallationID.hashed("ABC-124"))
        XCTAssertEqual(a.count, 64)
        XCTAssertFalse(a.contains("ABC"))
    }

    @MainActor
    func testCurrentOnThisMachine() {
        // `swift test` on a Mac has a hardware UUID.
        let id = InstallationID.current()
        XCTAssertNotNil(id)
        XCTAssertEqual(id, InstallationID.current())
    }
}
