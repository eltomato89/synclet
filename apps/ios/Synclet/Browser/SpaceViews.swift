import SwiftUI
import SyncletKit

/// A space in a list: its symbol (team = people, storage = drive), its name, a lock for read
/// only and "Not Available" / "Read Only" below the name.
struct SpaceLabel: View {
    let entry: SpaceEntry

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entry.title)
                if let subtitle = entry.subtitle {
                    Text(verbatim: subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: entry.isAvailable ? entry.systemImage : "exclamationmark.triangle")
                .foregroundStyle(entry.isAvailable ? AnyShapeStyle(.tint) : AnyShapeStyle(.orange))
                .overlay(alignment: .bottomTrailing) {
                    if entry.isReadOnly, entry.isAvailable {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                            .offset(x: 4, y: 3)
                    }
                }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The iPhone "Files" root of an account with spaces: "My Files", then the section
/// "Spaces" with the team folders and external storages.
struct SpaceList: View {
    let directory: SpaceDirectory

    var body: some View {
        List {
            Section {
                row(directory.personal)
            }
            Section("Spaces") {
                ForEach(directory.others) { entry in
                    row(entry)
                }
            }
        }
        .navigationTitle("Files")
    }

    private func row(_ entry: SpaceEntry) -> some View {
        NavigationLink(value: entry.route) {
            SpaceLabel(entry: entry)
        }
        .accessibilityIdentifier("spaces.\(entry.title)")
    }
}

/// "Not Available": the storage of the space is missing on the server (`503 space_unavailable`).
struct SpaceUnavailableView: View {
    var retry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("Not Available", systemImage: "externaldrive.badge.exclamationmark")
        } description: {
            Text("The storage of this space can’t be reached on the server right now.")
        } actions: {
            if let retry {
                Button("Try Again", action: retry)
                    .buttonStyle(.borderedProminent)
            }
        }
        .accessibilityIdentifier("browser.unavailable")
    }
}

/// "Read Only" above a folder without write access.
struct ReadOnlyBar: View {
    var body: some View {
        Label("Read Only", systemImage: "lock.fill")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.bar)
            .accessibilityIdentifier("browser.readOnly")
    }
}
