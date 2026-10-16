import SwiftUI
import SyncletKit

/// The URL handed to the share sheet.
private struct SharedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// "Share Link": the item's active link (or a new one) with password, expiry, download and
/// (folders) upload; "Share" opens the system share sheet with the URL; "Revoke Link"
/// (confirmed) revokes it.
struct ShareLinkView: View {
    @State private var model: ShareLinkModel
    @Environment(\.dismiss) private var dismiss
    @State private var shared: SharedURL?
    @State private var confirmsRevoke = false

    init(item: SyncItem, api: SyncAPIClient) {
        _model = State(initialValue: ShareLinkModel(item: item, server: api.baseURL, api: api))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Share Link")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("share.done")
                    }
                }
        }
        .task { await model.load() }
        .sheet(item: $shared) { shared in
            ActivityView(items: [shared.url])
                .presentationDetents([.medium, .large])
                #if DEBUG
                // UI tests read the shared URL here (the system sheet's own elements are private).
                .overlay(alignment: .topLeading) {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel(Text(verbatim: shared.url.absoluteString))
                        .accessibilityIdentifier("share.sheet")
                }
                #endif
        }
        .interactiveDismissDisabled(model.isBusy)
    }

    @ViewBuilder
    private var content: some View {
        if model.state == .loaded {
            form
        } else {
            LoadStatePlaceholder(state: model.state, failureTitle: "Can’t Load Link") {
                Task { await model.load() }
            }
        }
    }

    private var form: some View {
        @Bindable var model = model
        return Form {
            Section {
                Label {
                    Text(verbatim: model.item.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } icon: {
                    Image(systemName: ItemFormatting.symbol(for: model.item))
                }
                if let url = model.activeURL {
                    Text(verbatim: url.absoluteString)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("share.url")
                }
            } footer: {
                if model.active == nil {
                    Text("Anyone with the link can open this item.")
                }
            }

            Section {
                Toggle("Password", isOn: $model.usePassword)
                    .accessibilityIdentifier("share.usePassword")
                if model.usePassword {
                    SecureField(passwordPrompt, text: $model.password)
                        .textContentType(.newPassword)
                        .accessibilityIdentifier("share.password")
                }
                Toggle("Expires", isOn: hasExpiry)
                    .accessibilityIdentifier("share.expires")
                if let expiry = model.expiresAt {
                    DatePicker("Expires On", selection: Binding(get: { expiry }, set: { model.expiresAt = $0 }),
                               in: Date()...)
                }
                Toggle("Allow Download", isOn: $model.allowDownload)
                    .accessibilityIdentifier("share.allowDownload")
                if model.isFolder {
                    Toggle("Allow Upload", isOn: $model.allowUpload)
                        .accessibilityIdentifier("share.allowUpload")
                }
            }

            Section {
                Button {
                    Task {
                        if let url = await model.createOrUpdate() { shared = SharedURL(url: url) }
                    }
                } label: {
                    HStack {
                        Label(model.active == nil ? "Create Link" : "Share", systemImage: "square.and.arrow.up")
                        Spacer()
                        if model.isBusy { ProgressView() }
                    }
                }
                .disabled(!canSubmit)
                .accessibilityIdentifier("share.submit")
                if model.active != nil {
                    Button("Revoke Link", systemImage: "xmark.circle", role: .destructive) {
                        confirmsRevoke = true
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier("share.revoke")
                }
            } footer: {
                if let error = model.error {
                    Text(verbatim: error)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("share.error")
                }
            }
        }
        .confirmationDialog("Revoke this link?", isPresented: $confirmsRevoke, titleVisibility: .visible) {
            Button("Revoke Link", role: .destructive) {
                Task { await model.revoke() }
            }
            .accessibilityIdentifier("share.confirmRevoke")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The link stops working for everyone who has it.")
        }
    }

    private var passwordPrompt: LocalizedStringKey {
        model.active?.hasPassword == true ? "New Password (optional)" : "Password"
    }

    /// A password must be entered when it is switched on and the link has none yet.
    private var canSubmit: Bool {
        guard !model.isBusy else { return false }
        if model.usePassword, model.password.isEmpty, model.active?.hasPassword != true { return false }
        return true
    }

    private var hasExpiry: Binding<Bool> {
        Binding(get: { model.expiresAt != nil },
                set: { on in
                    model.expiresAt = on ? (model.expiresAt ?? Calendar.current.date(byAdding: .day, value: 7, to: Date())) : nil
                })
    }
}
