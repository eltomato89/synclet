import SwiftUI
import SyncletKit

/// Sheet "Add Account" / „Neu anmelden“: server address, then the browser login.
struct LoginView: View {
    @State var model: LoginModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if let notice = model.notice, model.step == .server {
                    Section {
                        Label(notice, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                switch model.step {
                case .server: serverForm
                case .done(let title): done(title)
                }
            }
            .navigationTitle("Add Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if case .server = model.step {
                        Button("Cancel", role: .cancel) { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    switch model.step {
                    case .server:
                        Button {
                            model.start()
                        } label: {
                            if model.isBusy { ProgressView() } else { Text("Sign In") }
                        }
                        .disabled(model.isBusy || model.serverInput.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("login.signIn")
                    case .done:
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("login.done")
                    }
                }
            }
        }
        // Closing the sheet stops the browser login.
        .onDisappear { model.cancel() }
        .interactiveDismissDisabled(model.isBusy)
    }

    private var serverForm: some View {
        Section {
            TextField("Server", text: $model.serverInput, prompt: Text(verbatim: "files.example.com"))
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .disabled(model.isBusy)
                .onSubmit { model.start() }
                .accessibilityIdentifier("login.server")
            if let error = model.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("login.error")
            }
        } footer: {
            Text("You sign in in the browser window that opens next.")
        }
    }

    private func done(_ title: String) -> some View {
        Section {
            Label("Connected as \(title)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text("Your files are also available in the Files app under “Locations”.")
                .foregroundStyle(.secondary)
        }
    }
}
