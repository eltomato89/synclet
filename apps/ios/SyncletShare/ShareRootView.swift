import Observation
import os
import SwiftUI
import SyncletKit
import UniformTypeIdentifiers

/// State of the Share extension: accounts, the target folder and the hand-off to the upload
/// queue (spec §2.6). No sign-in here; without an account it only points to the app.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case choosing
        case enqueuing
        case failed(String)
    }

    let accounts: [StoredAccount]
    var target: ShareTarget?
    private(set) var phase: Phase = .choosing
    /// Number of shared attachments.
    let itemCount: Int

    @ObservationIgnored private weak var context: NSExtensionContext?
    @ObservationIgnored private let appGroup: String?
    @ObservationIgnored private let accountStore: AccountStore
    @ObservationIgnored private let credentials: CredentialStore
    @ObservationIgnored private let groupDefaults: UserDefaults
    /// Kept alive until the process ends; the system carries on with the session afterwards.
    @ObservationIgnored private var uploader: BackgroundUploader?

    nonisolated private static let log = Logger(subsystem: "tech.jensk.synclet", category: "share")

    init(context: NSExtensionContext?) {
        self.context = context
        let configuration = SharedConfiguration.fromInfoPlist()
        appGroup = configuration.appGroup
        let group = configuration.appGroup ?? "group.tech.jensk.synclet"
        accountStore = AccountStore(appGroup: group)
        credentials = CredentialStore(configuration: configuration)
        groupDefaults = UserDefaults(suiteName: group) ?? .standard
        accounts = accountStore.all()
        itemCount = Self.providers(of: context).count
        target = ShareTarget.resolve(stored: ShareTarget.load(from: groupDefaults), accounts: accounts)
    }

    var selectedAccount: StoredAccount? {
        target.flatMap { target in accounts.first { $0.key == target.accountKey } }
    }

    /// Choosing another account starts at its „Meine Dateien“.
    func select(accountKey: String) {
        guard accountKey != target?.accountKey, let account = accounts.first(where: { $0.key == accountKey }) else { return }
        target = ShareTarget.root(of: account)
    }

    /// API client of an account; the token is read from the shared keychain per request.
    func client(for account: StoredAccount) -> SyncAPIClient {
        let credentials = credentials
        let key = account.key
        return SyncAPIClient(baseURL: account.serverURL, token: {
            guard let token = credentials.token(for: key) else { throw SyncAPIError.unauthorized(message: "no device token") }
            return token
        })
    }

    func close() {
        context?.completeRequest(returningItems: [])
    }

    func cancel() {
        context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    /// „Hochladen“: copies every attachment into the queue while its file is valid, starts the
    /// extension's own background session and completes the request.
    func upload() async {
        guard let target, phase == .choosing else { return }
        phase = .enqueuing
        let queue = UploadQueue(appGroup: appGroup ?? "group.tech.jensk.synclet")
        var added = 0
        for provider in Self.providers(of: context) {
            if await Self.enqueue(provider, into: queue, target: target) {
                added += 1
                UploadSignal.post()
            }
        }
        guard added > 0 else {
            phase = .failed(String(localized: "These items can’t be uploaded."))
            return
        }
        target.save(to: groupDefaults)
        let uploader = BackgroundUploader(identifier: UploadSignal.shareSessionIdentifier, queue: queue, appGroup: appGroup,
                                          accounts: accountStore, credentials: credentials,
                                          onChange: { _ in UploadSignal.post() })
        self.uploader = uploader
        await uploader.pump()
        UploadSignal.post()
        close()
    }

    // MARK: - Attachments

    private static func providers(of context: NSExtensionContext?) -> [NSItemProvider] {
        (context?.inputItems ?? []).compactMap { $0 as? NSExtensionItem }.flatMap { $0.attachments ?? [] }
    }

    /// Loads the attachment as a file and enqueues it inside the callback (the URL is only valid
    /// there). The queue copies by streaming; nothing is loaded into memory.
    private static func enqueue(_ provider: NSItemProvider, into queue: UploadQueue, target: ShareTarget) async -> Bool {
        guard let type = ShareNaming.uploadType(provider.registeredContentTypes) else {
            log.info("attachment without a file type skipped")
            return false
        }
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
                guard let url else {
                    log.error("attachment not loaded: \(String(describing: error), privacy: .public)")
                    continuation.resume(returning: false)
                    return
                }
                do {
                    try queue.enqueue(source: url, name: ShareNaming.fileName(suggested: suggested, file: url, type: type),
                                      accountKey: target.accountKey, parentId: target.folderId,
                                      parentName: target.folderName)
                    continuation.resume(returning: true)
                } catch {
                    log.error("enqueue failed: \(String(describing: error), privacy: .public)")
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

/// Account, target folder and „Hochladen“.
struct ShareRootView: View {
    @Bindable var model: ShareModel
    @State private var showsFolderPicker = false

    var body: some View {
        NavigationStack {
            Group {
                if model.accounts.isEmpty {
                    ContentUnavailableView("Sign in in the Synclet app", systemImage: "person.crop.circle.badge.exclamationmark",
                                           description: Text("Add your account in the Synclet app first."))
                } else {
                    form
                }
            }
            .navigationTitle(Text(verbatim: "Synclet"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .sheet(isPresented: $showsFolderPicker) {
            if let account = model.selectedAccount {
                ShareFolderPicker(api: model.client(for: account), roots: ShareTarget.spaceTargets(of: account),
                                  spaces: SpaceDirectory(spaces: account.spaces)) { folder in
                    model.target = folder
                }
            }
        }
        .interactiveDismissDisabled(model.phase == .enqueuing)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if model.accounts.isEmpty {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { model.close() }
            }
        } else {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { model.cancel() }
                    .disabled(model.phase == .enqueuing)
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.phase == .enqueuing {
                    ProgressView()
                } else {
                    Button("Upload") { Task { await model.upload() } }
                        .disabled(model.target == nil || model.itemCount == 0)
                        .accessibilityIdentifier("share.upload")
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section("Account") {
                if model.accounts.count > 1 {
                    Picker("Account", selection: accountBinding) {
                        ForEach(model.accounts) { account in
                            Text(verbatim: Self.title(of: account)).tag(account.key)
                        }
                    }
                } else if let account = model.accounts.first {
                    Text(verbatim: Self.title(of: account))
                }
            }
            Section("Folder") {
                Button {
                    showsFolderPicker = true
                } label: {
                    LabeledContent {
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    } label: {
                        Label { Text(verbatim: model.target?.folderName ?? "") } icon: { Image(systemName: "folder") }
                    }
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("share.folder")
            }
            Section {
                Text("\(model.itemCount) items")
                    .foregroundStyle(.secondary)
                if case .failed(let message) = model.phase {
                    Text(verbatim: message).foregroundStyle(.red)
                }
            }
        }
        .disabled(model.phase == .enqueuing)
    }

    private var accountBinding: Binding<String> {
        Binding(get: { model.target?.accountKey ?? "" }, set: { model.select(accountKey: $0) })
    }

    static func title(of account: StoredAccount) -> String {
        "\(account.username)@\(ServerURL.displayHost(account.serverURL))"
    }
}
