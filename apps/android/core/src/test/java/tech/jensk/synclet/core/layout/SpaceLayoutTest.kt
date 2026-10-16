package tech.jensk.synclet.core.layout

import org.junit.Assert.*
import org.junit.Test
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.itemJson

class SpaceLayoutTest {
    private val team = SyncSpace("s1", "team", "Team A", "r_s1", canWrite = true)
    private fun folder(space: String, add: Boolean = true): SyncItem {
        val base = SyncJson.decodeFromString(SyncItem.serializer(), itemJson(D1, "d", extra = ""","spaceId":"$space""""))
        return base.copy(capabilities = base.capabilities.copy(addChildren = add))
    }

    @Test fun emptyListFallsBackToPersonal() {
        val l = SpaceLayout(emptyList())
        assertEquals(1, l.spaces.size)
        assertEquals("personal", l.spaces[0].id)
        assertEquals("root", l.spaces[0].rootId)
    }

    @Test fun rootLookups() {
        val l = SpaceLayout(listOf(SyncSpace("personal", "personal", "P", "root", true), team))
        assertEquals(team, l.spaceForRootId("r_s1"))
        assertTrue(l.isSpaceRoot("r_s1")); assertTrue(l.isSpaceRoot("root")); assertFalse(l.isSpaceRoot(D1))
    }

    @Test fun canCreateIn() {
        val l = SpaceLayout(listOf(SyncSpace("personal", "personal", "P", "root", true), team,
            SyncSpace("s2", "external", "Ext", "r_s2", true, status = "missing")))
        assertTrue(l.canCreateIn(folder("s1")))
        assertFalse(l.canCreateIn(folder("s2")))
        assertFalse(l.canCreateIn(folder("s1", add = false)))
    }

    @Test fun displayName() {
        val personal = SyncSpace("personal", "personal", "Server", "root", true)
        val l = SpaceLayout(listOf(personal, team))
        assertEquals("Meine Dateien", l.displayName(personal, "Meine Dateien"))
        assertEquals("Team A", l.displayName(team, "Meine Dateien"))
    }
}
