import SwiftUI
import SyncletKit

/// Tab "Offline": per account and space (personal, team folders, external storages) a
/// "whole space" switch and one switch per first-level folder; the footer shows the size of
/// the pinned content.
struct PinningSettingsView: View {
    let model: PinningModel

    var body: some View {
        Group {
            if model.accounts.isEmpty {
                ContentUnavailableView("No account connected", systemImage: "icloud.and.arrow.down",
                                       description: Text("Add your Synclet server to see your files in Finder."))
            } else {
                Form {
                    Section {
                        Text("Pinned folders stay downloaded on this Mac, including new files. Everything else is downloaded when you open it.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let error = model.errorMessage {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                    }
                    ForEach(model.accounts) { account in
                        ForEach(account.spaces) { space in
                            SpacePinsSection(model: model, account: account, space: space)
                        }
                        Section {
                            LabeledContent("Pinned content") {
                                if let bytes = account.offlineBytes {
                                    Text(verbatim: "≈ \(bytes.formatted(.byteCount(style: .file)))")
                                } else if model.isRefreshing(key: account.key) {
                                    Text("Calculating…")
                                } else {
                                    Text(verbatim: "–")
                                }
                            }
                        }
                    }
                }
                .formStyle(.grouped)
            }
        }
        .task { await model.loadAll() }
    }
}

/// One space: whole-space switch plus first-level folders.
private struct SpacePinsSection: View {
    let model: PinningModel
    let account: PinningModel.AccountState
    let space: PinningModel.SpaceState

    var body: some View {
        Section {
            Toggle("Entire space offline", isOn: Binding(
                get: { space.wholeSpace },
                set: { on in Task { await model.setWholeSpace(on, key: account.key, space: space.id) } }
            ))
            if space.isLoading && space.folders.isEmpty {
                ProgressView().controlSize(.small)
            } else if let error = space.error {
                HStack {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button("Try Again") { Task { await model.load(key: account.key, spaces: [space.id]) } }
                }
            } else if space.folders.isEmpty {
                Text("No folders").foregroundStyle(.secondary)
            }
            ForEach(space.folders) { folder in
                Toggle(isOn: Binding(
                    get: { space.wholeSpace || space.isPinned(folder.id) },
                    set: { on in Task { await model.setFolder(folder.id, pinned: on, key: account.key, space: space.id) } }
                )) {
                    HStack {
                        Label(folder.name, systemImage: "folder")
                        Spacer()
                        if let size = space.sizeHint(folder.id) {
                            Text(verbatim: "≈ \(size.formatted(.byteCount(style: .file)))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(space.wholeSpace)
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "\(account.title) · \(space.title)")
                if let detail = space.detail {
                    Text(verbatim: detail).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}
