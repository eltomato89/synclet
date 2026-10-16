import SwiftUI

/// Window "Add Account": server address, then the browser login.
struct LoginView: View {
    @Bindable var model: LoginModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if let notice = model.notice, model.step == .server {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch model.step {
            case .server: serverForm
            case .done(let title): done(title)
            }
        }
        .padding(24)
        .frame(width: 420)
        // Closing the window (Cancel, close button, or a new login window) stops the browser login.
        .onDisappear { model.cancel() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: 2) {
                Text("Connect Synclet").font(.title2.bold())
                Text("Your files appear in Finder under “Locations” afterwards.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var serverForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Server", text: $model.serverInput, prompt: Text(verbatim: "files.example.com"))
                .textContentType(.URL)
                .disabled(model.isBusy)
                .onSubmit { model.start() }
                .accessibilityIdentifier("login.server")
            Text("You sign in in the browser window that opens next.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = model.errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("login.error")
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: close)
                    .keyboardShortcut(.cancelAction)
                Button {
                    model.start()
                } label: {
                    if model.isBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Sign In")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isBusy || model.serverInput.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("login.signIn")
            }
            .padding(.top, 4)
        }
    }

    private func done(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Connected as \(title)", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
            Text("The folder appears in the Finder sidebar under “Locations”. Files are downloaded when you open them.")
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Done", action: close)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}
