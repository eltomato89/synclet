import SwiftUI
import SyncletKit

/// A folder in a navigation path.
struct FolderRoute: Hashable {
    let id: String
    let title: String
    /// Space of the folder (`nil` = unknown, e.g. an older server).
    var spaceId: String?
    /// Uploads and new folders are allowed here (the folder's `addChildren` capability, or the
    /// space's write access for a space root). Read-only folders hide the „+“ menu.
    var canAddChildren = true

    init(id: String, title: String, spaceId: String? = nil, canAddChildren: Bool = true) {
        self.id = id
        self.title = title
        self.spaceId = spaceId
        self.canAddChildren = canAddChildren
    }

    /// A folder item of a list.
    init(item: SyncItem) {
        self.init(id: item.id, title: item.name, spaceId: item.spaceId, canAddChildren: item.capabilities.addChildren)
    }
}

extension SpaceEntry {
    /// The space's root folder.
    var route: FolderRoute {
        FolderRoute(id: space.rootId, title: title, spaceId: id, canAddChildren: isWritable)
    }
}

/// „Verschieben“: pick the target folder. With spaces it starts at the list of spaces with
/// write access („Meine Dateien“ and team folders/storages; the server moves between spaces),
/// otherwise at „Meine Dateien“. The moved folders are hidden (no move into itself); the
/// current folder and read-only folders can't be picked.
struct MovePicker: View {
    let api: SyncAPIClient
    let accountKey: String
    let spaces: SpaceDirectory
    let moving: [SyncItem]
    /// Folder the items are in now.
    let sourceFolderId: String
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path: [FolderRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            start
                .navigationDestination(for: FolderRoute.self) { route in
                    folder(route)
                }
        }
    }

    @ViewBuilder
    private var start: some View {
        let targets = spaces.writable
        if targets.count > 1 {
            List(targets) { entry in
                NavigationLink(value: entry.route) {
                    SpaceLabel(entry: entry)
                }
                .accessibilityIdentifier("move.space.\(entry.title)")
            }
            .navigationTitle("Move")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        } else {
            folder(targets.first?.route ?? spaces.personal.route)
        }
    }

    private func folder(_ route: FolderRoute) -> some View {
        MovePickerFolder(model: FolderModel(accountKey: accountKey, folderId: route.id, title: route.title,
                                            api: api, signal: { _ in }),
                         movingIds: Set(moving.map(\.id)),
                         canPick: route.id != sourceFolderId && route.canAddChildren,
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
            case .unavailable:
                SpaceUnavailableView { Task { await model.load() } }
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
                    NavigationLink(value: FolderRoute(item: folder)) {
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
