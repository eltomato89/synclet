import SwiftUI
import SyncletKit

/// Actions on an item in the browser (context menu, swipe actions). Later tasks add cases
/// (Task 8: "Share Link") – add the case, its label and its place in ``available(for:)``.
enum ItemAction: String, Hashable, CaseIterable, Identifiable {
    case share
    case rename
    case move
    case delete

    var id: String { rawValue }

    /// The actions the server allows for `item`, in menu order.
    static func available(for item: SyncItem) -> [ItemAction] {
        allCases.filter { action in
            switch action {
            // Creating a link needs write access in the item's space (read-only spaces: none).
            case .share: return item.capabilities.read && item.capabilities.write
            case .rename: return item.capabilities.rename
            case .move: return item.capabilities.move
            case .delete: return item.capabilities.delete
            }
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .share: return "Share Link"
        case .rename: return "Rename"
        case .move: return "Move"
        case .delete: return "Move to Trash"
        }
    }

    var systemImage: String {
        switch self {
        case .share: return "link"
        case .rename: return "pencil"
        case .move: return "folder"
        case .delete: return "trash"
        }
    }

    var role: ButtonRole? { self == .delete ? .destructive : nil }

    /// Accessibility identifier (`item.share`, `item.rename`, `item.move`, `item.delete`).
    var identifier: String { "item.\(rawValue)" }
}

/// The buttons of an item's context menu.
struct ItemActionButtons: View {
    let item: SyncItem
    let perform: (ItemAction, SyncItem) -> Void

    var body: some View {
        ForEach(ItemAction.available(for: item)) { action in
            Button(action.title, systemImage: action.systemImage, role: action.role) {
                perform(action, item)
            }
            .accessibilityIdentifier(action.identifier)
        }
    }
}

extension View {
    /// Context menu with all actions of `item`.
    func itemContextMenu(_ item: SyncItem, perform: @escaping (ItemAction, SyncItem) -> Void) -> some View {
        contextMenu {
            ItemActionButtons(item: item, perform: perform)
        }
    }

    /// Context menu plus swipe actions (delete, rename) for list rows.
    func itemActions(_ item: SyncItem, perform: @escaping (ItemAction, SyncItem) -> Void) -> some View {
        itemContextMenu(item, perform: perform)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                let actions = ItemAction.available(for: item)
                if actions.contains(.delete) {
                    Button(ItemAction.delete.title, systemImage: ItemAction.delete.systemImage, role: .destructive) {
                        perform(.delete, item)
                    }
                }
                if actions.contains(.rename) {
                    Button(ItemAction.rename.title, systemImage: ItemAction.rename.systemImage) {
                        perform(.rename, item)
                    }
                    .tint(.indigo)
                }
            }
    }
}
