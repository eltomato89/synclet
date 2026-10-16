import SwiftUI

/// Settings: photo format of uploads and „Cache leeren“.
struct SettingsView: View {
    @AppStorage(UploadCenter.photosAsJPEGKey) private var photosAsJPEG = false
    @Environment(\.dismiss) private var dismiss
    @State private var clearing = false
    @State private var cleared = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Upload Photos as JPEG", isOn: $photosAsJPEG)
                        .accessibilityIdentifier("settings.photosAsJPEG")
                } footer: {
                    Text("Otherwise photos are uploaded in their original format (for example HEIC).")
                }
                Section {
                    Button {
                        Task { await clearCache() }
                    } label: {
                        HStack {
                            Text("Clear Cache")
                            Spacer()
                            if clearing {
                                ProgressView()
                            } else if cleared {
                                Image(systemName: "checkmark").foregroundStyle(.secondary)
                            }
                        }
                    }
                    .disabled(clearing)
                    .accessibilityIdentifier("settings.clearCache")
                } footer: {
                    Text("Removes downloaded files and thumbnails from this device. Your files on the server stay.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func clearCache() async {
        clearing = true
        await FileCache.shared.clear()
        await ThumbnailCache.shared.clear()
        clearing = false
        cleared = true
    }
}
