import SwiftUI
import SyncletKit

/// The accounts: status, "Sign In Again" and "Sign Out" (with confirmation), "Add Account".
struct AccountsView: View {
    let accounts: AccountsModel
    @Environment(\.dismiss) private var dismiss
    /// Login sheet: `nil` prefill for a new account.
    @State private var login: LoginTarget?
    @State private var signOutCandidate: AccountEntry?
    @State private var signingOut: Set<String> = []

    private struct LoginTarget: Identifiable {
        let id = UUID()
        let prefill: StoredAccount?
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(accounts.entries) { entry in
                        row(entry)
                    }
                }
                Section {
                    Button("Add Account", systemImage: "plus") { login = LoginTarget(prefill: nil) }
                        .accessibilityIdentifier("accounts.add")
                }
            }
            .navigationTitle("Accounts")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $login) { target in
                LoginView(model: LoginModel(accounts: accounts, prefill: target.prefill))
            }
            .confirmationDialog(signOutTitle, isPresented: showsSignOut, titleVisibility: .visible,
                                presenting: signOutCandidate) { entry in
                Button("Sign Out", role: .destructive) { signOut(entry) }
                    .accessibilityIdentifier("accounts.confirmSignOut")
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Your files stay on the server. The copies on this device and changes that have not been uploaded are removed.")
            }
        }
    }

    private func row(_ entry: AccountEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            AccountRow(entry: entry)
            HStack {
                Button("Sign In Again") {
                    login = LoginTarget(prefill: entry.account)
                }
                .buttonStyle(.bordered)
                .tint(entry.status == .signInRequired ? .orange : nil)
                .accessibilityIdentifier("accounts.signIn.\(entry.account.username)")
                Spacer()
                if signingOut.contains(entry.id) {
                    ProgressView()
                } else {
                    Button("Sign Out", role: .destructive) { signOutCandidate = entry }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("accounts.signOut.\(entry.account.username)")
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var signOutTitle: Text {
        Text("Sign out \(signOutCandidate?.title ?? "")?")
    }

    private var showsSignOut: Binding<Bool> {
        Binding(get: { signOutCandidate != nil }, set: { if !$0 { signOutCandidate = nil } })
    }

    private func signOut(_ entry: AccountEntry) {
        signingOut.insert(entry.id)
        Task {
            await accounts.signOut(key: entry.id)
            signingOut.remove(entry.id)
        }
    }
}
