import SwiftUI
import SyncletKit

/// A folder in a navigation path.
struct FolderRoute: Hashable {
    let id: String
    let title: String
}

/// „Verschieben“: pick the target folder, starting at „Meine Dateien“. The moved folders are
/// hidden (no move into itself); the current folder can't be picked.
struct MovePicker: View {
    let api: SyncAPIClient
    let accountKey: String
    let root: FolderRoute
    let moving: [SyncItem]
    /// Folder the items are in now.
    let sourceFolderId: String
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: [FolderRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            folder(root)
                .navigationDestination(for: FolderRoute.self) { route in
                    folder(route)
                }
        }
    }

    private func folder(_ route: FolderRoute) -> some View {
        MovePickerFolder(model: FolderModel(accountKey: accountKey, folderId: route.id, title: route.title,
                                            api: api, signal: { _ in }),
                         movingIds: Set(moving.map(\.id)), canPick: route.id != sourceFolderId,
                         count: moving.count) { folderId in
            onPick(folderId)
            dismiss()
        } cancel: {
            dismiss()
        }
    }
}

private struct MovePickerFolder: View {
    @State var model: FolderModel
    let movingIds: Set<String>
    let canPick: Bool
    let count: Int
    let pick: (String) -> Void
    let cancel: () -> Void

    private var folders: [SyncItem] {
        model.items.filter { $0.isFolder && !movingIds.contains($0.id) }
    }

    var body: some View {
        Group {
            switch model.state {
            case .offline:
                ContentUnavailableView {
                    Label("Offline", systemImage: "wifi.slash")
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("Can’t Load Folder", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(verbatim: message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            case .idle, .loading:
                ProgressView()
            case .loaded:
                List(folders) { folder in
                    NavigationLink(value: FolderRoute(id: folder.id, title: folder.name)) {
                        Label {
                            Text(verbatim: folder.name)
                        } icon: {
                            Image(systemName: "folder.fill").foregroundStyle(.tint)
                        }
                    }
                }
                .overlay {
                    if folders.isEmpty {
                        ContentUnavailableView("No Subfolders", systemImage: "folder")
                    }
                }
            }
        }
        .navigationTitle(Text(verbatim: model.title))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: cancel)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Move Here") { pick(model.folderId) }
                    .disabled(!canPick)
                    .accessibilityIdentifier("move.here")
            }
            ToolbarItem(placement: .status) {
                Text("Moving \(count) items")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .task { await model.load() }
    }
}
