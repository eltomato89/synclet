import SwiftUI
import SyncletKit

/// Top-level places of the browser. Later tasks add cases (Task 8: „Zuletzt“, „Suche“,
/// „Papierkorb“; Task 9: „Uploads“): the case, its label, its place in ``tabs``/``more``/
/// ``sidebar`` and its view in ``DestinationView``.
enum BrowserDestination: String, Hashable, Identifiable, CaseIterable {
    case files
    case uploads

    var id: String { rawValue }

    /// iPhone tabs (before „Mehr“).
    static let tabs: [BrowserDestination] = [.files]
    /// iPhone „Mehr“ tab, above „Konten“.
    static let more: [BrowserDestination] = [.uploads]
    /// iPad sidebar, below each account.
    static let sidebar: [BrowserDestination] = [.files, .uploads]

    /// Tab title (iPhone).
    var tabTitle: LocalizedStringKey {
        switch self {
        case .files: return "Files"
        case .uploads: return "Uploads"
        }
    }

    /// Sidebar / list title.
    var title: LocalizedStringKey {
        switch self {
        case .files: return "My Files"
        case .uploads: return "Uploads"
        }
    }

    var systemImage: String {
        switch self {
        case .files: return "folder"
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
                DestinationView(environment: environment, entry: entry, destination: selection.destination)
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

    /// Keeps the sidebar on the selected account (after a sign-in or sign-out).
    private func syncSidebar() {
        guard let key = accounts.selectedKey else {
            sidebarSelection = nil
            return
        }
        if sidebarSelection?.accountKey != key || accounts.entry(key: key) == nil {
            sidebarSelection = SidebarSelection(accountKey: key, destination: sidebarSelection?.destination ?? .files)
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

    var body: some View {
        switch destination {
        case .files:
            FolderStack(environment: environment, entry: entry, accountMenu: accountMenu)
        case .uploads:
            if embedded {
                UploadsView(accountKey: entry.id)
            } else {
                NavigationStack { UploadsView(accountKey: entry.id) }
            }
        }
    }
}

/// „Meine Dateien“ of an account with its folder navigation.
struct FolderStack: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    @State private var path: [FolderRoute] = []

    /// Root of the `personal` space.
    private var root: FolderRoute {
        let rootId = entry.account.spaces.first { $0.kind == .personal }?.rootId ?? SyncItem.rootID
        return FolderRoute(id: rootId, title: String(localized: "My Files"))
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let api = environment.client(for: entry.id) {
                    FolderView(environment: environment, accountKey: entry.id, api: api, folder: root, root: root)
                        .navigationDestination(for: FolderRoute.self) { route in
                            FolderView(environment: environment, accountKey: entry.id, api: api, folder: route, root: root)
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
