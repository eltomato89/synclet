import SwiftUI
import SyncletKit

/// Root of the app. Without accounts: the empty state with „Konto hinzufügen“. With
/// accounts: a placeholder list (Task 7 replaces it with the browser shell).
struct RootView: View {
    let environment: AppEnvironment
    @State private var showsLogin = false
    @State private var showsAccounts = false

    private var accounts: AccountsModel { environment.accounts }

    var body: some View {
        NavigationStack {
            Group {
                if accounts.entries.isEmpty {
                    emptyState
                } else {
                    accountList
                }
            }
            .navigationTitle(Text(verbatim: "Synclet"))
            .toolbar {
                if !accounts.entries.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            showsAccounts = true
                        } label: {
                            Label("Accounts", systemImage: "person.crop.circle")
                        }
                        .accessibilityIdentifier("root.accounts")
                    }
                }
            }
        }
        .sheet(isPresented: $showsLogin) {
            LoginView(model: LoginModel(accounts: accounts))
        }
        .sheet(isPresented: $showsAccounts) {
            AccountsView(accounts: accounts)
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

    private var accountList: some View {
        List(accounts.entries) { entry in
            Button {
                accounts.selectedKey = entry.id
            } label: {
                HStack {
                    AccountRow(entry: entry)
                    Spacer()
                    if entry.id == accounts.selectedKey {
                        Image(systemName: "checkmark").foregroundStyle(.tint)
                    }
                }
            }
            .foregroundStyle(.primary)
        }
        .accessibilityIdentifier("root.accountList")
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
