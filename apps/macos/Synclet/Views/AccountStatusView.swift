import SwiftUI
import SyncletKit

/// The items of one account in the menu: status line ("Verbunden · Synchronisiert vor …",
/// "Offline", "Anmeldung erforderlich", "Fehler"), "Erneut anmelden" when needed,
/// "Im Finder öffnen", "Web öffnen".
struct AccountStatusView: View {
    let entry: AccountEntry
    let state: AccountMenuState
    let actions: AppActions
    var now = Date()

    var body: some View {
        Label(state.label(now: now), systemImage: state.symbol)
        if state.showsSignInAgain {
            Button("Sign In Again…") { actions.signIn(entry.account) }
        }
        Button("Open in Finder") { actions.openInFinder(entry.id) }
        Button("Open Web") { actions.openWeb(entry.id) }
    }
}
