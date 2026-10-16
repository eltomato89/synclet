package tech.jensk.synclet.core.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.itemJson
import tech.jensk.synclet.core.testing.json

class AppRoutesTest {
    private val server = MockWebServer()
    @Before fun setUp() = server.start()
    @After fun tearDown() = server.shutdown()

    private val share = """{"id":"s","itemId":"$F1","itemName":"a","itemType":"file","url":"/s/t","hasPassword":false,"expiresAt":null,""" +
        """"allowDownload":true,"allowUpload":false,"createdAt":"2026-10-16T08:00:00Z","revokedAt":null,"hits":0}"""

    @Test fun search() = runBlocking {
        server.json("""{"hits":[{"item":${itemJson(F1, "a.txt")},"path":"/a.txt","snippet":"x «y»","matched":"content"}],"total":1}""")
        val r = server.api().search("a b", folder = D1, space = "personal")
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/sync/v1/search?q=a%20b&limit=20&offset=0&folder=$D1&space=personal", req.path)
        assertEquals("x «y»", r.hits[0].snippet)
    }

    @Test fun recent() = runBlocking {
        server.json("[${itemJson(F1, "a.txt")}]")
        assertEquals(1, server.api().recent().size)
        assertEquals("/api/sync/v1/recent?limit=50", server.takeRequest().path)
    }

    @Test fun previewText() = runBlocking {
        server.json("""{"text":"hi","truncated":false,"encoding":"utf-8"}""")
        assertEquals("hi", server.api().previewText(F1).text)
        assertEquals("/api/sync/v1/items/$F1/preview-text", server.takeRequest().path)
    }

    @Test fun trashRoutes() = runBlocking {
        val api = server.api()
        server.json("""[{"id":"t1","itemId":"$F1","type":"file","name":"a","originalPath":"/a","deletedAt":"2026-10-16T08:00:00Z"}]""")
        assertEquals("t1", api.trash()[0].id)
        assertEquals("GET /api/trash", server.takeRequest().let { "${it.method} ${it.path}" })
        server.json("""{"item":${itemJson(F1, "a")},"restoredTo":"/","renamed":false}""")
        api.restoreTrash("t1")
        assertEquals("POST /api/trash/t1/restore", server.takeRequest().let { "${it.method} ${it.path}" })
        server.json("{}")
        api.deleteTrash("t1")
        assertEquals("DELETE /api/trash/t1", server.takeRequest().let { "${it.method} ${it.path}" })
        server.json("""{"removed":3}""")
        assertEquals(3, api.emptyTrash("s1"))
        assertEquals("DELETE /api/trash?space=s1", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test fun shareRoutes() = runBlocking {
        val api = server.api()
        server.json("[$share]")
        assertEquals(1, api.shareLinks(F1).size)
        assertEquals("GET /api/shares?itemId=$F1", server.takeRequest().let { "${it.method} ${it.path}" })

        server.json(share)
        api.createShareLink(CreateShareLink(F1))
        var req = server.takeRequest()
        assertEquals("POST /api/shares", "${req.method} ${req.path}")
        assertEquals("""{"itemId":"$F1","allowDownload":true,"allowUpload":false}""", req.body.readUtf8())

        server.json(share)
        api.patchShareLink("s", ShareLinkPatch(password = Patch.Set(null), allowDownload = false))
        req = server.takeRequest()
        assertEquals("PATCH /api/shares/s", "${req.method} ${req.path}")
        assertEquals("""{"password":null,"allowDownload":false}""", req.body.readUtf8())

        server.json(share)
        api.rotateShareLink("s")
        assertEquals("POST /api/shares/s/rotate", server.takeRequest().let { "${it.method} ${it.path}" })
        server.json("{}")
        api.deleteShareLink("s")
        assertEquals("DELETE /api/shares/s", server.takeRequest().let { "${it.method} ${it.path}" })
    }
}
