import SwiftUI
import SyncletKit

/// „Papierkorb“: deleted items with restore, delete forever and empty (both confirmed).
struct TrashView: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    var embedded = false

    var body: some View {
        DestinationStack(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded,
                         title: "Trash") { api, _ in
            TrashList(environment: environment, accountKey: entry.id, api: api)
        }
    }
}

private struct TrashList: View {
    @State private var model: TrashModel
    @State private var deleteCandidate: TrashEntry?
    @State private var confirmsEmpty = false
    @Environment(\.scenePhase) private var scenePhase

    init(environment: AppEnvironment, accountKey: String, api: SyncAPIClient) {
        _model = State(initialValue: TrashModel(
            accountKey: accountKey, api: api,
            signal: { key in await environment.signalWorkingSet(accountKey: key) }))
    }

    var body: some View {
        content
            .refreshable { await model.load() }
            .task { await model.load() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.load() } }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Empty Trash", systemImage: "trash.slash", role: .destructive) {
                        confirmsEmpty = true
                    }
                    .disabled(model.state != .loaded || model.entries.isEmpty)
                    .accessibilityIdentifier("trash.empty")
                }
            }
            .overlay(alignment: .bottom) { NoticeBanner(notice: $model.notice, identifier: "trash.notice") }
            .confirmationDialog(deleteTitle, isPresented: showsDeleteConfirmation, titleVisibility: .visible) {
                Button("Delete Forever", role: .destructive) {
                    if let entry = deleteCandidate {
                        Task { await model.deleteForever(entry) }
                    }
                }
                .accessibilityIdentifier("trash.confirmDelete")
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can’t be undone.")
            }
            .confirmationDialog("Empty the Trash?", isPresented: $confirmsEmpty, titleVisibility: .visible) {
                Button("Empty Trash", role: .destructive) {
                    Task { await model.empty() }
                }
                .accessibilityIdentifier("trash.confirmEmpty")
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("All items in the trash will be deleted forever. This can’t be undone.")
            }
    }

    @ViewBuilder
    private var content: some View {
        if model.state == .loaded {
            List(model.entries) { entry in
                TrashRow(entry: entry)
                    .accessibilityIdentifier("trash.item.\(entry.name)")
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete Forever", systemImage: "trash", role: .destructive) {
                            deleteCandidate = entry
                        }
                        Button("Restore", systemImage: "arrow.uturn.backward") {
                            Task { await model.restore(entry) }
                        }
                        .tint(.blue)
                    }
                    .contextMenu {
                        Button("Restore", systemImage: "arrow.uturn.backward") {
                            Task { await model.restore(entry) }
                        }
                        .accessibilityIdentifier("trash.restore")
                        Button("Delete Forever", systemImage: "trash", role: .destructive) {
                            deleteCandidate = entry
                        }
                        .accessibilityIdentifier("trash.delete")
                    }
            }
            .listStyle(.plain)
            .overlay {
                if model.entries.isEmpty {
                    ContentUnavailableView("Trash Is Empty", systemImage: "trash",
                                           description: Text("Deleted files and folders appear here."))
                }
            }
        } else {
            LoadStatePlaceholder(state: model.state, failureTitle: "Can’t Load Trash") {
                Task { await model.load() }
            }
        }
    }

    private var showsDeleteConfirmation: Binding<Bool> {
        Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } })
    }

    private var deleteTitle: Text {
        Text("Delete “\(deleteCandidate?.name ?? "")” forever?")
    }
}

/// A trash entry: symbol, name, original location and deletion date.
private struct TrashRow: View {
    let entry: TrashEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.type == .folder ? "folder.fill" : "doc")
                .font(.system(size: 24))
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entry.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(verbatim: subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        let date = SyncDate.parse(entry.deletedAt).map { $0.formatted(date: .abbreviated, time: .shortened) }
        return [entry.originalPath, date].compactMap { $0 }.joined(separator: " · ")
    }
}
