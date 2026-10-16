import SwiftUI
import SyncletKit

/// Folder choice of the Share extension over the Sync API: starts at „Meine Dateien“ – or,
/// when the account has team folders or storages with write access, at the list of those
/// spaces („Bereiche“). „Hier hochladen“ picks the folder shown.
struct ShareFolderPicker: View {
    let api: SyncAPIClient
    /// „Meine Dateien“ first, then the writable spaces (``ShareTarget/spaceTargets(of:)``).
    let roots: [ShareTarget]
    /// The account's spaces (symbols of the roots).
    let spaces: SpaceDirectory
    let choose: (ShareTarget) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            start
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var start: some View {
        if roots.count > 1 {
            List {
                Section {
                    link(roots[0])
                }
                Section("Spaces") {
                    ForEach(roots.dropFirst(), id: \.folderId) { root in
                        link(root)
                    }
                }
            }
            .navigationTitle("Folder")
            .navigationBarTitleDisplayMode(.inline)
        } else if let root = roots.first {
            list(root)
        }
    }

    private func link(_ root: ShareTarget) -> some View {
        NavigationLink {
            list(root)
        } label: {
            Label { Text(verbatim: root.folderName) } icon: {
                Image(systemName: spaces.entry(id: root.spaceId)?.systemImage ?? "folder")
            }
        }
        .accessibilityIdentifier("share.space.\(root.folderName)")
    }

    private func list(_ root: ShareTarget) -> some View {
        ShareFolderList(api: api, folder: root) { folder in
            choose(folder)
            dismiss()
        }
    }
}

private struct ShareFolderList: View {
    let api: SyncAPIClient
    let folder: ShareTarget
    let choose: (ShareTarget) -> Void
    @State private var folders: [SyncItem] = []
    @State private var loading = true
    @State private var failure: String?

    var body: some View {
        List {
            if let failure {
                Text(verbatim: failure).foregroundStyle(.secondary)
            }
            ForEach(folders) { item in
                NavigationLink {
                    ShareFolderList(api: api,
                                    folder: ShareTarget(accountKey: folder.accountKey, folderId: item.id,
                                                        folderName: item.name, spaceId: folder.spaceId),
                                    choose: choose)
                } label: {
                    Label { Text(verbatim: item.name) } icon: { Image(systemName: "folder.fill") }
                }
            }
        }
        .overlay {
            if loading { ProgressView() }
        }
        .navigationTitle(Text(verbatim: folder.folderName))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Upload Here") { choose(folder) }
                    .accessibilityIdentifier("share.chooseFolder")
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            var all: [SyncItem] = []
            var pageToken: String?
            repeat {
                let page = try await api.children(of: folder.folderId, pageToken: pageToken)
                all.append(contentsOf: page.items)
                pageToken = page.nextPageToken
            } while pageToken != nil
            // Read-only subfolders can't take uploads.
            folders = all.filter { $0.isFolder && $0.capabilities.addChildren }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            failure = nil
        } catch is CancellationError {
            return
        } catch let error as SyncAPIError where error.isSpaceUnavailable {
            failure = String(localized: "Not Available")
        } catch {
            failure = String(localized: "Folders can’t be loaded.")
        }
    }
}
