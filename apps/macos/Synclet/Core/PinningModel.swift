import FileProvider
import Foundation
import Observation
import os
import SyncletKit

/// Offline pinning (spec §2.5) for the "Offline" settings tab: per account and space a
/// "whole space" switch plus one switch per first-level folder.
///
/// - Pins are stored in the ``PinStore`` (app group, per account and space, by item id), which
///   posts `tech.jensk.synclet.pinsChanged.<key16>`. The extension reads them and reports
///   `.downloadEagerlyAndKeepDownloaded` on every item below a pin (Strategy B).
/// - After a toggle the model signals the working set (and the root container for a whole
///   space), so the extension re-reports the affected items with their new policy.
/// - Fallback (whether or not macOS acts on the policy by itself): after a toggle, at launch,
///   and when the extension announces new pinned content
///   (`tech.jensk.synclet.pinnedContentChanged.<key16>`), the model asks the system to
///   download every file below a pin that is not downloaded yet
///   (``OfflineContentManaging/ensureDownloaded(domain:containers:)``). That walk also
///   measures the pinned bytes shown as "≈ …".
/// - Unpinning only changes the policy back to `.inherited`; nothing is evicted, and files
///   the user keeps via Finder's "Keep Downloaded" stay.
@MainActor
@Observable
final class PinningModel {
    struct Folder: Identifiable, Equatable, Sendable {
        let id: String
        var name: String
        /// Size from the server (folders report 0 today).
        var serverSize: Int64
        var pinned: Bool
        /// Bytes found below the folder on disk by the last offline walk.
        var measuredBytes: Int64?

        /// "≈ <bytes>" when a size is known.
        var sizeHint: Int64? { serverSize > 0 ? serverSize : measuredBytes }
    }

    struct SpaceState: Identifiable, Equatable, Sendable {
        let space: SyncSpace
        var title: String
        var wholeSpace = false
        var folders: [Folder] = []
        var isLoading = false
        var error: String?
        /// Bytes below the whole space (only measured while it is pinned).
        var measuredBytes: Int64?

        var id: String { space.id }

        /// Bytes kept offline in this space; `nil` while not measured yet.
        var offlineBytes: Int64? {
            if wholeSpace { return measuredBytes }
            let pinned = folders.filter(\.pinned)
            var total: Int64 = 0
            for folder in pinned {
                guard let size = folder.sizeHint else { return nil }
                total += size
            }
            return total
        }
    }

    struct AccountState: Identifiable, Equatable, Sendable {
        let key: String
        var title: String
        var spaces: [SpaceState]

        var id: String { key }

        /// Footer total; `nil` while a pinned part is not measured yet.
        var offlineBytes: Int64? {
            var total: Int64 = 0
            for space in spaces {
                guard let bytes = space.offlineBytes else { return nil }
                total += bytes
            }
            return total
        }

        var hasPins: Bool { spaces.contains { $0.wholeSpace || $0.folders.contains(where: \.pinned) } }
    }

    private(set) var accounts: [AccountState] = []
    /// Last error of a toggle.
    var errorMessage: String?

    @ObservationIgnored let accountsModel: AccountsModel
    @ObservationIgnored let content: OfflineContentManaging
    @ObservationIgnored private let makeStore: @Sendable (StoredAccount) -> PinStore
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private var observers: [String: DarwinNotificationObserver] = [:]
    @ObservationIgnored private var refreshes: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshAgain: Set<String> = []
    @ObservationIgnored private var pendingAnnouncements: [String: Task<Void, Never>] = [:]

    /// - Parameters:
    ///   - makeStore: the pin store of an account (default: `accounts/<key16>/` in the app group).
    ///   - debounce: wait after an announcement of the extension before walking (lets the
    ///     system apply the reported items first; coalesces bursts).
    init(accounts: AccountsModel, content: OfflineContentManaging = SystemOfflineContent(),
         makeStore: (@Sendable (StoredAccount) -> PinStore)? = nil, debounce: Duration = .seconds(2)) {
        self.accountsModel = accounts
        self.content = content
        let directoryStore = accounts.manager.accounts
        self.makeStore = makeStore ?? { PinStore(stateDir: directoryStore.accountDirectory(key: $0.key)) }
        self.debounce = debounce
        reload()
    }

    func account(key: String) -> AccountState? { accounts.first { $0.key == key } }

    private func store(key: String) -> PinStore? {
        accountsModel.entry(key: key).map { makeStore($0.account) }
    }

    private func domain(key: String) -> NSFileProviderDomainIdentifier {
        NSFileProviderDomainIdentifier(AccountStore.key16(for: key))
    }

    // MARK: - Accounts

    /// Follows the account list (and space lists) of ``AccountsModel``; keeps loaded folders.
    /// Pins are re-read from the store.
    func reload() {
        let previous = Dictionary(accounts.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        accounts = accountsModel.entries.map { entry in
            let store = makeStore(entry.account)
            let old = previous[entry.id]
            let spaces = entry.account.spaces.map { space -> SpaceState in
                var state = old?.spaces.first { $0.id == space.id }
                    ?? SpaceState(space: space, title: SpaceLayout.displayName(for: space))
                Self.apply(store.pins(space: space.id), to: &state)
                return state
            }
            return AccountState(key: entry.id, title: entry.title, spaces: spaces)
        }
        observeSignals()
    }

    private static func apply(_ pins: PinSet, to state: inout SpaceState) {
        state.wholeSpace = pins.wholeSpace
        for index in state.folders.indices {
            state.folders[index].pinned = pins.folders.contains(state.folders[index].id)
        }
    }

    /// App launch: watch the account list, and catch up on pinned downloads.
    func start() {
        observeAccounts()
        for account in accounts where account.hasPins {
            refreshOffline(key: account.key)
        }
    }

    private func observeAccounts() {
        withObservationTracking {
            _ = accountsModel.entries
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.reload()
                self?.observeAccounts()
            }
        }
    }

    // MARK: - Folders

    /// Loads the first-level folders of every space of every account.
    func loadAll() async {
        reload()
        await withTaskGroup(of: Void.self) { group in
            for account in accounts {
                group.addTask { await self.load(key: account.key) }
            }
        }
    }

    /// Loads the first-level folders (`GET children` of each space root, folders only,
    /// sorted), drops pins of folders that are gone, and measures what is pinned.
    func load(key: String) async {
        guard let client = accountsModel.manager.client(for: key), let store = store(key: key),
              let spaces = account(key: key)?.spaces else { return }
        for space in spaces {
            update(key: key, space: space.id) {
                $0.isLoading = true
                $0.error = nil
            }
            do {
                let children = try await Self.allChildren(of: space.space.rootId, client: client)
                let folders = children.filter(\.isFolder)
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                try store.prune(existingFirstLevel: Set(folders.map(\.id)), space: space.id)
                let pins = store.pins(space: space.id)
                update(key: key, space: space.id) { state in
                    let measured = Dictionary(state.folders.map { ($0.id, $0.measuredBytes) }, uniquingKeysWith: { a, _ in a })
                    state.folders = folders.map {
                        Folder(id: $0.id, name: $0.name, serverSize: $0.size, pinned: pins.folders.contains($0.id),
                               measuredBytes: measured[$0.id] ?? nil)
                    }
                    state.wholeSpace = pins.wholeSpace
                    state.isLoading = false
                }
            } catch {
                Logger.app.error("loading folders failed: \(String(describing: error), privacy: .public)")
                update(key: key, space: space.id) {
                    $0.isLoading = false
                    $0.error = String(localized: "The folders could not be loaded: \(error.localizedDescription)")
                }
            }
        }
        if account(key: key)?.hasPins == true { refreshOffline(key: key) }
    }

    private static func allChildren(of id: String, client: SyncAPIClient) async throws -> [SyncItem] {
        var items: [SyncItem] = []
        var token: String?
        repeat {
            let page = try await client.children(of: id, pageToken: token, limit: 1000)
            items += page.items
            token = page.nextPageToken
        } while token != nil
        return items
    }

    private func update(key: String, space: String, _ change: (inout SpaceState) -> Void) {
        guard let a = accounts.firstIndex(where: { $0.key == key }),
              let s = accounts[a].spaces.firstIndex(where: { $0.id == space }) else { return }
        change(&accounts[a].spaces[s])
    }

    // MARK: - Toggles

    /// "Ganzer Bereich offline".
    func setWholeSpace(_ on: Bool, key: String, space: String) async {
        guard let store = store(key: key) else { return }
        do {
            try store.setWholeSpace(on, space: space)
        } catch {
            fail(error)
            return
        }
        update(key: key, space: space) { $0.wholeSpace = on }
        // The space folder lives in the root container; its descendants come with the working set.
        await content.signal(domain: domain(key: key), containers: [.workingSet, .rootContainer])
        refreshOffline(key: key)
    }

    /// A first-level folder.
    func setFolder(_ id: String, pinned: Bool, key: String, space: String) async {
        guard let store = store(key: key) else { return }
        do {
            try store.setFolder(id, pinned: pinned, space: space)
        } catch {
            fail(error)
            return
        }
        update(key: key, space: space) { state in
            if let index = state.folders.firstIndex(where: { $0.id == id }) { state.folders[index].pinned = pinned }
        }
        await content.signal(domain: domain(key: key), containers: [.workingSet, NSFileProviderItemIdentifier(id)])
        refreshOffline(key: key)
    }

    private func fail(_ error: Error) {
        Logger.app.error("saving pins failed: \(String(describing: error), privacy: .public)")
        errorMessage = String(localized: "The setting could not be saved: \(error.localizedDescription)")
    }

    // MARK: - Offline fallback

    /// The containers to keep offline: a pinned space's folder, else its pinned folders.
    static func pinnedContainers(_ account: AccountState) -> [NSFileProviderItemIdentifier] {
        account.spaces.flatMap { space -> [NSFileProviderItemIdentifier] in
            if space.wholeSpace { return [SpaceLayout.identifier(for: space.space)] }
            return space.folders.filter(\.pinned).map { NSFileProviderItemIdentifier($0.id) }
        }
    }

    /// Requests downloads for everything below the pins that is not downloaded yet and
    /// updates the measured sizes. One walk per account at a time; a request during a walk
    /// runs once more afterwards.
    func refreshOffline(key: String) {
        guard refreshes[key] == nil else {
            refreshAgain.insert(key)
            return
        }
        guard let account = account(key: key) else { return }
        let containers = Self.pinnedContainers(account)
        guard !containers.isEmpty else { return }
        let domain = domain(key: key)
        let content = content
        refreshes[key] = Task {
            let bytes = await content.ensureDownloaded(domain: domain, containers: containers)
            self.applyMeasurements(bytes, key: key)
            self.refreshes[key] = nil
            if self.refreshAgain.remove(key) != nil { self.refreshOffline(key: key) }
        }
    }

    /// Waits for running walks (tests).
    func waitForRefreshes() async {
        while let task = refreshes.values.first { await task.value }
    }

    private func applyMeasurements(_ bytes: [NSFileProviderItemIdentifier: Int64], key: String) {
        guard let a = accounts.firstIndex(where: { $0.key == key }) else { return }
        for s in accounts[a].spaces.indices {
            let space = accounts[a].spaces[s]
            if let total = bytes[SpaceLayout.identifier(for: space.space)] { accounts[a].spaces[s].measuredBytes = total }
            for f in space.folders.indices {
                if let total = bytes[NSFileProviderItemIdentifier(space.folders[f].id)] {
                    accounts[a].spaces[s].folders[f].measuredBytes = total
                }
            }
        }
    }

    // MARK: - Signals of the extension

    /// `pinsChanged` (a pin dropped by the extension, or written elsewhere): re-read the pins.
    func pinsChanged(key16: String) {
        guard let account = accounts.first(where: { AccountStore.key16(for: $0.key) == key16 }),
              let store = store(key: account.key) else { return }
        for space in account.spaces {
            let pins = store.pins(space: space.id)
            update(key: account.key, space: space.id) { Self.apply(pins, to: &$0) }
        }
    }

    /// `pinnedContentChanged`: new or changed items below a pin were reported to the system.
    func pinnedContentChanged(key16: String) {
        guard let key = accounts.first(where: { AccountStore.key16(for: $0.key) == key16 })?.key else { return }
        pendingAnnouncements[key]?.cancel()
        let debounce = debounce
        pendingAnnouncements[key] = Task {
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            self.pendingAnnouncements[key] = nil
            self.refreshOffline(key: key)
        }
    }

    /// Waits for a pending announcement (tests).
    func waitForAnnouncements() async {
        while let task = pendingAnnouncements.values.first { await task.value }
    }

    private func observeSignals() {
        guard !AppDelegate.isRunningTests else { return }
        var wanted: [String: DarwinNotificationObserver] = [:]
        for account in accounts {
            let key16 = AccountStore.key16(for: account.key)
            for name in [PinStore.notificationName(key16: key16), PinStore.pinnedContentNotificationName(key16: key16)] {
                wanted[name] = observers[name] ?? DarwinNotificationObserver(name: name) { [weak self] name in
                    Task { @MainActor in self?.handle(notification: name) }
                }
            }
        }
        observers = wanted
    }

    func handle(notification name: String) {
        if name.hasPrefix(PinStore.notificationPrefix) {
            pinsChanged(key16: String(name.dropFirst(PinStore.notificationPrefix.count)))
        } else if name.hasPrefix(PinStore.pinnedContentNotificationPrefix) {
            pinnedContentChanged(key16: String(name.dropFirst(PinStore.pinnedContentNotificationPrefix.count)))
        }
    }
}

/// Observes one Darwin notification until released.
final class DarwinNotificationObserver: @unchecked Sendable {
    let name: String
    private let handler: @Sendable (String) -> Void

    init(name: String, handler: @escaping @Sendable (String) -> Void) {
        self.name = name
        self.handler = handler
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, name, _, _ in
                guard let observer, let name else { return }
                let me = Unmanaged<DarwinNotificationObserver>.fromOpaque(observer).takeUnretainedValue()
                me.handler(name.rawValue as String)
            },
            name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
                                           CFNotificationName(name as CFString), nil)
    }
}

/// What the app asks the system for offline content (replaceable in tests).
protocol OfflineContentManaging: Sendable {
    /// Lets the extension re-report the containers (new content policy).
    func signal(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
    /// Requests a download of every file below `containers` that is not downloaded yet and
    /// returns the bytes found below each container.
    func ensureDownloaded(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
        -> [NSFileProviderItemIdentifier: Int64]
}

/// Production: `NSFileProviderManager` plus a walk of the folders in `~/Library/CloudStorage`.
///
/// Walking a dataless folder makes the system enumerate it, so the whole pinned tree becomes
/// known; each file whose `ubiquitousItemDownloadingStatus` is `.notDownloaded` is requested
/// with `requestDownloadForItem(withIdentifier:requestedRange:)` (macOS 13+). Already
/// downloaded files are not touched.
struct SystemOfflineContent: OfflineContentManaging {
    /// Upper bound of entries per walk (protects against runaway trees).
    static let maxEntries = 200_000

    /// The manager of a domain (as ``AccountManager`` builds domains: identifier = key16).
    private func manager(_ domain: NSFileProviderDomainIdentifier) -> NSFileProviderManager? {
        NSFileProviderManager(for: NSFileProviderDomain(identifier: domain, displayName: ""))
    }

    func signal(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async {
        guard let manager = manager(domain) else { return }
        for container in containers {
            do {
                try await manager.signalEnumerator(for: container)
            } catch {
                Logger.app.info("signal \(container.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    func ensureDownloaded(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
        -> [NSFileProviderItemIdentifier: Int64] {
        guard let manager = manager(domain) else { return [:] }
        var result: [NSFileProviderItemIdentifier: Int64] = [:]
        for container in containers {
            guard !Task.isCancelled else { break }
            let url: URL
            do {
                url = try await manager.getUserVisibleURL(for: container)
            } catch {
                Logger.app.info("no folder for \(container.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
                continue
            }
            let scan = await Task.detached(priority: .utility) { Self.scan(url) }.value
            result[container] = scan.bytes
            var requested = 0
            for file in scan.missing {
                do {
                    let (identifier, _) = try await NSFileProviderManager.identifierForUserVisibleFile(at: file)
                    try await manager.requestDownloadForItem(withIdentifier: identifier, requestedRange: nil)
                    requested += 1
                } catch {
                    Logger.app.info("download request failed: \(String(describing: error), privacy: .public)")
                }
            }
            if requested > 0 {
                Logger.app.info("requested \(requested) pinned downloads below \(container.rawValue, privacy: .public)")
            }
        }
        return result
    }

    /// Logical size of all files below `url` and the files that are not downloaded.
    static func scan(_ url: URL) -> (bytes: Int64, missing: [URL]) {
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .ubiquitousItemDownloadingStatusKey]
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys,
                                                              options: [.skipsPackageDescendants]) else { return (0, []) }
        var bytes: Int64 = 0
        var missing: [URL] = []
        var count = 0
        for case let file as URL in enumerator {
            count += 1
            if count > maxEntries {
                Logger.app.error("offline walk stopped after \(maxEntries) entries")
                break
            }
            guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isDirectory != true else { continue }
            bytes += Int64(values.fileSize ?? 0)
            if values.ubiquitousItemDownloadingStatus == .notDownloaded { missing.append(file) }
        }
        return (bytes, missing)
    }
}
