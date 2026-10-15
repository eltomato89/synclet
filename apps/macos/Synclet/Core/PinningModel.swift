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
/// - The model's view of what is pinned comes from the stored ``PinSet`` (not from the loaded
///   folder list), so the fallback works from launch even if the tab is never opened.
/// - After a toggle the model signals the working set, so the extension re-reports the
///   affected items with their new policy.
/// - Fallback (whether or not macOS acts on the policy by itself):
///   - after a toggle, at launch and on load: a walk below the pins requests every file that
///     is not downloaded yet (and measures the pinned bytes shown as "≈ …");
///   - when the extension announces new pinned content
///     (`tech.jensk.synclet.pinnedContentChanged.<key16>`): exactly the announced ids from
///     the ``PinnedDownloadQueue`` are requested (no walk; metadata-only changes are never
///     announced).
/// - Unpinning only changes the policy back to `.inherited`; nothing is evicted.
/// - Signing out cancels every walk, request and pending announcement of the account.
@MainActor
@Observable
final class PinningModel {
    struct Folder: Identifiable, Equatable, Sendable {
        let id: String
        var name: String
        /// Size from the server (folders report 0 today).
        var serverSize: Int64
    }

    struct SpaceState: Identifiable, Equatable, Sendable {
        let space: SyncSpace
        var title: String
        /// What is pinned (from the ``PinStore``).
        var pins = PinSet()
        /// First-level folders, once loaded.
        var folders: [Folder] = []
        var isLoading = false
        var error: String?
        /// Bytes found below a container by the last walk (key: container identifier).
        var measured: [String: Int64] = [:]

        var id: String { space.id }
        var wholeSpace: Bool { pins.wholeSpace }

        func isPinned(_ folderId: String) -> Bool { pins.folders.contains(folderId) }

        /// "≈ <bytes>" of a folder when a size is known.
        func sizeHint(_ folderId: String) -> Int64? {
            if let size = folders.first(where: { $0.id == folderId })?.serverSize, size > 0 { return size }
            return measured[folderId]
        }

        /// The containers kept offline: the space folder, else the pinned folders.
        var pinnedContainers: [NSFileProviderItemIdentifier] {
            if pins.wholeSpace { return [SpaceLayout.identifier(for: space)] }
            return pins.folders.sorted().map { NSFileProviderItemIdentifier($0) }
        }

        /// Bytes of the pinned content in this space; `nil` while not measured.
        var offlineBytes: Int64? {
            if pins.wholeSpace { return measured[SpaceLayout.identifier(for: space).rawValue] }
            var total: Int64 = 0
            for id in pins.folders {
                guard let size = sizeHint(id) else { return nil }
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
        var key16: String { AccountStore.key16(for: key) }

        /// Footer total; `nil` while a pinned part is not measured.
        var offlineBytes: Int64? {
            var total: Int64 = 0
            for space in spaces {
                guard let bytes = space.offlineBytes else { return nil }
                total += bytes
            }
            return total
        }

        var hasPins: Bool { spaces.contains { !$0.pins.isEmpty } }
        var pinnedContainers: [NSFileProviderItemIdentifier] { spaces.flatMap(\.pinnedContainers) }
    }

    private(set) var accounts: [AccountState] = []
    /// Accounts with a walk in progress ("Calculating…").
    private(set) var refreshing: Set<String> = []
    /// Last error of a toggle.
    var errorMessage: String?

    @ObservationIgnored let accountsModel: AccountsModel
    @ObservationIgnored let content: OfflineContentManaging
    @ObservationIgnored private let makeStore: @Sendable (StoredAccount) -> PinStore
    @ObservationIgnored private let makeDownloads: @Sendable (StoredAccount) -> PinnedDownloadQueue
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let retryDelay: Duration
    @ObservationIgnored private var observers: [String: DarwinNotificationObserver] = [:]
    @ObservationIgnored private var refreshes: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshAgain: Set<String> = []
    @ObservationIgnored private var announcements: [String: Task<Void, Never>] = [:]

    /// - Parameters:
    ///   - makeStore: the pin store of an account (default: `accounts/<key16>/` in the app group).
    ///   - makeDownloads: the queue of announced downloads (default: same directory).
    ///   - debounce: wait after an announcement (coalesces bursts, lets the system apply the
    ///     reported items first).
    ///   - retryDelay: wait before the one retry of failed download requests.
    init(accounts: AccountsModel, content: OfflineContentManaging = SystemOfflineContent(),
         makeStore: (@Sendable (StoredAccount) -> PinStore)? = nil,
         makeDownloads: (@Sendable (StoredAccount) -> PinnedDownloadQueue)? = nil,
         debounce: Duration = .seconds(2), retryDelay: Duration = .seconds(5)) {
        self.accountsModel = accounts
        self.content = content
        let directoryStore = accounts.manager.accounts
        self.makeStore = makeStore ?? { PinStore(stateDir: directoryStore.accountDirectory(key: $0.key)) }
        self.makeDownloads = makeDownloads
            ?? { PinnedDownloadQueue(accountDirectory: directoryStore.accountDirectory(key: $0.key)) }
        self.debounce = debounce
        self.retryDelay = retryDelay
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

    /// Follows the account list (and space lists) of ``AccountsModel``; keeps loaded folders,
    /// re-reads the pins, and cancels all work of accounts that are gone.
    func reload() {
        let previous = Dictionary(accounts.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        accounts = accountsModel.entries.map { entry in
            let store = makeStore(entry.account)
            let old = previous[entry.id]
            let spaces = entry.account.spaces.map { space -> SpaceState in
                var state = old?.spaces.first { $0.id == space.id }
                    ?? SpaceState(space: space, title: SpaceLayout.displayName(for: space))
                state.pins = store.pins(space: space.id)
                return state
            }
            return AccountState(key: entry.id, title: entry.title, spaces: spaces)
        }
        let current = Set(accounts.map(\.key))
        for key in Set(refreshes.keys).union(announcements.keys).union(refreshAgain) where !current.contains(key) {
            cancelWork(key: key)
        }
        observeSignals()
    }

    /// Cancels the walk, requests and pending announcement of an account.
    private func cancelWork(key: String) {
        Logger.app.info("cancelling offline work of a removed account")
        refreshes.removeValue(forKey: key)?.cancel()
        announcements.removeValue(forKey: key)?.cancel()
        refreshAgain.remove(key)
        refreshing.remove(key)
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
                    state.folders = folders.map { Folder(id: $0.id, name: $0.name, serverSize: $0.size) }
                    state.pins = pins
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
        let pins = store.pins(space: space)
        update(key: key, space: space) { $0.pins = pins }
        await signalPinsChanged(key: key)
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
        let pins = store.pins(space: space)
        update(key: key, space: space) { $0.pins = pins }
        await signalPinsChanged(key: key)
    }

    /// The extension applies pin changes in its working-set round (the space folder too);
    /// replicated providers ignore signals of other containers.
    private func signalPinsChanged(key: String) async {
        await content.signal(domain: domain(key: key), containers: [.workingSet])
        refreshOffline(key: key)
    }

    private func fail(_ error: Error) {
        Logger.app.error("saving pins failed: \(String(describing: error), privacy: .public)")
        errorMessage = String(localized: "The setting could not be saved: \(error.localizedDescription)")
    }

    // MARK: - Offline fallback

    /// Walks below the pins: requests every file that is not downloaded yet and updates the
    /// measured sizes. One walk per account at a time; a request during a walk runs once more
    /// afterwards.
    func refreshOffline(key: String) {
        guard refreshes[key] == nil else {
            refreshAgain.insert(key)
            return
        }
        guard let containers = account(key: key)?.pinnedContainers, !containers.isEmpty else { return }
        let domain = domain(key: key)
        let content = content
        refreshing.insert(key)
        refreshes[key] = Task {
            let bytes = await content.ensureDownloaded(domain: domain, containers: containers)
            guard !Task.isCancelled else { return }
            self.applyMeasurements(bytes, key: key)
            self.refreshes[key] = nil
            self.refreshing.remove(key)
            if self.refreshAgain.remove(key) != nil { self.refreshOffline(key: key) }
        }
    }

    func isRefreshing(key: String) -> Bool { refreshing.contains(key) }

    /// Waits for running walks (tests).
    func waitForRefreshes() async {
        while let task = refreshes.values.first { await task.value }
    }

    private func applyMeasurements(_ bytes: [NSFileProviderItemIdentifier: Int64], key: String) {
        guard let a = accounts.firstIndex(where: { $0.key == key }) else { return }
        for s in accounts[a].spaces.indices {
            for (container, total) in bytes { accounts[a].spaces[s].measured[container.rawValue] = total }
        }
    }

    // MARK: - Signals of the extension

    /// `pinsChanged` (a pin dropped by the extension, or written elsewhere): re-read the pins.
    func pinsChanged(key16: String) {
        guard let account = accounts.first(where: { $0.key16 == key16 }),
              let store = store(key: account.key) else { return }
        for space in account.spaces {
            let pins = store.pins(space: space.id)
            update(key: account.key, space: space.id) { $0.pins = pins }
        }
    }

    /// `pinnedContentChanged`: new content below a pin was reported to the system. After the
    /// debounce, exactly the announced ids are requested (an overflowed queue ⇒ one walk).
    func pinnedContentChanged(key16: String) {
        guard let entry = accountsModel.entries.first(where: { $0.account.key16 == key16 }) else { return }
        let key = entry.id
        let downloads = makeDownloads(entry.account)
        announcements[key]?.cancel()
        let debounce = debounce
        let retryDelay = retryDelay
        let domain = domain(key: key)
        let content = content
        announcements[key] = Task {
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            let batch: PinnedDownloadQueue.Batch
            do {
                batch = try downloads.drain()
            } catch {
                Logger.app.error("pinned downloads unreadable: \(String(describing: error), privacy: .public)")
                batch = PinnedDownloadQueue.Batch(overflow: true)
            }
            if batch.overflow { self.refreshOffline(key: key) }
            if !batch.ids.isEmpty {
                var failed = await content.requestDownloads(domain: domain, ids: batch.ids)
                if !failed.isEmpty, !Task.isCancelled {
                    // The system may not have applied the reported items yet: one retry.
                    try? await Task.sleep(for: retryDelay)
                    if !Task.isCancelled { failed = await content.requestDownloads(domain: domain, ids: failed) }
                    if !failed.isEmpty { Logger.app.error("\(failed.count) pinned downloads could not be requested") }
                }
            }
            if !Task.isCancelled { self.announcements[key] = nil }
        }
    }

    /// Waits for pending announcements (tests).
    func waitForAnnouncements() async {
        while let task = announcements.values.first {
            await task.value
            if announcements.values.first == task { break }
        }
    }

    private func observeSignals() {
        guard !AppDelegate.isRunningTests else { return }
        var wanted: [String: DarwinNotificationObserver] = [:]
        for account in accounts {
            for name in [PinStore.notificationName(key16: account.key16), PinStore.pinnedContentNotificationName(key16: account.key16)] {
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

/// Observes one Darwin notification until released. The Darwin center delivers on the main
/// thread, and observers are released on the main actor only, so no callback can race `deinit`.
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
    /// returns the bytes found below each container. Stops promptly when cancelled.
    func ensureDownloaded(domain: NSFileProviderDomainIdentifier, containers: [NSFileProviderItemIdentifier]) async
        -> [NSFileProviderItemIdentifier: Int64]
    /// Requests downloads of these items; returns the ids whose request failed.
    func requestDownloads(domain: NSFileProviderDomainIdentifier, ids: [String]) async -> [String]
}

/// Set once; read from the scanning thread.
final class CancellationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}

/// Production: `NSFileProviderManager` plus a walk of the folders in `~/Library/CloudStorage`.
///
/// Walking a dataless folder makes the system enumerate it, so the whole pinned tree becomes
/// known; each file whose `ubiquitousItemDownloadingStatus` is `.notDownloaded` is requested
/// with `requestDownloadForItem(withIdentifier:requestedRange:)` (macOS 13+). Already
/// downloaded files are not touched. Cancelling stops the walk within a few entries.
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

    func requestDownloads(domain: NSFileProviderDomainIdentifier, ids: [String]) async -> [String] {
        guard let manager = manager(domain) else { return ids }
        var failed: [String] = []
        for id in ids {
            guard !Task.isCancelled else { return [] }
            do {
                try await manager.requestDownloadForItem(withIdentifier: NSFileProviderItemIdentifier(id), requestedRange: nil)
            } catch {
                failed.append(id)
            }
        }
        Logger.app.info("requested \(ids.count - failed.count) announced pinned downloads")
        return failed
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
            let flag = CancellationFlag()
            let scan = await withTaskCancellationHandler {
                await Task.detached(priority: .utility) { Self.scan(url, isCancelled: { flag.isSet }) }.value
            } onCancel: {
                flag.set()
            }
            guard !Task.isCancelled else { break }
            result[container] = scan.bytes
            var requested = 0
            for file in scan.missing {
                guard !Task.isCancelled else { break }
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

    /// Logical size of all files below `url` and the files that are not downloaded; stops
    /// (with what it has) when `isCancelled` turns true.
    static func scan(_ url: URL, isCancelled: () -> Bool = { false }) -> (bytes: Int64, missing: [URL]) {
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .ubiquitousItemDownloadingStatusKey]
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys,
                                                              options: [.skipsPackageDescendants]) else { return (0, []) }
        var bytes: Int64 = 0
        var missing: [URL] = []
        var count = 0
        for case let file as URL in enumerator {
            if isCancelled() { break }
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
