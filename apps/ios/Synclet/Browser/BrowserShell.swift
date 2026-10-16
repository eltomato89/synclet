import SwiftUI
import SyncletKit

/// Top-level places of the browser. Later tasks add cases (Task 8: „Zuletzt“, „Suche“,
/// „Papierkorb“; Task 9: „Uploads“): the case, its label, its place in ``tabs``/``more``/
/// ``sidebar`` and its view in ``DestinationView``.
enum BrowserDestination: String, Hashable, Identifiable, CaseIterable {
    case files
    case uploads
    case recent
    case search
    case trash

    var id: String { rawValue }

    /// iPhone tabs (before „Mehr“).
    static let tabs: [BrowserDestination] = [.files, .recent, .search]
    /// iPhone „Mehr“ tab, above „Konten“.
    static let more: [BrowserDestination] = [.trash, .uploads]
    /// iPad sidebar, below each account.
    static let sidebar: [BrowserDestination] = [.files, .recent, .search, .trash, .uploads]

    /// Tab title (iPhone).
    var tabTitle: LocalizedStringKey {
        switch self {
        case .files: return "Files"
        case .uploads: return "Uploads"
        case .recent: return "Recent"
        case .search: return "Search"
        case .trash: return "Trash"
        }
    }

    /// Sidebar / list title.
    var title: LocalizedStringKey {
        switch self {
        case .files: return "My Files"
        case .uploads: return "Uploads"
        case .recent: return "Recent"
        case .search: return "Search"
        case .trash: return "Trash"
        }
    }

    var systemImage: String {
        switch self {
        case .files: return "folder"
        case .recent: return "clock"
        case .search: return "magnifyingglass"
        case .trash: return "trash"
        case .uploads: return "arrow.up.circle"
        }
    }

    /// Badge of the destination for an account (uploads: running and failed).
    @MainActor
    func badge(accountKey: String) -> Int {
        switch self {
        case .uploads: return UploadCenter.shared.badgeCount(accountKey: accountKey)
        default: return 0
        }
    }
}

/// An account's destination in the iPad sidebar.
struct SidebarSelection: Hashable {
    let accountKey: String
    let destination: BrowserDestination
    /// A team folder or storage (destination `.files`); `nil` = „Meine Dateien“.
    var spaceId: String?

    /// The selection while its space still exists; otherwise the account's „Meine Dateien“
    /// (access removed, space deleted).
    func validated(spaces: [SyncSpace]) -> SidebarSelection {
        guard let spaceId, !spaces.contains(where: { $0.id == spaceId && $0.kind != .personal }) else { return self }
        return SidebarSelection(accountKey: accountKey, destination: .files, spaceId: nil)
    }
}

/// The browser around the destinations: iPhone (compact width) a `TabView` with one
/// `NavigationStack` per tab and the account menu at the top; iPad a `NavigationSplitView`
/// with the accounts and their destinations in the sidebar.
struct BrowserShell: View {
    let environment: AppEnvironment
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showsAccounts = false
    @State private var showsSettings = false
    @State private var sidebarSelection: SidebarSelection?

    private var accounts: AccountsModel { environment.accounts }

    var body: some View {
        Group {
            if sizeClass == .compact {
                phone
            } else {
                pad
            }
        }
        .sheet(isPresented: $showsAccounts) {
            AccountsView(accounts: accounts)
        }
        .sheet(isPresented: $showsSettings) {
            SettingsView()
        }
    }

    // MARK: - iPhone

    private var phone: some View {
        TabView {
            ForEach(BrowserDestination.tabs) { destination in
                Tab(destination.tabTitle, systemImage: destination.systemImage) {
                    if let entry = accounts.selectedEntry {
                        DestinationView(environment: environment, entry: entry, destination: destination,
                                        accountMenu: AccountMenu(accounts: accounts) { showsAccounts = true })
                            .id(entry.id)
                    }
                }
            }
            Tab("More", systemImage: "ellipsis") {
                NavigationStack {
                    List {
                        if let entry = accounts.selectedEntry, !BrowserDestination.more.isEmpty {
                            Section {
                                ForEach(BrowserDestination.more) { destination in
                                    NavigationLink {
                                        DestinationView(environment: environment, entry: entry,
                                                        destination: destination, embedded: true)
                                    } label: {
                                        Label(destination.title, systemImage: destination.systemImage)
                                    }
                                    .badge(destination.badge(accountKey: entry.id))
                                    .accessibilityIdentifier("more.\(destination.rawValue)")
                                }
                            }
                        }
                        Section {
                            Button {
                                showsAccounts = true
                            } label: {
                                Label("Accounts", systemImage: "person.crop.circle")
                            }
                            .accessibilityIdentifier("more.accounts")
                            Button {
                                showsSettings = true
                            } label: {
                                Label("Settings", systemImage: "gearshape")
                            }
                            .accessibilityIdentifier("more.settings")
                        }
                    }
                    .navigationTitle("More")
                }
            }
            .badge(UploadCenter.shared.badgeCount())
        }
    }

    // MARK: - iPad

    private var pad: some View {
        NavigationSplitView {
            List(selection: $sidebarSelection) {
                ForEach(accounts.entries) { entry in
                    Section {
                        ForEach(BrowserDestination.sidebar) { destination in
                            Label(destination.title, systemImage: destination.systemImage)
                                .badge(destination.badge(accountKey: entry.id))
                                .tag(SidebarSelection(accountKey: entry.id, destination: destination))
                                .accessibilityIdentifier("sidebar.\(destination.rawValue).\(entry.account.username)")
                            if destination == .files {
                                // The account's team folders and storages right below „Meine Dateien“.
                                ForEach(SpaceDirectory(spaces: entry.account.spaces).others) { space in
                                    SpaceLabel(entry: space)
                                        .padding(.leading, 12)
                                        .tag(SidebarSelection(accountKey: entry.id, destination: .files, spaceId: space.id))
                                        .accessibilityIdentifier("sidebar.space.\(space.title).\(entry.account.username)")
                                }
                            }
                        }
                    } header: {
                        HStack {
                            Text(verbatim: entry.title)
                            if entry.status == .signInRequired {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
            .navigationTitle(Text(verbatim: "Synclet"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showsAccounts = true
                    } label: {
                        Label("Accounts", systemImage: "person.crop.circle")
                    }
                    .accessibilityIdentifier("root.accounts")
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button {
                        showsSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("root.settings")
                }
            }
        } detail: {
            if let selection = sidebarSelection, let entry = accounts.entry(key: selection.accountKey) {
                DestinationView(environment: environment, entry: entry, destination: selection.destination,
                                spaceId: selection.spaceId)
                    .id(selection)
            } else {
                ContentUnavailableView("Choose a Place", systemImage: "sidebar.left")
            }
        }
        .onAppear(perform: syncSidebar)
        .onChange(of: accounts.selectedKey) { syncSidebar() }
        .onChange(of: accounts.entries) { syncSidebar() }
        .onChange(of: sidebarSelection) { _, selection in
            if let key = selection?.accountKey, key != accounts.selectedKey { accounts.selectedKey = key }
        }
    }

    /// Keeps the sidebar on the selected account (after a sign-in or sign-out) and on a space
    /// that still exists.
    private func syncSidebar() {
        guard let key = accounts.selectedKey else {
            sidebarSelection = nil
            return
        }
        if sidebarSelection?.accountKey != key || accounts.entry(key: key) == nil {
            sidebarSelection = SidebarSelection(accountKey: key, destination: sidebarSelection?.destination ?? .files)
        } else if let selection = sidebarSelection, let entry = accounts.entry(key: key) {
            let valid = selection.validated(spaces: entry.account.spaces)
            if valid != selection { sidebarSelection = valid }
        }
    }
}

/// The view of a destination for an account.
struct DestinationView: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    let destination: BrowserDestination
    /// The account menu for the top of the root (iPhone).
    var accountMenu: AccountMenu?
    /// Pushed inside another `NavigationStack` (iPhone „Mehr“): no stack of its own.
    var embedded = false
    /// `.files` of a team folder or storage (iPad sidebar).
    var spaceId: String?

    var body: some View {
        switch destination {
        case .files:
            FolderStack(environment: environment, entry: entry, accountMenu: accountMenu,
                        space: spaceId.flatMap { id in entry.account.spaces.first { $0.id == id } })
        case .uploads:
            if embedded {
                UploadsView(accountKey: entry.id)
            } else {
                NavigationStack { UploadsView(accountKey: entry.id) }
            }
        case .recent:
            RecentView(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded)
        case .search:
            SearchView(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded)
        case .trash:
            TrashView(environment: environment, entry: entry, accountMenu: accountMenu, embedded: embedded)
        }
    }
}

/// The files of an account with their folder navigation. iPhone: an account with team
/// folders or storages starts at the list of its spaces (``SpaceList``), otherwise at „Meine
/// Dateien“. iPad: the sidebar lists the spaces, so this shows one space (`space`, `nil` =
/// „Meine Dateien“).
struct FolderStack: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    var space: SyncSpace?
    @State private var path: [FolderRoute] = []
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Search inside the folders (iPad; Task 8).
    @State private var search: SearchModel?

    private var directory: SpaceDirectory { SpaceDirectory(spaces: entry.account.spaces) }

    /// The space list instead of a folder at the root (iPhone with spaces).
    private var showsSpaceList: Bool { space == nil && sizeClass == .compact && directory.hasSpaces }

    /// Root folder of the space shown.
    private var root: FolderRoute {
        space.map { SpaceEntry(space: $0).route } ?? directory.personal.route
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let api = environment.client(for: entry.id) {
                    Group {
                        if showsSpaceList {
                            SpaceList(directory: directory)
                        } else {
                            FolderView(environment: environment, accountKey: entry.id, api: api, folder: root,
                                       spaces: directory)
                                .folderSearch(search, folder: root, spaces: directory) { path.append($0) }
                        }
                    }
                    .navigationDestination(for: FolderRoute.self) { route in
                        FolderView(environment: environment, accountKey: entry.id, api: api, folder: route,
                                   spaces: directory)
                            .folderSearch(search, folder: route, spaces: directory) { path.append($0) }
                    }
                } else {
                    ContentUnavailableView("Sign-in required", systemImage: "person.crop.circle.badge.exclamationmark")
                        .navigationTitle(Text(verbatim: root.title))
                }
            }
            .toolbar {
                if let accountMenu {
                    ToolbarItem(placement: .topBarLeading) { accountMenu }
                }
            }
        }
        .onAppear {
            if sizeClass != .compact, search == nil, let api = environment.client(for: entry.id) {
                search = SearchModel(api: api)
            }
        }
        .onChange(of: entry.account.spaces) {
            // A space was removed (or lost its access) while it was open: back to the start.
            let ids = Set(entry.account.spaces.map(\.id))
            if path.contains(where: { $0.spaceId.map { !ids.contains($0) } ?? false }) { path = [] }
        }
    }
}

/// Account switch at the top of the iPhone browser, with „Konten …“.
struct AccountMenu: View {
    @Bindable var accounts: AccountsModel
    let showAccounts: () -> Void

    var body: some View {
        Menu {
            if accounts.entries.count > 1 {
                Picker("Account", selection: $accounts.selectedKey) {
                    ForEach(accounts.entries) { entry in
                        Text(verbatim: entry.title).tag(Optional(entry.id))
                    }
                }
                Divider()
            } else if let entry = accounts.selectedEntry {
                Text(verbatim: entry.title)
            }
            Button("Manage Accounts…", systemImage: "person.2") { showAccounts() }
                .accessibilityIdentifier("root.manageAccounts")
        } label: {
            Label("Accounts", systemImage: accounts.selectedEntry?.status == .signInRequired
                  ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle")
        }
        .accessibilityIdentifier("root.accounts")
    }
}
