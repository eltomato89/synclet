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
    /// Opens Finder at the file of a "Letzte Probleme" entry.
    var revealProblem: (ErrorLogEntry) -> Void = { _ in }
    var clearProblems: () -> Void = {}
}

/// Content of the menu bar menu (`MenuBarExtra`, menu style).
///
/// Structure: one section per account (title `<user>@<host>`, status line, actions), then
/// "Letzte Probleme" (when there are any), then the global items.
struct MenuView: View {
    let accounts: AccountsModel
    let problems: ProblemsModel
    let actions: AppActions

    var body: some View {
        let now = Date()
        if accounts.isEmpty {
            Text("No account connected")
        }
        ForEach(accounts.entries) { entry in
            Section(entry.title) {
                AccountStatusView(entry: entry, state: accounts.menuState(for: entry, problems: problems.entries, now: now),
                                  actions: actions, now: now)
            }
        }
        ErrorListView(problems: problems.entries,
                      accountTitles: Dictionary(accounts.entries.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a }),
                      actions: actions)
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

/// Status symbol of an account in the settings list.
enum AccountMenuSection {
    static func symbol(for status: AccountStatus) -> String {
        switch status {
        case .ok: return "checkmark.circle"
        case .needsLogin: return "person.crop.circle.badge.exclamationmark"
        }
    }
}

/// Menu bar icon, with a badge when an account must sign in again or a problem is recent.
struct MenuBarLabel: View {
    let accounts: AccountsModel
    let problems: ProblemsModel

    var body: some View {
        let badge = AccountMenuState.showsBadge(statuses: accounts.entries.map(\.status), problems: problems.entries, now: Date())
        Image(systemName: badge ? "exclamationmark.arrow.triangle.2.circlepath" : "arrow.triangle.2.circlepath")
            .accessibilityLabel(badge ? Text("Synclet – needs attention") : Text("Synclet"))
    }
}
