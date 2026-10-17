package tech.jensk.synclet.ui.browser

import java.text.Collator
import tech.jensk.synclet.core.account.SortField
import tech.jensk.synclet.core.account.SortOrder
import tech.jensk.synclet.core.api.SyncItem

/** Folders first; within each group by [order], ties by name. Names compare locale-aware and case-insensitively. */
fun sortItems(items: List<SyncItem>, order: SortOrder, collator: Collator = Collator.getInstance()): List<SyncItem> {
    val byName = Comparator<SyncItem> { a, b -> collator.compare(a.name, b.name) }
    val within = when (order.field) {
        SortField.NAME -> byName
        SortField.DATE -> compareBy<SyncItem> { it.modifiedAt }.then(byName)
        SortField.SIZE -> compareBy<SyncItem> { it.size }.then(byName)
    }
    val directed = if (order.ascending) within else within.reversed()
    return items.sortedWith(compareBy<SyncItem> { !it.isFolder }.then(directed))
}

/** Tapping the active field flips the direction; a new field starts ascending, except DATE (newest first). */
fun SortOrder.next(field: SortField): SortOrder =
    if (field == this.field) copy(ascending = !ascending) else SortOrder(field, ascending = field != SortField.DATE)
