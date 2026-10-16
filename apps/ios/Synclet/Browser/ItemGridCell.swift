import SwiftUI
import SyncletKit

/// Grid cell: a large thumbnail (or symbol) with the name below; a check mark while selecting.
struct ItemGridCell: View {
    let item: SyncItem
    let api: SyncAPIClient
    var isSelecting = false
    var isSelected = false

    var body: some View {
        VStack(spacing: 6) {
            ItemThumbnail(item: item, api: api, side: 88)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .topTrailing) {
                    if isSelecting {
                        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                            .background(Circle().fill(.background))
                            .accessibilityHidden(true)
                    }
                }
            Text(verbatim: item.name)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .truncationMode(.middle)
            Text(verbatim: item.isFolder ? "" : ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 10).fill(isSelected ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.clear)))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
