import SwiftUI

/// Settings window. Tabs: "General" (login item), "Accounts" and "Offline" (pinning).
struct SettingsView: View {
    enum Tab: Hashable {
        case general
        case accounts
        case offline
    }

    let accounts: AccountsModel
    let pinning: PinningModel
    @Bindable var loginItem: LoginItemController
    let actions: AppActions
    @State var selection: Tab = .accounts

    var body: some View {
        TabView(selection: $selection) {
            GeneralSettingsView(loginItem: loginItem)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(Tab.general)
            AccountsSettingsView(accounts: accounts, actions: actions)
                .tabItem { Label("Accounts", systemImage: "person.crop.circle") }
                .tag(Tab.accounts)
            PinningSettingsView(model: pinning)
                .tabItem { Label("Offline", systemImage: "icloud.and.arrow.down") }
                .tag(Tab.offline)
        }
        .frame(width: 520, height: 380)
    }
}

/// Tab "General".
struct GeneralSettingsView: View {
    @Bindable var loginItem: LoginItemController

    var body: some View {
        Form {
            Section {
                Toggle("Start at login", isOn: Binding(
                    get: { loginItem.isEnabled },
                    set: { loginItem.setEnabled($0) }
                ))
                if loginItem.requiresApproval {
                    Text("Please allow Synclet in System Settings under General > Login Items & Extensions.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let error = loginItem.errorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            Section {
                Text("Right-click a file or folder in Finder: “Download Now” loads it, “Remove Download” frees the space.")
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Offline")
            }
        }
        .formStyle(.grouped)
        .onAppear { loginItem.reload() }
    }
}
