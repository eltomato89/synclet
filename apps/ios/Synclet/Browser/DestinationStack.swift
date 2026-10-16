import SwiftUI
import SyncletKit

extension AccountEntry {
    /// The account's spaces ("My Files", team folders, storages).
    var spaces: SpaceDirectory { SpaceDirectory(spaces: account.spaces) }
}

/// The navigation around a destination other than "My Files" (Zuletzt, Suche, Papierkorb):
/// its own `NavigationStack` (unless pushed inside another one, iPhone "More"), folders pushed
/// as ``FolderView``, the account menu at the top, "Sign-in required" without a client.
struct DestinationStack<Content: View>: View {
    let environment: AppEnvironment
    let entry: AccountEntry
    var accountMenu: AccountMenu?
    var embedded = false
    let title: LocalizedStringKey
    /// The destination's content; the closure opens a folder.
    @ViewBuilder let content: (SyncAPIClient, @escaping (FolderRoute) -> Void) -> Content

    @State private var path: [FolderRoute] = []
    /// Folders opened while embedded (the outer stack has no path for us).
    @State private var embeddedFolder: FolderRoute?

    var body: some View {
        if embedded {
            inner(open: { embeddedFolder = $0 })
                .navigationDestination(item: $embeddedFolder) { route in
                    folderView(route)
                }
        } else {
            NavigationStack(path: $path) {
                inner(open: { path.append($0) })
                    .toolbar {
                        if let accountMenu {
                            ToolbarItem(placement: .topBarLeading) { accountMenu }
                        }
                    }
            }
        }
    }

    @ViewBuilder
    private func inner(open: @escaping (FolderRoute) -> Void) -> some View {
        Group {
            if let api = environment.client(for: entry.id) {
                content(api, open)
                    .navigationDestination(for: FolderRoute.self) { route in
                        folderView(route)
                    }
            } else {
                ContentUnavailableView("Sign-in required", systemImage: "person.crop.circle.badge.exclamationmark")
            }
        }
        .navigationTitle(title)
    }

    @ViewBuilder
    private func folderView(_ route: FolderRoute) -> some View {
        if let api = environment.client(for: entry.id) {
            FolderView(environment: environment, accountKey: entry.id, api: api, folder: route, spaces: entry.spaces)
        }
    }
}

/// A short message at the bottom that disappears after four seconds or on a tap.
struct NoticeBanner: View {
    @Binding var notice: String?
    var identifier = "browser.notice"

    var body: some View {
        if let notice {
            Text(verbatim: notice)
                .font(.callout)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.thickMaterial, in: Capsule())
                .padding(.horizontal)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier(identifier)
                .onTapGesture { self.notice = nil }
                .task(id: notice) {
                    try? await Task.sleep(for: .seconds(4))
                    if self.notice == notice { withAnimation { self.notice = nil } }
                }
        }
    }
}

/// "Offline" / error placeholder with "Try Again" for a list destination.
struct LoadStatePlaceholder: View {
    let state: LoadState
    let failureTitle: LocalizedStringKey
    let retry: () -> Void

    var body: some View {
        switch state {
        case .offline:
            ContentUnavailableView {
                Label("Offline", systemImage: "wifi.slash")
            } description: {
                Text("Your files can only be browsed with a connection to the server.")
            } actions: {
                Button("Try Again", action: retry)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("browser.retry")
            }
        case .unavailable:
            SpaceUnavailableView(retry: retry)
        case .failed(let message):
            ContentUnavailableView {
                Label(failureTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: message)
            } actions: {
                Button("Try Again", action: retry)
                    .buttonStyle(.borderedProminent)
            }
        case .idle, .loading, .loaded:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

extension View {
    /// Context menu with "Share Link" only (lists outside a folder: recent items, search hits).
    func shareLinkContextMenu(_ item: SyncItem, share: @escaping (SyncItem) -> Void) -> some View {
        contextMenu {
            if ItemAction.available(for: item).contains(.share) {
                Button(ItemAction.share.title, systemImage: ItemAction.share.systemImage) { share(item) }
                    .accessibilityIdentifier(ItemAction.share.identifier)
            }
        }
    }
}
