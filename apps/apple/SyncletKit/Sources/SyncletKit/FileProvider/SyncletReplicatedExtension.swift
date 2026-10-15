import FileProvider
import Foundation
import UniformTypeIdentifiers

/// Base class of the File Provider extensions (macOS now, iOS later).
///
/// The platform target contains only an empty subclass as `NSExtensionPrincipalClass`:
/// ```swift
/// final class FileProviderExtension: SyncletReplicatedExtension, @unchecked Sendable {}
/// ```
/// Domain identifier = `key16` of the account key. On every operation the extension
/// reads the account from the ``AccountStore`` (app group) and the device token from the
/// ``CredentialStore`` (keychain group); both groups come from the Info.plist
/// (``SharedConfiguration``, keys `SyncletAppGroup`, `SyncletKeychainAccessGroup`).
///
/// The top level is virtual (``SpaceLayout``): the root container lists the spaces and is
/// read-only; space folders cannot be renamed, moved or deleted.
open class SyncletReplicatedExtension: NSObject, NSFileProviderReplicatedExtension, @unchecked Sendable {
    /// Runtime context of an operation.
    public struct Context: Sendable {
        public var client: SyncAPIClient
        /// Device name for conflict copies.
        public var deviceName: String
        public var layout: SpaceLayout
        /// Receives each space's cursor after a change page (per-space sync state).
        public var cursorSink: (@Sendable (_ spaceID: String, _ cursor: String) -> Void)?
        /// Where unfinished tus uploads are remembered (the account's folder in the app
        /// group, so they survive a killed extension); `nil` ⇒ the extension's temp directory.
        public var transferStateDirectory: URL?
        /// Uploads above this size use tus (SYNC_API.md §7).
        public var uploadThreshold: Int

        public init(client: SyncAPIClient, deviceName: String, layout: SpaceLayout,
                    cursorSink: (@Sendable (_ spaceID: String, _ cursor: String) -> Void)? = nil,
                    transferStateDirectory: URL? = nil, uploadThreshold: Int = TransferEngine.defaultThreshold) {
            self.client = client
            self.deviceName = deviceName
            self.layout = layout
            self.cursorSink = cursorSink
            self.transferStateDirectory = transferStateDirectory
            self.uploadThreshold = uploadThreshold
        }
    }

    /// Group identifiers; default: from the extension's Info.plist.
    open class var sharedConfiguration: SharedConfiguration { .fromInfoPlist() }

    public let domain: NSFileProviderDomain
    private let contextProvider: @Sendable () -> Context?
    private let temporaryDirectoryOverride: URL?
    /// Clock for conflict names (injected by tests).
    let now: @Sendable () -> Date

    public required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.contextProvider = Self.makeContextProvider(domain: domain, configuration: Self.sharedConfiguration)
        self.temporaryDirectoryOverride = nil
        self.now = { Date() }
        super.init()
    }

    /// For tests and custom wiring: context, temp directory and clock given.
    public init(domain: NSFileProviderDomain, temporaryDirectory: URL? = nil,
                now: @escaping @Sendable () -> Date = { Date() },
                contextProvider: @escaping @Sendable () -> Context?) {
        self.domain = domain
        self.temporaryDirectoryOverride = temporaryDirectory
        self.contextProvider = contextProvider
        self.now = now
        super.init()
    }

    /// Reads the account (app group) and token (keychain group) of `domain` on every call.
    private static func makeContextProvider(domain: NSFileProviderDomain,
                                            configuration: SharedConfiguration) -> @Sendable () -> Context? {
        let credentials = CredentialStore(configuration: configuration)
        let accounts = configuration.appGroup.map { AccountStore(appGroup: $0) }
        if accounts == nil { Log.fileProvider.error("SyncletAppGroup missing in the Info.plist") }
        let key16 = domain.identifier.rawValue
        return {
            guard let accounts, let account = accounts.account(key16: key16),
                  credentials.token(for: account.key) != nil else { return nil }
            let key = account.key
            let client = SyncAPIClient(baseURL: account.serverURL, token: {
                guard let token = credentials.token(for: key) else {
                    throw SyncAPIError.unauthorized(message: "no device token")
                }
                return token
            })
            return Context(client: client, deviceName: account.deviceName ?? "Mac",
                           layout: SpaceLayout(spaces: account.spaces),
                           cursorSink: { spaceID, cursor in
                               try? accounts.saveSyncState(SpaceSyncState(cursor: cursor), key: key, spaceId: spaceID)
                           },
                           transferStateDirectory: accounts.accountDirectory(key: key)
                               .appending(path: "uploads", directoryHint: .isDirectory))
        }
    }

    open func invalidate() {}

    // MARK: - Helpers

    func context() throws -> Context {
        guard let context = contextProvider() else { throw NSFileProviderError(.notAuthenticated) }
        return context
    }

    private func serverID(_ identifier: NSFileProviderItemIdentifier, layout: SpaceLayout) throws -> String {
        guard let id = layout.serverID(for: identifier) else { throw NSFileProviderError(.noSuchItem) }
        return id
    }

    private var manager: NSFileProviderManager? { NSFileProviderManager(for: domain) }

    private func temporaryDirectory() -> URL {
        if let temporaryDirectoryOverride { return temporaryDirectoryOverride }
        if let url = try? manager?.temporaryDirectoryURL() { return url }
        return FileManager.default.temporaryDirectory
    }

    /// Transfers of this context (tus state in ``Context/transferStateDirectory``).
    func transfers(_ context: Context) -> TransferEngine {
        let stateDir = context.transferStateDirectory
            ?? temporaryDirectory().appending(path: "synclet-uploads", directoryHint: .isDirectory)
        return TransferEngine(api: context.client, tus: TusUploader(api: context.client), stateDir: stateDir,
                              threshold: context.uploadThreshold)
    }

    /// Resume key of an upload: the File Provider item plus its content version (spec §2.6).
    static func resumeKey(_ identifier: NSFileProviderItemIdentifier, contentVersion: Data?) -> String {
        UploadStateStore.key(itemIdentifier: identifier.rawValue,
                             contentVersion: contentVersion.map { $0.base64EncodedString() } ?? "")
    }

    /// Runs the operation as a `Task`; cancelling the `Progress` cancels the task.
    private func run(_ progress: Progress, _ operation: @escaping @Sendable () async -> Void) -> Progress {
        let task = Task { await operation() }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /// Lets the system re-enumerate the working set (e.g. after a conflict copy).
    private func signalWorkingSet() {
        manager?.signalEnumerator(for: .workingSet) { _ in }
    }

    // MARK: - Items

    open func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
                   completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let done = UncheckedBox(completionHandler)
        return run(Progress(totalUnitCount: 1)) { [self] in
            do {
                done.value(try await item(for: identifier), nil)
            } catch {
                done.value(nil, ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// The item for an identifier: virtual for the root container and space folders.
    func item(for identifier: NSFileProviderItemIdentifier) async throws -> FileProviderItem {
        if identifier == .rootContainer { return FileProviderItem.rootContainer() }
        let context = try context()
        if SpaceLayout.spaceID(from: identifier) != nil {
            guard let item = context.layout.virtualItem(for: identifier) else { throw NSFileProviderError(.noSuchItem) }
            return item
        }
        let id = try serverID(identifier, layout: context.layout)
        return FileProviderItem(try await context.client.item(id: id), layout: context.layout)
    }

    open func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                         request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        if containerItemIdentifier == .trashContainer { throw NSFileProviderError(.noSuchItem) }
        let context = try context()
        let fallback = context.layout
        let layout: @Sendable () -> SpaceLayout = { [contextProvider] in contextProvider()?.layout ?? fallback }
        if containerItemIdentifier == .rootContainer {
            return TopLevelEnumerator(layout: layout)
        }
        return FileProviderEnumerator(containerIdentifier: containerItemIdentifier, client: context.client,
                                      layout: layout, cursorSink: context.cursorSink)
    }

    // MARK: - Contents

    open func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                            request: NSFileProviderRequest,
                            completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let done = UncheckedBox(completionHandler)
        let progress = Progress(totalUnitCount: 100)
        let progressBox = UncheckedBox(progress)
        return run(progress) { [self] in
            do {
                let context = try context()
                let id = try serverID(itemIdentifier, layout: context.layout)
                let result = try await download(id, client: context.client, progress: progressBox.value)
                done.value(result.url, FileProviderItem(result.item, layout: context.layout), nil)
            } catch {
                done.value(nil, nil, ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// Downloads the content into a temp file (streamed, resumed after network errors by
    /// ``RangeDownloader``) and returns the matching item. If the content changes meanwhile
    /// (ETag ≠ `contentEtag`), it is loaded again up to twice; after that the state of the
    /// downloaded file wins.
    func download(_ id: String, client: SyncAPIClient, progress: Progress) async throws -> (url: URL, item: SyncItem) {
        let directory = temporaryDirectory()
        let downloader = RangeDownloader(api: client)
        for attempt in 0..<3 {
            try Task.checkCancellation()
            let destination = directory.appending(path: "synclet-\(UUID().uuidString)")
            let result: SyncDownloadResult
            do {
                result = try await downloader.download(itemID: id, to: destination, progress: progress)
            } catch {
                try? FileManager.default.removeItem(at: destination)
                throw error
            }
            var item = try await client.item(id: id)
            guard !item.isFolder else {
                try? FileManager.default.removeItem(at: destination)
                throw CocoaError(.fileReadUnknown)
            }
            if result.etag == nil || item.contentEtag == nil || result.etag == item.contentEtag {
                return (destination, item)
            }
            if attempt == 2 {
                // Report the state of the file – the newer version arrives with the changes.
                item.contentEtag = result.etag
                return (destination, item)
            }
            try? FileManager.default.removeItem(at: destination)
        }
        throw NSFileProviderError(.cannotSynchronize)
    }

    // MARK: - Create

    open func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                         options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                         completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let done = UncheckedBox(completionHandler)
        let template = UncheckedBox(itemTemplate)
        let progress = Progress(totalUnitCount: 100)
        let progressBox = UncheckedBox(progress)
        let modifiedAt = fields.contains(.contentModificationDate) ? itemTemplate.contentModificationDate ?? nil : nil
        return run(progress) { [self] in
            do {
                let context = try context()
                let created = try await create(template: template.value, contents: url, modifiedAt: modifiedAt,
                                               mayAlreadyExist: options.contains(.mayAlreadyExist),
                                               context: context, progress: progressBox.value,
                                               resumeKey: Self.resumeKey(template.value.itemIdentifier,
                                                                         contentVersion: template.value.itemVersion?.contentVersion))
                done.value(FileProviderItem(created, layout: context.layout), [], false, nil)
            } catch {
                done.value(nil, [], false, ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// Creates a folder or uploads a new file in the template's parent.
    ///
    /// - The root container is read-only (``SpaceLayoutError/readOnlyTopLevel``); a space
    ///   folder maps to its `rootId`.
    /// - Ignored names (§4.3) are excluded from sync; symlinks, aliases and packages are unsupported.
    /// - A folder of the same name is merged. A file of the same name with identical content
    ///   (sha256) is reused (resume, or a re-create by the system); otherwise the server
    ///   picks a free name `"<base> (2).<ext>"`.
    func create(template: NSFileProviderItem, contents url: URL?, modifiedAt: Date?, mayAlreadyExist: Bool,
                context: Context, progress: Progress?, resumeKey: String? = nil) async throws -> SyncItem {
        let client = context.client
        let parentID = try context.layout.serverParentId(for: template.parentItemIdentifier)
        let name = template.filename
        let type: UTType = template.contentType ?? .data

        if ItemMapping.isIgnoredName(name) {
            throw NSFileProviderError(.excludedFromSync)
        }
        if type.conforms(to: .symbolicLink) || type.conforms(to: .aliasFile) || type.conforms(to: .package) {
            throw CocoaError(.featureUnsupported)
        }

        if type.conforms(to: .folder) || type.conforms(to: .directory) {
            do {
                return try await client.createFolder(parentID: parentID, name: name, onConflict: .fail)
            } catch SyncAPIError.nameConflict(let existing?) where existing.isFolder {
                // A folder of the same name exists ⇒ merge.
                return existing
            }
        }

        // File without content (empty file): upload an empty temp file.
        var source = url
        var emptyFile: URL?
        if source == nil {
            let empty = temporaryDirectory().appending(path: "synclet-empty-\(UUID().uuidString)")
            FileManager.default.createFile(atPath: empty.path, contents: Data())
            source = empty
            emptyFile = empty
        }
        defer { if let emptyFile { try? FileManager.default.removeItem(at: emptyFile) } }
        guard let source else { throw CocoaError(.fileReadNoSuchFile) }
        return try await transfers(context).upload(file: source, newIn: parentID, name: name, modifiedAt: modifiedAt,
                                                   progress: progress, resumeKey: resumeKey)
    }

    /// SHA-256 (hex) of a file, read in blocks.
    static func sha256(of url: URL) throws -> String {
        try TransferEngine.sha256(of: url)
    }

    // MARK: - Modify

    open func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                         changedFields: NSFileProviderItemFields, contents newContents: URL?,
                         options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                         completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let done = UncheckedBox(completionHandler)
        let itemBox = UncheckedBox(item)
        let versionBox = UncheckedBox(version)
        let progress = Progress(totalUnitCount: 100)
        let progressBox = UncheckedBox(progress)
        return run(progress) { [self] in
            do {
                let result = try await modify(item: itemBox.value, baseVersion: versionBox.value, changedFields: changedFields,
                                              contents: newContents, context: context(), progress: progressBox.value)
                done.value(result.item, [], result.shouldFetchContent, nil)
            } catch {
                done.value(nil, [], false, ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// Core of `modifyItem`: rename/move via PATCH, content via ``TransferEngine/replace(file:itemId:baseEtag:modifiedAt:progress:resumeKey:)``
    /// (`PUT` with `If-Match` up to 32 MiB, resumable tus replace above).
    ///
    /// - Root container and space folders: renaming/moving/new content →
    ///   `CocoaError(.featureUnsupported)`; other fields are ignored.
    /// - Moving into the root container → ``SpaceLayoutError/readOnlyTopLevel``.
    /// - `412` (PUT, or tus replace at creation or completion): the local content is uploaded as a conflict copy
    ///   `"<base> (Konflikt <device> <date>).<ext>"` into the same folder and the server
    ///   state is returned (`shouldFetchContent`).
    /// - `404` on PUT (deleted remotely, changed locally): the local content is uploaded as
    ///   a new file into the parent, then `noSuchItem` lets the system drop the old item.
    /// - Unsupported fields (tags, last used, favorites, extended attributes, dates without
    ///   content …) are ignored.
    func modify(item: NSFileProviderItem, baseVersion: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                contents newContents: URL?, context: Context, progress: Progress?) async throws -> (item: FileProviderItem, shouldFetchContent: Bool) {
        let client = context.client
        let layout = context.layout

        if layout.isTopLevel(item.itemIdentifier) {
            if changedFields.contains(.filename) || changedFields.contains(.parentItemIdentifier)
                || changedFields.contains(.contents) {
                throw CocoaError(.featureUnsupported)
            }
            return (try await self.item(for: item.itemIdentifier), false)
        }

        let id = try serverID(item.itemIdentifier, layout: layout)
        var current: SyncItem?

        // 1. Metadata
        let newName = changedFields.contains(.filename) ? item.filename : nil
        var newParent: String?
        if changedFields.contains(.parentItemIdentifier) {
            if item.parentItemIdentifier == .trashContainer { throw CocoaError(.featureUnsupported) }
            newParent = try layout.serverParentId(for: item.parentItemIdentifier)
        }
        let hasNewContent = changedFields.contains(.contents) && newContents != nil
        if newName != nil || newParent != nil {
            do {
                current = try await client.updateItem(id: id, name: newName, parentID: newParent)
            } catch SyncAPIError.notFound {
                // 404 is ambiguous on PATCH (§8.2): the item or the target folder is gone.
                // Only a 404 of the probe means "item gone"; any other error (network, 5xx)
                // is rethrown so the system retries instead of uploading a stray copy.
                if newParent != nil {
                    do {
                        _ = try await client.item(id: id)
                        Log.fileProvider.info("move target of \(id, privacy: .public) no longer exists")
                        throw NSFileProviderError(.noSuchItem, userInfo: [
                            NSFileProviderErrorNonExistentItemIdentifierKey: item.parentItemIdentifier,
                        ])
                    } catch SyncAPIError.notFound {
                        // The item itself is gone.
                    }
                }
                guard hasNewContent, let newContents else { throw NSFileProviderError(.noSuchItem) }
                return try await recreateDeleted(item: item, contents: newContents, parentID: newParent,
                                                 context: context, progress: progress)
            }
        }

        // 2. Content
        let type: UTType = item.contentType ?? .data
        let isFolder = current?.isFolder ?? (type.conforms(to: .folder) || type.conforms(to: .directory))
        if changedFields.contains(.contents), let newContents, !isFolder {
            var ifMatch = ItemMapping.contentEtag(from: baseVersion)
            if ifMatch == nil {
                do {
                    let server = try await client.item(id: id)
                    current = server
                    ifMatch = server.contentEtag ?? server.etag
                } catch SyncAPIError.notFound {
                    return try await recreateDeleted(item: item, contents: newContents, parentID: newParent,
                                                     context: context, progress: progress)
                }
            }
            let modifiedAt = item.contentModificationDate ?? nil
            let transfers = transfers(context)
            do {
                current = try await transfers.replace(file: newContents, itemId: id, baseEtag: ifMatch ?? "*",
                                                      modifiedAt: modifiedAt, progress: progress)
            } catch SyncAPIError.conflict(let serverItem) {
                let server: SyncItem
                if let serverItem {
                    server = serverItem
                } else {
                    server = try await client.item(id: id)
                }
                let copyName = ConflictNaming.name(original: server.name, device: context.deviceName, date: now())
                let parentID = server.parentId ?? newParent ?? (try? layout.serverParentId(for: item.parentItemIdentifier))
                    ?? SyncItem.rootID
                // Keyed by the item, not the name, and `nameMayChange`: the copy's name contains
                // the minute, so a retry after the minute boundary resumes the same upload and
                // keeps the name of its first attempt (also when the original was renamed on the
                // server meanwhile – the copy then keeps the old base name).
                let copy = try await transfers.upload(file: newContents, newIn: parentID, name: copyName,
                                               modifiedAt: modifiedAt, progress: nil,
                                               resumeKey: Self.resumeKey(NSFileProviderItemIdentifier("conflict:" + item.itemIdentifier.rawValue),
                                                                         contentVersion: baseVersion.contentVersion),
                                               reuseIdentical: false, nameMayChange: true)
                Log.fileProvider.info("conflict on \(id, privacy: .public): uploaded copy \(copy.name, privacy: .private)")
                signalWorkingSet()
                return (FileProviderItem(server, layout: layout), true)
            } catch SyncAPIError.notFound {
                return try await recreateDeleted(item: item, contents: newContents, parentID: newParent,
                                                 context: context, progress: progress)
            }
        }

        if let current { return (FileProviderItem(current, layout: layout), false) }
        return (FileProviderItem(try await client.item(id: id), layout: layout), false)
    }

    /// A locally changed file that was deleted on the server: upload the local content as
    /// a new file (parent gone ⇒ the first writable space), signal the working set and
    /// fail with `noSuchItem` so the system drops the stale item and picks up the new one.
    private func recreateDeleted(item: NSFileProviderItem, contents: URL, parentID: String?,
                                 context: Context, progress: Progress?) async throws -> (item: FileProviderItem, shouldFetchContent: Bool) {
        let layout = context.layout
        let fallback = layout.spaces.first(where: \.canWrite)?.rootId ?? SyncItem.rootID
        let parent = parentID ?? (try? layout.serverParentId(for: item.parentItemIdentifier)) ?? fallback
        let modifiedAt = item.contentModificationDate ?? nil
        Log.fileProvider.info("re-uploading \(item.filename, privacy: .private): deleted on the server, changed locally")
        let transfers = transfers(context)
        let resumeKey = Self.resumeKey(NSFileProviderItemIdentifier("recreate:" + item.itemIdentifier.rawValue),
                                       contentVersion: nil)
        do {
            _ = try await transfers.upload(file: contents, newIn: parent, name: item.filename, modifiedAt: modifiedAt,
                                           progress: progress, resumeKey: resumeKey)
        } catch SyncAPIError.notFound where parent != fallback {
            _ = try await transfers.upload(file: contents, newIn: fallback, name: item.filename, modifiedAt: modifiedAt,
                                           progress: nil, resumeKey: resumeKey)
        }
        signalWorkingSet()
        throw NSFileProviderError(.noSuchItem)
    }

    // MARK: - Delete

    open func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                         options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                         completionHandler: @escaping (Error?) -> Void) -> Progress {
        let done = UncheckedBox(completionHandler)
        let recursive = options.contains(.recursive)
        return run(Progress(totalUnitCount: 1)) { [self] in
            do {
                try await delete(identifier, recursive: recursive, context: context())
                done.value(nil)
            } catch {
                done.value(ErrorMapping.fileProviderError(error))
            }
        }
    }

    /// Deletes an item (already deleted ⇒ success). Without `.recursive` a non-empty
    /// folder is refused (`directoryNotEmpty`). The root container and space folders
    /// cannot be deleted (`CocoaError(.featureUnsupported)`).
    func delete(_ identifier: NSFileProviderItemIdentifier, recursive: Bool, context: Context) async throws {
        if context.layout.isTopLevel(identifier) { throw CocoaError(.featureUnsupported) }
        let id = try serverID(identifier, layout: context.layout)
        let client = context.client
        do {
            if !recursive {
                let item = try await client.item(id: id)
                if item.isFolder, try await !client.children(of: id, limit: 1).items.isEmpty {
                    throw NSFileProviderError(.directoryNotEmpty)
                }
            }
            try await client.deleteItem(id: id)
        } catch SyncAPIError.notFound {
            return
        }
    }
}
