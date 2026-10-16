import SwiftUI
import SyncletKit

/// Folder choice of the Share extension over the Sync API: starts at „Meine Dateien“,
/// „Hier hochladen“ picks the folder shown.
struct ShareFolderPicker: View {
    let api: SyncAPIClient
    let root: ShareTarget
    let choose: (ShareTarget) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ShareFolderList(api: api, folder: root) { folder in
                choose(folder)
                dismiss()
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
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
                                    folder: ShareTarget(accountKey: folder.accountKey, folderId: item.id, folderName: item.name),
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
            folders = all.filter(\.isFolder)
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            failure = String(localized: "Folders can’t be loaded.")
        }
    }
}
