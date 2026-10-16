import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Where picked files go: the folder the „+“ menu belongs to.
struct UploadTarget: Equatable {
    let accountKey: String
    let parentId: String
    let parentName: String
}

/// „Fotos“ and „Dateien“ for the folder's „+“ menu. The pickers themselves hang off the folder
/// view (``SwiftUI/View/uploadPickers(photos:files:target:)``): a menu closes before it could
/// present them.
struct UploadMenu: View {
    @Binding var showsPhotos: Bool
    @Binding var showsFiles: Bool

    var body: some View {
        Button("Photos", systemImage: "photo.on.rectangle") { showsPhotos = true }
            .accessibilityIdentifier("browser.uploadPhotos")
        Button("Files", systemImage: "doc.badge.plus") { showsFiles = true }
            .accessibilityIdentifier("browser.uploadFiles")
    }
}

extension View {
    /// The photo picker and file importer of ``UploadMenu``; picked items are enqueued into `target`.
    func uploadPickers(photos: Binding<Bool>, files: Binding<Bool>, target: UploadTarget,
                       center: UploadCenter = .shared) -> some View {
        modifier(UploadPickers(showsPhotos: photos, showsFiles: files, target: target, center: center))
    }
}

private struct UploadPickers: ViewModifier {
    @Binding var showsPhotos: Bool
    @Binding var showsFiles: Bool
    let target: UploadTarget
    let center: UploadCenter
    @State private var pickedPhotos: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $showsPhotos, selection: $pickedPhotos, maxSelectionCount: 50,
                          selectionBehavior: .ordered, matching: .any(of: [.images, .videos]),
                          preferredItemEncoding: .current)
            .onChange(of: pickedPhotos) { _, items in
                guard !items.isEmpty else { return }
                pickedPhotos = []
                Task {
                    await center.enqueue(photos: items, accountKey: target.accountKey, parentId: target.parentId,
                                         parentName: target.parentName)
                }
            }
            .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls):
                    Task {
                        await center.enqueue(urls: urls, accountKey: target.accountKey, parentId: target.parentId,
                                             parentName: target.parentName)
                    }
                case .failure(let error):
                    center.notice = error.localizedDescription
                }
            }
            .alert("Upload", isPresented: showsNotice) {
                Button("OK") { center.notice = nil }
            } message: {
                Text(verbatim: center.notice ?? "")
            }
    }

    private var showsNotice: Binding<Bool> {
        Binding(get: { center.notice != nil }, set: { if !$0 { center.notice = nil } })
    }
}
