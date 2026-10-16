import SwiftUI
import SyncletKit

/// Root of the app. Without accounts: the empty state with "Add Account". With
/// accounts: the browser (``BrowserShell``).
struct RootView: View {
    let environment: AppEnvironment
    @State private var showsLogin = false

    private var accounts: AccountsModel { environment.accounts }

    var body: some View {
        // A stable container: the login sheet outlives the switch to the browser (its success page).
        ZStack {
            if accounts.entries.isEmpty {
                NavigationStack {
                    emptyState
                        .navigationTitle(Text(verbatim: "Synclet"))
                }
            } else {
                BrowserShell(environment: environment)
            }
        }
        .sheet(isPresented: $showsLogin) {
            LoginView(model: LoginModel(accounts: accounts))
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Connect Synclet", systemImage: "externaldrive.connected.to.line.below")
        } description: {
            Text("Sign in to your Synclet server to see your files here and in the Files app.")
        } actions: {
            Button("Add Account") { showsLogin = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("root.addAccount")
        }
    }
}

/// Title and status of an account.
struct AccountRow: View {
    let entry: AccountEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: entry.title)
            Label(entry.status.label, systemImage: entry.status == .ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(entry.status == .ok ? Color.secondary : Color.orange)
        }
    }
}
