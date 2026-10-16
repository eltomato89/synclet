import SwiftUI
import UIKit

/// Placeholder of the share extension; Task 9 replaces it with account and folder choice and
/// the upload queue.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: PlaceholderView { [weak self] in self?.close() })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

private struct PlaceholderView: View {
    let close: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "square.and.arrow.up")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                #if DEBUG
                Text(verbatim: "Kommt in Task 9")
                #endif
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: close)
                }
            }
        }
    }
}
