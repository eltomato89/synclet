package tech.jensk.synclet.core.cache

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.F2
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.itemJson

class FileCacheTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    @Before fun setUp() = server.start()
    @After fun tearDown() = server.shutdown()
    private fun item(id: String, version: Long, size: Long = 5) =
        SyncJson.decodeFromString(SyncItem.serializer(), itemJson(id, "a.txt", version = version, size = size))

    @Test fun fetchDownloadsOnceAndIsVersionBound() = runBlocking {
        val cache = FileCache(tmp.root)
        val api = server.api()
        server.enqueue(MockResponse().setBody("hello"))
        val f1 = cache.fetch(api, "srv:u1", item(F1, 1))
        assertEquals("hello", f1.readText())
        assertEquals(f1, cache.fetch(api, "srv:u1", item(F1, 1)))
        assertEquals(1, server.requestCount)
        assertNull(cache.cached("srv:u1", item(F1, 2)))
        server.enqueue(MockResponse().setBody("HELLO"))
        val f2 = cache.fetch(api, "srv:u1", item(F1, 2))
        assertEquals("HELLO", f2.readText())
        assertFalse(f1.exists())
        assertEquals(f2, cache.latestAny("srv:u1", F1))
    }

    @Test fun evictsLeastRecentlyUsedAboveTheLimit() = runBlocking {
        val cache = FileCache(tmp.root, maxBytes = 8)
        val api = server.api()
        server.enqueue(MockResponse().setBody("aaaaa")); cache.fetch(api, "k", item(F1, 1))
        Thread.sleep(20)
        server.enqueue(MockResponse().setBody("bbbbb")); cache.fetch(api, "k", item(F2, 1))
        assertNull(cache.cached("k", item(F1, 1)))
        assertNotNull(cache.cached("k", item(F2, 1)))
    }

    @Test fun clearAccountOnlyTouchesThatAccount() = runBlocking {
        val cache = FileCache(tmp.root)
        val api = server.api()
        server.enqueue(MockResponse().setBody("a")); cache.fetch(api, "k1", item(F1, 1, 1))
        server.enqueue(MockResponse().setBody("b")); cache.fetch(api, "k2", item(F1, 1, 1))
        cache.clearAccount("k1")
        assertNull(cache.cached("k1", item(F1, 1, 1)))
        assertNotNull(cache.cached("k2", item(F1, 1, 1)))
    }
}
