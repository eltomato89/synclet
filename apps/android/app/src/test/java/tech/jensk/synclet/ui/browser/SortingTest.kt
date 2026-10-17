package tech.jensk.synclet.ui.browser

import java.text.Collator
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test
import tech.jensk.synclet.core.account.SortField
import tech.jensk.synclet.core.account.SortOrder
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem

class SortingTest {
    private val collator = Collator.getInstance(Locale.ENGLISH)

    private fun file(name: String, size: Long = 5, modified: String = "2026-10-16T08:00:00.000Z") =
        fileItem("f_$name", name, size = size).copy(modifiedAt = modified)
    private fun folder(name: String, modified: String = "2026-10-16T08:00:00.000Z") =
        folderItem("d_$name", name).copy(modifiedAt = modified)
    private fun names(items: List<SyncItem>) = items.map { it.name }

    @Test fun foldersAlwaysComeFirst() {
        val items = listOf(file("a.txt"), folder("z"), file("b.txt"), folder("y"))
        for (order in listOf(SortOrder(SortField.NAME, true), SortOrder(SortField.NAME, false),
            SortOrder(SortField.DATE, false), SortOrder(SortField.SIZE, true), SortOrder(SortField.SIZE, false))) {
            val sorted = sortItems(items, order, collator)
            assertEquals(listOf(true, true, false, false), sorted.map { it.isFolder })
        }
    }

    @Test fun nameAscendingIgnoresCase() {
        val sorted = sortItems(listOf(file("c"), file("B"), file("a")), SortOrder(SortField.NAME, true), collator)
        assertEquals(listOf("a", "B", "c"), names(sorted))
    }

    @Test fun dateDescendingNewestFirst() {
        val items = listOf(
            file("old", modified = "2026-01-01T00:00:00.000Z"),
            file("new", modified = "2026-10-01T00:00:00.000Z"),
            file("mid", modified = "2026-05-01T00:00:00.000Z"),
        )
        assertEquals(listOf("new", "mid", "old"), names(sortItems(items, SortOrder(SortField.DATE, false), collator)))
    }

    @Test fun sizeAscendingFoldersAmongThemselvesByName() {
        val items = listOf(file("big", size = 900), folder("Zeta"), file("small", size = 1), folder("alpha"), file("mid", size = 50))
        assertEquals(listOf("alpha", "Zeta", "small", "mid", "big"), names(sortItems(items, SortOrder(SortField.SIZE, true), collator)))
    }
}
