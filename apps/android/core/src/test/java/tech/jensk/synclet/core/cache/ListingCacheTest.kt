package tech.jensk.synclet.core.cache

import org.junit.Assert.*
import org.junit.Test
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.D2
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.itemJson

class ListingCacheTest {
    private var now = 100_000L
    private fun cache(max: Int = 300) = ListingCache(max) { now }
    private fun item(id: String) = SyncJson.decodeFromString(SyncItem.serializer(), itemJson(id, "n"))

    @Test fun freshnessUsesTheInjectedClock() {
        val c = cache(); c.put("k", "root", listOf(item(F1)))
        val l = c.get("k", "root")!!
        now += 29_000; assertTrue(c.isFresh(l, 30_000))
        now += 2_000; assertFalse(c.isFresh(l, 30_000))
    }

    @Test fun invalidateKeepsItemsButIsNotFresh() {
        val c = cache(); c.put("k", "root", listOf(item(F1)))
        c.invalidate("k", "root")
        val l = c.get("k", "root")!!
        assertEquals(1, l.items.size)
        assertFalse(c.isFresh(l, 30_000))
    }

    @Test fun putErrorKeepsPreviousItems() {
        val c = cache(); c.put("k", "root", listOf(item(F1)))
        now += 5_000
        c.putError("k", "root", "boom")
        val l = c.get("k", "root")!!
        assertEquals(1, l.items.size)
        assertEquals("boom", l.error)
        assertEquals(now, l.loadedAt)
    }

    @Test fun putFillsTheItemIndexAndRemoveItemWorks() {
        val c = cache(); c.put("k", "root", listOf(item(F1)))
        assertEquals(F1, c.item("k", F1)?.id)
        assertEquals("root", c.parentOf("k", F1))
        c.removeItem("k", F1)
        assertNull(c.item("k", F1))
    }

    @Test fun evictsLeastRecentlyReadFolder() {
        val c = cache(2)
        c.put("k", "a", emptyList()); c.put("k", "b", emptyList())
        c.get("k", "a")
        c.put("k", "c", emptyList())
        assertNotNull(c.get("k", "a")); assertNull(c.get("k", "b")); assertNotNull(c.get("k", "c"))
    }

    @Test fun clearLeavesOtherAccounts() {
        val c = cache(); c.put("k1", "root", listOf(item(D1))); c.put("k2", "root", listOf(item(D2)))
        c.clear("k1")
        assertNull(c.get("k1", "root")); assertNull(c.item("k1", D1))
        assertNotNull(c.get("k2", "root"))
    }
}
