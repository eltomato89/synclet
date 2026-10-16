import SwiftUI
import SyncletKit

/// „Uploads“: the queue of an account with progress, errors, „Erneut versuchen“, „Entfernen“
/// and „Abbrechen“.
struct UploadsView: View {
    var center: UploadCenter = .shared
    /// Only this account's uploads (`nil`: all).
    let accountKey: String?

    private var entries: [UploadEntry] {
        center.entries.filter { accountKey == nil || $0.accountKey == accountKey }
    }

    var body: some View {
        List {
            ForEach(entries) { entry in
                UploadRow(entry: entry, fraction: center.fraction(for: entry),
                          retry: { center.retry(entry.id) },
                          cancel: { Task { await center.cancel(entry.id) } })
            }
        }
        .listStyle(.plain)
        .overlay {
            if entries.isEmpty {
                ContentUnavailableView("No Uploads", systemImage: "arrow.up.circle",
                                       description: Text("Photos and files you upload appear here."))
            }
        }
        .navigationTitle("Uploads")
        .toolbar {
            if entries.contains(where: { $0.status == .done }) {
                ToolbarItem(placement: .primaryAction) {
                    Button("Clear Finished") { center.removeFinished() }
                        .accessibilityIdentifier("uploads.clearFinished")
                }
            }
        }
        .refreshable { center.reload() }
        .onAppear { center.reload() }
    }
}

/// Name, „→ <Zielordner>“, status or progress and the entry's actions.
struct UploadRow: View {
    let entry: UploadEntry
    let fraction: Double?
    let retry: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: entry.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(verbatim: "→ \(entry.parentName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                actions
            }
            status
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("uploads.row.\(entry.name)")
    }

    @ViewBuilder
    private var status: some View {
        switch entry.status {
        case .waiting:
            Label(entry.nextAttemptAt == nil ? "Waiting" : "Retrying Soon", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .uploading:
            if let fraction {
                ProgressView(value: fraction)
            } else {
                ProgressView(value: 0)
                    .opacity(0.5)
            }
        case .done:
            Label("Uploaded", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case .failed:
            Label((entry.failure ?? .other).displayText, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .accessibilityIdentifier("uploads.failure")
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch entry.status {
        case .waiting, .uploading:
            Button("Cancel", role: .cancel, action: cancel)
                .buttonStyle(.borderless)
                .accessibilityIdentifier("uploads.cancel")
        case .failed:
            HStack(spacing: 12) {
                Button("Try Again", action: retry)
                    .accessibilityIdentifier("uploads.retry")
                Button("Remove", role: .destructive, action: cancel)
                    .accessibilityIdentifier("uploads.remove")
            }
            .buttonStyle(.borderless)
            .font(.callout)
        case .done:
            EmptyView()
        }
    }
}
