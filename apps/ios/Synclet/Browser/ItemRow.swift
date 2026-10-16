import SwiftUI
import SyncletKit

/// List row: thumbnail (or a symbol by type), name, size and date.
struct ItemRow: View {
    let item: SyncItem
    let api: SyncAPIClient
    /// The item's space in lists across spaces („Zuletzt“); `nil` in a folder.
    var space: String?

    var body: some View {
        HStack(spacing: 12) {
            ItemThumbnail(item: item, api: api, side: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(verbatim: [space, ItemFormatting.subtitle(for: item)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The server thumbnail of an item, or a symbol for its type while there is none.
struct ItemThumbnail: View {
    let item: SyncItem
    let api: SyncAPIClient
    let side: CGFloat
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: side * 0.15))
            } else {
                Image(systemName: ItemFormatting.symbol(for: item))
                    .font(.system(size: side * 0.6))
                    .foregroundStyle(item.isFolder ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .symbolRenderingMode(.hierarchical)
            }
        }
        .frame(width: side, height: side)
        // The thumbnail flag is part of the id: it turns true after an upload once the server rendered it.
        .task(id: "\(item.contentEtag ?? item.etag)|\(item.preview?.thumbnail == true)") {
            guard item.preview?.thumbnail == true else {
                image = nil
                return
            }
            image = await ThumbnailCache.shared.image(for: item, api: api)
        }
    }
}

/// Symbols and subtitles of items.
enum ItemFormatting {
    static func symbol(for item: SyncItem) -> String {
        if item.isFolder { return "folder.fill" }
        let mime = item.mime?.lowercased() ?? ""
        let ext = (item.name as NSString).pathExtension.lowercased()
        switch true {
        case mime.hasPrefix("image/"): return "photo"
        case mime.hasPrefix("video/"): return "film"
        case mime.hasPrefix("audio/"): return "music.note"
        case mime == "application/pdf": return "doc.richtext"
        case mime.contains("zip") || mime.contains("compressed") || ["zip", "tar", "gz", "7z", "rar"].contains(ext):
            return "doc.zipper"
        case mime.contains("spreadsheet") || mime.contains("excel") || ["xlsx", "xls", "csv", "numbers"].contains(ext):
            return "tablecells"
        case mime.contains("presentation") || mime.contains("powerpoint") || ["pptx", "ppt", "key"].contains(ext):
            return "rectangle.on.rectangle"
        case mime.hasPrefix("text/") || mime.contains("json") || mime.contains("xml"): return "doc.text"
        default: return "doc"
        }
    }

    /// Files: „12 KB · 3. Okt. 2026“; folders: the date.
    static func subtitle(for item: SyncItem) -> String {
        let date = item.modifiedDate.map { $0.formatted(date: .abbreviated, time: .shortened) }
        if item.isFolder { return date ?? "" }
        let size = ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file)
        return [size, date].compactMap { $0 }.joined(separator: " · ")
    }
}
