import SwiftUI
import SyncletKit

/// „Zuletzt“: recently changed files of the account.
struct RecentView: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    var embedded = false

    var body: some View {
        DestinationStack(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded,
                         title: "Recent") { api, open in
            RecentList(environment: environment, accountKey: entry.id, api: api, open: open)
        }
    }
}

private struct RecentList: View {
    let environment: AppEnvironment
    let accountKey: String
    let open: (FolderRoute) -> Void
    @State private var model: RecentModel
    @State private var opening: SyncItem?
    @State private var sharing: SyncItem?
    @Environment(\.scenePhase) private var scenePhase

    init(environment: AppEnvironment, accountKey: String, api: SyncAPIClient, open: @escaping (FolderRoute) -> Void) {
        self.environment = environment
        self.accountKey = accountKey
        self.open = open
        _model = State(initialValue: RecentModel(api: api))
    }

    var body: some View {
        content
            .refreshable { await model.load() }
            .task { await model.load() }
            .task(id: accountKey) {
                for await key in environment.accounts.changeEvents where key == accountKey {
                    await model.load()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.load() } }
            }
            .sheet(item: $opening) { item in
                OpenFileSheet(item: item, api: model.api)
            }
            .sheet(item: $sharing) { item in
                ShareLinkView(item: item, api: model.api)
            }
    }

    @ViewBuilder
    private var content: some View {
        if model.state == .loaded {
            List(model.items) { item in
                Button {
                    if item.isFolder { open(FolderRoute(id: item.id, title: item.name)) } else { opening = item }
                } label: {
                    ItemRow(item: item, api: model.api)
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("recent.item.\(item.name)")
                .shareLinkContextMenu(item) { sharing = $0 }
            }
            .listStyle(.plain)
            .overlay {
                if model.items.isEmpty {
                    ContentUnavailableView("No Recent Files", systemImage: "clock",
                                           description: Text("Files you change appear here."))
                }
            }
        } else {
            LoadStatePlaceholder(state: model.state, failureTitle: "Can’t Load Recent Files") {
                Task { await model.load() }
            }
        }
    }
}
