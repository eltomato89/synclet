import SwiftUI
import SyncletKit

/// "Search" (iPhone tab, iPad sidebar): full-text search over all files of the account.
struct SearchView: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    var embedded = false

    var body: some View {
        DestinationStack(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded,
                         title: "Search") { api, open in
            SearchPage(api: api, spaces: entry.spaces, open: open)
        }
    }
}

/// The search field and the results of the "Search" destination.
private struct SearchPage: View {
    let spaces: SpaceDirectory
    let open: (FolderRoute) -> Void
    @State private var model: SearchModel

    init(api: SyncAPIClient, spaces: SpaceDirectory, open: @escaping (FolderRoute) -> Void) {
        self.spaces = spaces
        self.open = open
        _model = State(initialValue: SearchModel(api: api))
    }

    var body: some View {
        SearchResultsList(model: model, spaces: spaces, open: open)
            .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: Text("Names and Contents"))
            .onChange(of: model.query) { model.queryChanged() }
    }
}

/// Hits with path and highlighted snippet; a file opens (download, QuickLook), a folder is
/// pushed. Further pages load at the end of the list.
struct SearchResultsList: View {
    let model: SearchModel
    /// The account's spaces (each hit shows its space when there are several).
    let spaces: SpaceDirectory
    /// Opens a folder hit.
    let open: (FolderRoute) -> Void
    @State private var opening: SyncItem?
    @State private var sharing: SyncItem?

    var body: some View {
        content
            .sheet(item: $opening) { item in
                OpenFileSheet(item: item, api: model.api)
            }
            .sheet(item: $sharing) { item in
                ShareLinkView(item: item, api: model.api)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle:
            ContentUnavailableView("Search", systemImage: "magnifyingglass",
                                   description: Text("Enter at least two characters to search names and contents."))
        case .loading, .offline, .failed, .unavailable:
            LoadStatePlaceholder(state: model.state, failureTitle: "Search Failed") { model.queryChanged() }
        case .loaded:
            if model.hits.isEmpty {
                ContentUnavailableView.search(text: model.trimmedQuery)
            } else {
                list
            }
        }
    }

    private var list: some View {
        List {
            ForEach(model.hits, id: \.item.id) { hit in
                Button {
                    if hit.item.isFolder {
                        open(FolderRoute(item: hit.item))
                    } else {
                        opening = hit.item
                    }
                } label: {
                    SearchHitRow(hit: hit, location: spaces.location(of: hit), api: model.api)
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("search.hit.\(hit.item.name)")
                .shareLinkContextMenu(hit.item) { sharing = $0 }
                .onAppear {
                    if hit.item.id == model.hits.last?.item.id { Task { await model.loadMore() } }
                }
            }
            if model.isLoadingMore {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
    }
}

/// A hit: thumbnail, name, path and (for content matches) the snippet.
struct SearchHitRow: View {
    let hit: SyncSearchHit
    /// The path, with the space in front when the account has several ("Team · /Docs/a.pdf").
    let location: String
    let api: SyncAPIClient

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ItemThumbnail(item: hit.item, api: api, side: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: hit.item.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(verbatim: location)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                if let snippet = hit.snippet, !snippet.isEmpty {
                    Text(SearchModel.highlighted(snippet))
                        .font(.caption)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Scope of the search inside a folder (iPad).
enum FolderSearchScope: Hashable {
    case everywhere
    case folder
}

/// Search inside "My Files" (iPad): a search field on each folder; while searching, the
/// results cover the folder. "Search in Folder" limits the search to the folder shown.
struct FolderSearch: ViewModifier {
    let model: SearchModel
    let folder: FolderRoute
    let spaces: SpaceDirectory
    /// Opens a folder hit (after the search was ended).
    let open: (FolderRoute) -> Void

    private var scope: Binding<FolderSearchScope> {
        Binding(get: { model.scopeFolderId == nil ? .everywhere : .folder },
                set: { model.scopeFolderId = $0 == .folder ? folder.id : nil })
    }

    func body(content: Content) -> some View {
        @Bindable var model = model
        content
            .overlay { FolderSearchOverlay(model: model, spaces: spaces, open: open) }
            .searchable(text: $model.query, prompt: Text("Search"))
            .searchScopes(scope, activation: .onSearchPresentation) {
                Text("Everywhere").tag(FolderSearchScope.everywhere)
                Text("Search in Folder").tag(FolderSearchScope.folder)
            }
            .onChange(of: model.query) { model.queryChanged() }
            .onAppear {
                // A folder pushed while scoped: the scope follows the folder shown.
                if model.scopeFolderId != nil { model.scopeFolderId = folder.id }
            }
    }
}

/// The results over the folder while its search field is active.
private struct FolderSearchOverlay: View {
    let model: SearchModel
    let spaces: SpaceDirectory
    let open: (FolderRoute) -> Void
    @Environment(\.isSearching) private var isSearching
    @Environment(\.dismissSearch) private var dismissSearch

    var body: some View {
        if isSearching, model.trimmedQuery.count >= SearchModel.minimumLength {
            SearchResultsList(model: model, spaces: spaces) { route in
                model.query = ""
                model.queryChanged()
                dismissSearch()
                open(route)
            }
            .background(Color(uiColor: .systemBackground))
        }
    }
}

extension View {
    /// Search on a folder of "My Files" (see ``FolderSearch``); `nil` adds nothing.
    @ViewBuilder
    func folderSearch(_ model: SearchModel?, folder: FolderRoute, spaces: SpaceDirectory,
                      open: @escaping (FolderRoute) -> Void) -> some View {
        if let model {
            modifier(FolderSearch(model: model, folder: folder, spaces: spaces, open: open))
        } else {
            self
        }
    }
}
