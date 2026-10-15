import SwiftUI

/// "Letzte Probleme": the last 20 entries of the error log, newest first. Each opens Finder
/// at its file (or the account's folder when the file is gone).
struct ErrorListView: View {
    let problems: [ErrorLogEntry]
    /// Account titles (`user@host`) by key, shown when there is more than one account.
    let accountTitles: [String: String]
    let actions: AppActions

    var body: some View {
        if !problems.isEmpty {
            Section("Recent Problems") {
                ForEach(problems) { entry in
                    Button {
                        actions.revealProblem(entry)
                    } label: {
                        Label(Self.title(entry, accountTitle: accountTitles.count > 1 ? accountTitles[entry.accountKey] : nil),
                              systemImage: entry.isInfo ? "info.circle" : "exclamationmark.triangle")
                    }
                }
                Button("Clear List") { actions.clearProblems() }
            }
        }
    }

    /// "Film.mov – Zu groß für den Server – nicht hochgeladen. (jens@host)".
    static func title(_ entry: ErrorLogEntry, accountTitle: String?) -> String {
        let text = "\(entry.fileName) – \(entry.localizedMessage)"
        guard let accountTitle else { return text }
        return "\(text) (\(accountTitle))"
    }
}
