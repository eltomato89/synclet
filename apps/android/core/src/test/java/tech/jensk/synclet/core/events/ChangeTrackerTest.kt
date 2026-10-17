package tech.jensk.synclet.core.events

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.testing.*

class ChangeTrackerTest {
    private val server = MockWebServer()
    private lateinit var tracker: ChangeTracker
    private val none: (String) -> String? = { null }

    @Before fun setUp() { server.start(); tracker = ChangeTracker(server.api()) }
    @After fun tearDown() { server.shutdown() }

    @Test fun helloSetsBaselineWithoutDraining() = runBlocking {
        assertTrue(tracker.onHello(mapOf("personal" to "5"), none).isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test fun changesEventDrainsAllPagesAndCollectsFolders() = runBlocking {
        tracker.onHello(mapOf("personal" to "5"), none)
        server.json("""{"changes":[{"op":"upsert","item":${itemJson(F1, "a.txt", parentId = D1)}},{"op":"delete","id":"$F2"}],"cursor":"7","hasMore":true}""")
        server.json("""{"changes":[],"cursor":"8","hasMore":false}""")
        val set = tracker.onChanges("personal", "8", { if (it == F2) D2 else null })
        assertEquals(ChangeSet("personal", setOf(D1, D2), setOf(F1, F2), reset = false), set)
        assertEquals("/api/sync/v1/changes?space=personal&cursor=5", server.takeRequest().path)
        assertEquals("/api/sync/v1/changes?space=personal&cursor=7", server.takeRequest().path)
        assertNull(tracker.onChanges("personal", "8", none))
        assertEquals(2, server.requestCount)
    }

    @Test fun expiredCursorResetsTheSpace() = runBlocking {
        tracker.onHello(mapOf("personal" to "5"), none)
        server.error(410, "cursor_expired")
        server.json("""{"cursor":"20"}""")
        val set = tracker.drain("personal", none)
        assertTrue(set.reset)
        server.json("""{"changes":[],"cursor":"21","hasMore":false}""")
        tracker.drain("personal", none)
        server.takeRequest(); server.takeRequest()
        assertEquals("/api/sync/v1/changes?space=personal&cursor=20", server.takeRequest().path)
    }

    @Test fun unknownSpaceStartsWithBaseline() = runBlocking {
        server.json("""{"cursor":"3"}""")
        val set = tracker.drain("s9", none)
        assertTrue(set.reset)
        assertEquals("/api/sync/v1/cursor?space=s9", server.takeRequest().path)
    }

    @Test fun helloAfterReconnectDrainsSpacesThatMovedOn() = runBlocking {
        tracker.onHello(mapOf("personal" to "5"), none)
        server.json("""{"changes":[],"cursor":"6","hasMore":false}""")
        val sets = tracker.onHello(mapOf("personal" to "6"), none)
        assertEquals(1, sets.size)
        assertEquals("/api/sync/v1/changes?space=personal&cursor=5", server.takeRequest().path)
    }

    @Test fun malformedChangeDoesNotCrashAndForcesReload() = runBlocking {
        tracker.onHello(mapOf("personal" to "5"), none)
        server.json("""{"changes":[{"op":"delete"},{"op":"delete","id":"$F1"}],"cursor":"6","hasMore":false}""")
        val set = tracker.drain("personal", none)
        assertTrue(set.reset)
        assertEquals(setOf(F1), set.itemIds)
    }
}
