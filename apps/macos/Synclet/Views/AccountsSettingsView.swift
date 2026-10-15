import SwiftUI
import SyncletKit

/// Tab "Accounts": list, add, sign in again, sign out.
struct AccountsSettingsView: View {
    let accounts: AccountsModel
    let actions: AppActions

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if accounts.isEmpty {
                ContentUnavailableView("No account connected", systemImage: "person.crop.circle.badge.plus",
                                       description: Text("Add your Synclet server to see your files in Finder."))
            } else {
                List(accounts.entries) { entry in
                    AccountRow(entry: entry, actions: actions)
                }
            }
            Divider()
            HStack {
                Button("Add Account…") { actions.signIn(nil) }
                Spacer()
            }
            .padding(12)
        }
    }
}

/// One account in the list.
struct AccountRow: View {
    let entry: AccountEntry
    let actions: AppActions

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: AccountMenuSection.symbol(for: entry.status))
                .font(.title2)
                .foregroundStyle(entry.status == .ok ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.headline)
                Text(verbatim: "\(entry.account.displayName) · \(entry.status.label)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if entry.status == .needsLogin {
                Button("Sign In Again…") { actions.signIn(entry.account) }
            }
            Button("Sign Out…") { actions.signOut(entry.id) }
        }
        .padding(.vertical, 4)
    }
}
