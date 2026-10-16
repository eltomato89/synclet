import Foundation
import Observation
import os
import PhotosUI
import SwiftUI
import SyncletKit

/// What ``UploadCenter`` needs of a ``BackgroundUploader`` (replaced in tests).
@MainActor
protocol UploadDriving: AnyObject {
    func pump() async
    func cancel(id: String) async
    func handleBackgroundEvents(completion: @escaping @Sendable () -> Void)
}

extension BackgroundUploader: UploadDriving {}

/// The app's side of the upload queue (spec §2.6): enqueues picked files and photos, drives
/// the app's ``BackgroundUploader`` (`tech.jensk.synclet.upload.app`) and publishes the
/// entries for the uploads list and the badges.
///
/// The list is re-read on every change the uploader reports and on the Share extension's
/// Darwin notification (``UploadSignal/notificationName``). An entry that turns `done` signals
/// its account's working set once and reloads visible folders of that account.
@MainActor
@Observable
final class UploadCenter {
    static let shared = UploadCenter.live()

    /// `UserDefaults` key of the setting „Fotos als JPEG hochladen“.
    static let photosAsJPEGKey = "uploadPhotosAsJPEG"

    /// Newest first.
    private(set) var entries: [UploadEntry] = []
    /// Bytes sent per `uploading` entry (from the uploader's progress).
    private(set) var bytesSent: [String: Int64] = [:]
    /// Problem of the last enqueue (some sources could not be read); shown once.
    var notice: String?

    var activeCount: Int { entries.filter { $0.status == .waiting || $0.status == .uploading }.count }
    var failedCount: Int { entries.filter { $0.status == .failed }.count }

    /// Running plus failed uploads (badge); `nil` counts all accounts.
    func badgeCount(accountKey: String? = nil) -> Int {
        entries.filter { entry in
            (accountKey == nil || entry.accountKey == accountKey) && entry.status != .done
        }.count
    }

    /// Progress of an entry in `0…1`; `nil` while unknown (waiting, or a tus upload being created).
    func fraction(for entry: UploadEntry) -> Double? {
        switch entry.status {
        case .done: return 1
        case .failed, .waiting: return nil
        case .uploading:
            let sent = max(bytesSent[entry.id] ?? 0, entry.tusOffset)
            guard entry.size > 0 else { return nil }
            return min(1, Double(sent) / Double(entry.size))
        }
    }

    @ObservationIgnored let queue: UploadQueue
    @ObservationIgnored private(set) var uploader: UploadDriving!
    @ObservationIgnored private let signal: (String) async -> Void
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeShareUploader: ((UploadCenter) -> UploadDriving)?
    /// Created when the system hands the app the Share extension's session events.
    @ObservationIgnored private var shareUploader: UploadDriving?
    /// Last seen status per entry (finished uploads are signalled on the transition).
    @ObservationIgnored private var knownStatus: [String: UploadStatus] = [:]
    @ObservationIgnored private let startedAt = Date()
    @ObservationIgnored private var scheduledPump: Task<Void, Never>?
    @ObservationIgnored private var observingDarwin = false

    nonisolated private static let log = Logger(subsystem: "tech.jensk.synclet", category: "uploads")

    /// - Parameters:
    ///   - signal: called once per account when an upload finished (working set + visible folders).
    ///   - uploader: builds the app's uploader (it reports back to the center).
    ///   - shareUploader: builds an uploader for the Share extension's session (background events).
    init(queue: UploadQueue, defaults: UserDefaults = .standard, signal: @escaping (String) async -> Void,
         shareUploader: ((UploadCenter) -> UploadDriving)? = nil,
         uploader: (UploadCenter) -> UploadDriving) {
        self.queue = queue
        self.defaults = defaults
        self.signal = signal
        makeShareUploader = shareUploader
        self.uploader = uploader(self)
        reload()
    }

    /// The process-wide center over the app group's queue.
    private static func live() -> UploadCenter {
        let environment = AppEnvironment.shared
        let appGroup = environment.configuration.appGroup
        let queue = UploadQueue(appGroup: appGroup ?? "group.tech.jensk.synclet")
        func uploaderFactory(_ identifier: String) -> (UploadCenter) -> UploadDriving {
            { center in
                BackgroundUploader(
                    identifier: identifier, queue: queue, appGroup: appGroup,
                    accounts: environment.accountStore, credentials: environment.credentials,
                    // No background session inside the test host.
                    sessionConfiguration: AppEnvironment.isRunningTests ? .ephemeral : nil,
                    onChange: { [weak center] entry in
                        Task { @MainActor in center?.uploaderChanged(entry) }
                    },
                    onProgress: { [weak center] id, sent in
                        Task { @MainActor in center?.uploaderProgress(entryId: id, bytesSent: sent) }
                    })
            }
        }
        return UploadCenter(
            queue: queue,
            signal: { key in
                await environment.signalWorkingSet(accountKey: key)
                environment.accounts.notifyChange(key)
            },
            shareUploader: uploaderFactory(UploadSignal.shareSessionIdentifier),
            uploader: uploaderFactory(UploadSignal.appSessionIdentifier))
    }

    // MARK: - Lifecycle

    /// App launch: old entries pruned, the extension's notification observed, sign-outs
    /// clear their uploads, and waiting uploads start.
    func launch(accounts: AccountsModel) {
        queue.prune()
        observeShareExtension()
        bind(to: accounts)
        reload()
        Task { await uploader.pump() }
    }

    /// Scene active again: catch up with what changed meanwhile.
    func didBecomeActive() {
        reload()
        Task { await uploader.pump() }
    }

    /// Removes an account's uploads when it signs out.
    func bind(to accounts: AccountsModel) {
        accounts.onSignOut = { [weak self] key in await self?.accountSignedOut(key) }
    }

    /// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`. The Share
    /// extension's session is taken over when the extension is gone (spec §2.6).
    func handleBackgroundEvents(identifier: String, completion: @escaping @Sendable () -> Void) {
        switch identifier {
        case UploadSignal.appSessionIdentifier:
            uploader.handleBackgroundEvents(completion: completion)
        case UploadSignal.shareSessionIdentifier:
            if shareUploader == nil { shareUploader = makeShareUploader?(self) }
            if let shareUploader {
                shareUploader.handleBackgroundEvents(completion: completion)
            } else {
                completion()
            }
        default:
            Self.log.error("events for an unknown session \(identifier, privacy: .public)")
            completion()
        }
    }

    // MARK: - Enqueue

    /// Copies picked files into the queue (security-scoped access around each copy) and starts
    /// the uploads. Folders and unreadable files are skipped and reported in ``notice``.
    func enqueue(urls: [URL], accountKey: String, parentId: String, parentName: String) async {
        let queue = queue
        let skipped = await Task.detached(priority: .userInitiated) { () -> [String] in
            var skipped: [String] = []
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                    skipped.append(url.lastPathComponent)
                    continue
                }
                do {
                    try queue.enqueue(source: url, name: url.lastPathComponent, accountKey: accountKey,
                                      parentId: parentId, parentName: parentName)
                } catch {
                    Self.log.error("enqueue failed: \(String(describing: error), privacy: .public)")
                    skipped.append(url.lastPathComponent)
                }
            }
            return skipped
        }.value
        report(skipped)
        reload()
        await uploader.pump()
    }

    /// Exports picked photos (original, or JPEG per the setting) and enqueues them.
    func enqueue(photos: [PhotosPickerItem], accountKey: String, parentId: String, parentName: String) async {
        let asJPEG = defaults.bool(forKey: Self.photosAsJPEGKey)
        let directory = FileManager.default.temporaryDirectory.appending(path: "photo-import-\(UUID().uuidString)",
                                                                         directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = queue
        var skipped: [String] = []
        for (index, item) in photos.enumerated() {
            do {
                let file = try await PhotoImport.export(item, asJPEG: asJPEG, to: directory)
                try await Task.detached(priority: .userInitiated) {
                    try queue.enqueue(source: file, name: file.lastPathComponent, accountKey: accountKey,
                                      parentId: parentId, parentName: parentName)
                    try? FileManager.default.removeItem(at: file)
                }.value
                reload()
                if index == 0 { Task { await uploader.pump() } }
            } catch {
                Self.log.error("photo export failed: \(String(describing: error), privacy: .public)")
                skipped.append(String(localized: "Photo \(index + 1)"))
            }
        }
        report(skipped)
        reload()
        await uploader.pump()
    }

    private func report(_ skipped: [String]) {
        guard !skipped.isEmpty else { return }
        notice = String(localized: "Couldn’t add: \(skipped.joined(separator: ", "))")
    }

    // MARK: - Entry actions

    /// „Erneut versuchen“ for a failed upload.
    func retry(_ id: String) {
        queue.retry(id: id)
        reload()
        Task { await uploader.pump() }
    }

    /// „Abbrechen“ (running) and „Entfernen“ (failed): stops the transfer and drops the entry.
    func cancel(_ id: String) async {
        await uploader.cancel(id: id)
        await shareUploader?.cancel(id: id)
        reload()
    }

    /// Clears finished uploads from the list.
    func removeFinished() {
        for entry in entries where entry.status == .done { queue.remove(id: entry.id) }
        reload()
    }

    /// After a sign-out: running transfers stop, all of the account's entries go.
    func accountSignedOut(_ key: String) async {
        for entry in entries where entry.accountKey == key && entry.status == .uploading {
            await uploader.cancel(id: entry.id)
        }
        queue.removeAll(accountKey: key)
        reload()
    }

    // MARK: - Uploader reports

    /// `onChange` of an uploader (any entry changed).
    func uploaderChanged(_ entry: UploadEntry) {
        reload()
    }

    /// `onProgress` of an uploader; coalesced to whole percents.
    func uploaderProgress(entryId: String, bytesSent sent: Int64) {
        guard let entry = entries.first(where: { $0.id == entryId }), entry.size > 0 else { return }
        let before = (bytesSent[entryId] ?? 0) * 100 / entry.size
        if sent * 100 / entry.size != before || sent >= entry.size { bytesSent[entryId] = sent }
    }

    /// Re-reads the queue; signals uploads that finished since the last read.
    func reload() {
        let all = queue.all()
        var finishedKeys: [String] = []
        for entry in all where entry.status == .done {
            let wasRunning = knownStatus[entry.id].map { $0 != .done }
            // Unknown entries count when they finished after launch (the Share extension's).
            let finishedSinceLaunch = (entry.finishedAt ?? .distantPast) > startedAt
            if wasRunning ?? finishedSinceLaunch, !finishedKeys.contains(entry.accountKey) {
                finishedKeys.append(entry.accountKey)
            }
        }
        knownStatus = Dictionary(all.map { ($0.id, $0.status) }, uniquingKeysWith: { $1 })
        if all != entries { entries = all }
        let uploading = Set(all.filter { $0.status == .uploading }.map(\.id))
        if bytesSent.keys.contains(where: { !uploading.contains($0) }) {
            bytesSent = bytesSent.filter { uploading.contains($0.key) }
        }
        for key in finishedKeys {
            Task { await signal(key) }
        }
        scheduleRetryPump(all)
    }

    /// The uploader only starts entries whose backoff has passed; wake it when the next one is due.
    private func scheduleRetryPump(_ all: [UploadEntry]) {
        scheduledPump?.cancel()
        scheduledPump = nil
        let now = Date()
        guard let next = all.filter({ $0.status == .waiting }).compactMap(\.nextAttemptAt).filter({ $0 > now }).min() else {
            return
        }
        scheduledPump = Task { [weak self] in
            try? await Task.sleep(for: .seconds(next.timeIntervalSince(now) + 0.5))
            guard !Task.isCancelled, let self else { return }
            await self.uploader.pump()
        }
    }

    // MARK: - Share extension

    private func observeShareExtension() {
        guard !observingDarwin else { return }
        observingDarwin = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in
                Task { @MainActor in UploadCenter.shared.reload() }
            },
            UploadSignal.notificationName as CFString, nil, .deliverImmediately
        )
    }
}
