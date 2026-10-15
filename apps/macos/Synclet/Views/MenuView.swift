import SwiftUI
import SyncletKit

/// Actions of the menu and the settings (provided by the app delegate).
@MainActor
struct AppActions {
    var openInFinder: (String) -> Void
    var openWeb: (String) -> Void
    /// `nil` = add an account; an account = sign in again (prefilled).
    var signIn: (StoredAccount?) -> Void
    var signOut: (String) -> Void
    var showSettings: () -> Void
    var quit: () -> Void
}

/// Content of the menu bar menu (`MenuBarExtra`, menu style).
///
/// Structure: one section per account (title `<user>@<host>`, status line, actions), then the
/// global items. T8 extends the account sections (sync status, last errors).
struct MenuView: View {
    let accounts: AccountsModel
    let actions: AppActions

    var body: some View {
        if accounts.isEmpty {
            Text("No account connected")
        }
        ForEach(accounts.entries) { entry in
            Section(entry.title) {
                AccountMenuSection(entry: entry, actions: actions)
            }
        }
        Divider()
        Button("Add Account…") { actions.signIn(nil) }
            .keyboardShortcut("n")
        Button("Settings…") { actions.showSettings() }
            .keyboardShortcut(",")
        Divider()
        Button("Quit Synclet") { actions.quit() }
            .keyboardShortcut("q")
    }
}

/// The items of one account in the menu.
struct AccountMenuSection: View {
    let entry: AccountEntry
    let actions: AppActions

    var body: some View {
        Label(entry.status.label, systemImage: Self.symbol(for: entry.status))
        if entry.status == .needsLogin {
            Button("Sign In Again…") { actions.signIn(entry.account) }
        }
        Button("Open in Finder") { actions.openInFinder(entry.id) }
        Button("Open Web") { actions.openWeb(entry.id) }
    }

    static func symbol(for status: AccountStatus) -> String {
        switch status {
        case .ok: return "checkmark.circle"
        case .needsLogin: return "person.crop.circle.badge.exclamationmark"
        }
    }
}

/// Menu bar icon (with a hint when an account needs attention).
struct MenuBarLabel: View {
    let accounts: AccountsModel

    var body: some View {
        Image(systemName: accounts.hasProblem ? "exclamationmark.arrow.triangle.2.circlepath" : "arrow.triangle.2.circlepath")
            .accessibilityLabel(accounts.hasProblem ? Text("Synclet – needs attention") : Text("Synclet"))
    }
}
