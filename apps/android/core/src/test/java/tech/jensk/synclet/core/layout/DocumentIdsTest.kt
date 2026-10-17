package tech.jensk.synclet.core.layout

import org.junit.Assert.*
import org.junit.Test
import tech.jensk.synclet.core.testing.F1

class DocumentIdsTest {
    @Test fun roundTripsWithColonInTheAccountKey() {
        val id = DocumentIds.of("3f2a:0b1c-uuid", F1)
        assertEquals("3f2a:0b1c-uuid/$F1", id)
        assertEquals(DocumentIds.Parsed("3f2a:0b1c-uuid", F1), DocumentIds.parse(id))
    }
    @Test fun topIsNotTheRootOfMyFiles() {
        assertEquals("k/top", DocumentIds.top("k"))
        assertTrue(DocumentIds.parse("k/top")!!.isTop)
        assertFalse(DocumentIds.parse("k/root")!!.isTop)
    }
    @Test fun rejectsMalformed() {
        for (bad in listOf("", "k", "/$F1", "k/", "k/../x")) assertNull(DocumentIds.parse(bad))
    }
}
