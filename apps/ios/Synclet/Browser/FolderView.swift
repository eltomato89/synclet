import SwiftUI
import SyncletKit

/// What the name sheet is for.
private enum NameRequest: Identifiable {
    case newFolder
    case rename(SyncItem)

    var id: String {
        switch self {
        case .newFolder: return "new"
        case .rename(let item): return "rename-\(item.id)"
        }
    }
}

/// One folder: list or grid, sorting, „+“ menu, multi-select, rename/move/delete, opening
/// files (download, then QuickLook). Reloads on pull-to-refresh, on change events of its
/// account (debounced), when it appears again and when the scene becomes active.
struct FolderView: View {
    let environment: AppEnvironment
    /// „Meine Dateien“ of the account (start of the move picker).
    let root: FolderRoute
    @State private var model: FolderModel

    @AppStorage("browserLayout") private var layout: BrowserLayout = .list
    @AppStorage("browserSort") private var sort: BrowserSort = .name
    @Environment(\.scenePhase) private var scenePhase
    @State private var editMode: EditMode = .inactive
    @State private var selection: Set<String> = []
    @State private var nameRequest: NameRequest?
    @State private var deleteCandidates: [SyncItem] = []
    @State private var moveCandidates: [SyncItem] = []
    @State private var opening: SyncItem?
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false

    init(environment: AppEnvironment, accountKey: String, api: SyncAPIClient, folder: FolderRoute, root: FolderRoute) {
        self.environment = environment
        self.root = root
        _model = State(initialValue: FolderModel(
            accountKey: accountKey, folderId: folder.id, title: folder.title, api: api,
            signal: { key in await environment.signalWorkingSet(accountKey: key) }))
    }

    private var isEditing: Bool { editMode.isEditing }
    private var selectedItems: [SyncItem] { model.items.filter { selection.contains($0.id) } }

    var body: some View {
        content
            .navigationTitle(Text(verbatim: model.title))
            .environment(\.editMode, $editMode)
            .toolbar { toolbar }
            .refreshable { await model.load() }
            .task {
                model.sort = sort
                await model.load()
            }
            .task(id: model.accountKey) {
                await model.observe(environment.accounts.changeEvents)
            }
            .onChange(of: scenePhase) { _, phase in
                // Monitors are recreated after the background and don't replay missed changes.
                if phase == .active { Task { await model.load() } }
            }
            .onChange(of: sort) { _, newValue in model.sort = newValue }
            .onChange(of: model.items) { _, items in
                selection.formIntersection(items.map(\.id))
            }
            .onChange(of: isEditing) { _, editing in
                if !editing { selection = [] }
            }
            .overlay(alignment: .bottom) { noticeBanner }
            .uploadPickers(photos: $showsPhotoPicker, files: $showsFileImporter,
                           target: UploadTarget(accountKey: model.accountKey, parentId: model.folderId,
                                                parentName: model.title))
            .sheet(item: $nameRequest) { request in
                nameSheet(request)
            }
            .sheet(isPresented: showsMovePicker) {
                MovePicker(api: model.api, accountKey: model.accountKey, root: root, moving: moveCandidates,
                           sourceFolderId: model.folderId) { target in
                    let items = moveCandidates
                    Task {
                        await model.move(items, to: target)
                        finishEditing()
                    }
                }
            }
            .sheet(item: $opening) { item in
                OpenFileSheet(item: item, api: model.api)
            }
            .confirmationDialog(deleteTitle, isPresented: showsDeleteConfirmation, titleVisibility: .visible) {
                Button("Move to Trash", role: .destructive) {
                    let items = deleteCandidates
                    Task {
                        await model.delete(items)
                        finishEditing()
                    }
                }
                .accessibilityIdentifier("item.confirmDelete")
                Button("Cancel", role: .cancel) {}
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .offline:
            ContentUnavailableView {
                Label("Offline", systemImage: "wifi.slash")
            } description: {
                Text("Your files can only be browsed with a connection to the server.")
            } actions: {
                Button("Try Again") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("browser.retry")
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("Can’t Load Folder", systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .idle, .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded:
            Group {
                switch layout {
                case .list: list
                case .grid: grid
                }
            }
            .overlay {
                if model.items.isEmpty {
                    ContentUnavailableView("Empty Folder", systemImage: "folder",
                                           description: Text("This folder is empty."))
                }
            }
        }
    }

    private var list: some View {
        List(selection: $selection) {
            ForEach(model.items) { item in
                Group {
                    if item.isFolder {
                        NavigationLink(value: FolderRoute(id: item.id, title: item.name)) {
                            ItemRow(item: item, api: model.api)
                        }
                    } else {
                        Button {
                            opening = item
                        } label: {
                            ItemRow(item: item, api: model.api)
                        }
                        .foregroundStyle(.primary)
                    }
                }
                .accessibilityIdentifier("browser.item.\(item.name)")
                .itemActions(item, perform: perform)
            }
        }
        .listStyle(.plain)
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 12)], spacing: 16) {
                ForEach(model.items) { item in
                    gridCell(item)
                }
            }
            .padding()
        }
    }

    @ViewBuilder
    private func gridCell(_ item: SyncItem) -> some View {
        let cell = ItemGridCell(item: item, api: model.api, isSelecting: isEditing,
                                isSelected: selection.contains(item.id))
        Group {
            if isEditing {
                Button {
                    if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
                } label: { cell }
            } else if item.isFolder {
                NavigationLink(value: FolderRoute(id: item.id, title: item.name)) { cell }
            } else {
                Button { opening = item } label: { cell }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("browser.item.\(item.name)")
        .itemContextMenu(item, perform: perform)
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = model.notice {
            Text(verbatim: notice)
                .font(.callout)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.thickMaterial, in: Capsule())
                .padding(.bottom, isEditing ? 64 : 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("browser.notice")
                .onTapGesture { model.notice = nil }
                .task(id: notice) {
                    try? await Task.sleep(for: .seconds(4))
                    if model.notice == notice { withAnimation { model.notice = nil } }
                }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if !isEditing {
                addMenu
                Menu {
                    Picker("Sort By", selection: $sort) {
                        Text("Name").tag(BrowserSort.name)
                        Text("Date Modified").tag(BrowserSort.modified)
                        Text("Size").tag(BrowserSort.size)
                    }
                } label: {
                    Label("Sort By", systemImage: "arrow.up.arrow.down")
                }
                .accessibilityIdentifier("browser.sort")
                Button {
                    layout = layout == .list ? .grid : .list
                } label: {
                    layout == .list
                        ? Label("Show as Grid", systemImage: "square.grid.2x2")
                        : Label("Show as List", systemImage: "list.bullet")
                }
                .accessibilityIdentifier("browser.layout")
            }
            if model.state == .loaded, !model.items.isEmpty {
                EditButton()
            }
        }
        if isEditing {
            ToolbarItemGroup(placement: .bottomBar) {
                Button("Move", systemImage: "folder") {
                    moveCandidates = selectedItems
                }
                .disabled(selectedItems.isEmpty || !selectedItems.allSatisfy(\.capabilities.move))
                Spacer()
                Text("\(selection.count) selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Move to Trash", systemImage: "trash", role: .destructive) {
                    deleteCandidates = selectedItems
                }
                .disabled(selectedItems.isEmpty || !selectedItems.allSatisfy(\.capabilities.delete))
            }
        }
    }

    /// The „+“ menu: uploads (photos, files) and „Neuer Ordner“.
    private var addMenu: some View {
        Menu {
            UploadMenu(showsPhotos: $showsPhotoPicker, showsFiles: $showsFileImporter)
            Button("New Folder", systemImage: "folder.badge.plus") {
                model.fieldError = nil
                nameRequest = .newFolder
            }
            .accessibilityIdentifier("browser.newFolder")
        } label: {
            Label("Add", systemImage: "plus")
        }
        .accessibilityIdentifier("browser.addMenu")
    }

    // MARK: - Actions

    private func perform(_ action: ItemAction, _ item: SyncItem) {
        switch action {
        case .rename:
            model.fieldError = nil
            nameRequest = .rename(item)
        case .move:
            moveCandidates = [item]
        case .delete:
            deleteCandidates = [item]
        }
    }

    private func finishEditing() {
        selection = []
        editMode = .inactive
    }

    private var showsMovePicker: Binding<Bool> {
        Binding(get: { !moveCandidates.isEmpty }, set: { if !$0 { moveCandidates = [] } })
    }

    private var showsDeleteConfirmation: Binding<Bool> {
        Binding(get: { !deleteCandidates.isEmpty }, set: { if !$0 { deleteCandidates = [] } })
    }

    private var deleteTitle: Text {
        if deleteCandidates.count == 1, let item = deleteCandidates.first {
            return Text("Move “\(item.name)” to the Trash?")
        }
        return Text("Move \(deleteCandidates.count) items to the Trash?")
    }

    @ViewBuilder
    private func nameSheet(_ request: NameRequest) -> some View {
        switch request {
        case .newFolder:
            NameSheet(title: "New Folder", confirmTitle: "Create", initialName: "", error: model.fieldError,
                      clearError: { model.fieldError = nil }) { name in
                let ok = await model.createFolder(name: name)
                return ok || model.fieldError == nil
            }
        case .rename(let item):
            NameSheet(title: "Rename", confirmTitle: "Rename", initialName: item.name, error: model.fieldError,
                      clearError: { model.fieldError = nil }) { name in
                let ok = await model.rename(item, to: name)
                return ok || model.fieldError == nil
            }
        }
    }
}

/// Name input for „Neuer Ordner“ and „Umbenennen“: live pre-check, inline server errors; the
/// sheet stays open while the name is rejected.
struct NameSheet: View {
    let title: LocalizedStringKey
    let confirmTitle: LocalizedStringKey
    let initialName: String
    /// Error of the last attempt (from the model).
    let error: String?
    let clearError: () -> Void
    /// Sends the name; `true` closes the sheet.
    let submit: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isBusy = false
    @FocusState private var focused: Bool

    private var problem: String? {
        name.isEmpty ? nil : MutationErrors.nameProblem(name)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(send)
                        .accessibilityIdentifier("name.field")
                } footer: {
                    if let message = problem ?? error {
                        Text(verbatim: message)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("name.error")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isBusy {
                        ProgressView()
                    } else {
                        Button(confirmTitle, action: send)
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || problem != nil)
                            .accessibilityIdentifier("name.confirm")
                    }
                }
            }
            .onChange(of: name) { clearError() }
            .onAppear {
                name = initialName
                focused = true
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isBusy)
    }

    private func send() {
        guard !isBusy, problem == nil, !name.isEmpty else { return }
        isBusy = true
        Task {
            let close = await submit(name)
            isBusy = false
            if close { dismiss() }
        }
    }
}

/// Opening a file: download into the file cache with progress, then QuickLook.
struct OpenFileSheet: View {
    let item: SyncItem
    let api: SyncAPIClient
    @Environment(\.dismiss) private var dismiss
    @State private var progress = Progress(totalUnitCount: 0)
    @State private var url: URL?
    @State private var failure: String?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let url {
                QuickLookView(url: url) { dismiss() }
                    .ignoresSafeArea()
            } else {
                NavigationStack {
                    VStack(spacing: 20) {
                        ItemThumbnail(item: item, api: api, side: 72)
                        Text(verbatim: item.name)
                            .font(.headline)
                            .multilineTextAlignment(.center)
                        if let failure {
                            Text(verbatim: failure)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            Button("Try Again") {
                                self.failure = nil
                                attempt += 1
                            }
                            .buttonStyle(.borderedProminent)
                        } else {
                            ProgressView(progress)
                                .frame(maxWidth: 280)
                                .accessibilityIdentifier("open.progress")
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { dismiss() }
                        }
                    }
                }
            }
        }
        .task(id: attempt) { await download() }
    }

    private func download() async {
        let progress = Progress(totalUnitCount: max(item.size, 1))
        self.progress = progress
        do {
            url = try await FileCache.shared.localURL(for: item, api: api, progress: progress)
        } catch is CancellationError {
            return
        } catch {
            failure = MutationErrors.message(MutationErrors.outcome(for: error)) ?? error.localizedDescription
        }
    }
}
