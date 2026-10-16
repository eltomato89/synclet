package tech.jensk.synclet.core.upload

import java.util.Base64
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.itemJson
import tech.jensk.synclet.core.testing.json

class TusClientTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private lateinit var api: SyncApi
    private lateinit var tus: TusClient

    @Before fun setUp() { server.start(); api = server.api(); tus = TusClient(api) }
    @After fun tearDown() { server.shutdown() }

    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray(Charsets.UTF_8))

    @Test fun metadataEncodesCreateAndReplace() {
        assertEquals("name " + b64("ä b.txt") + ",parentId " + b64("root") + ",onConflict " + b64("rename"),
            tus.metadata(TusTarget.Create("ä b.txt", "root"), null))
        assertEquals("itemId " + b64(F1) + ",ifMatch " + b64("v3") + ",modifiedAt " + b64("2026-10-16T08:00:00.000Z"),
            tus.metadata(TusTarget.Replace(F1, "\"v3\""), "2026-10-16T08:00:00.000Z"))
    }

    @Test fun createOfEmptyFileCompletesWithItem() = runBlocking {
        server.json(itemJson(F1, "empty.txt", size = 0), 201, mapOf("Location" to "/api/sync/v1/uploads/u0"))
        val created = tus.create(0, TusTarget.Create("empty.txt", "root"), null)
        assertTrue(created is TusCreated.Completed)
        assertEquals(F1, (created as TusCreated.Completed).item.id)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sync/v1/uploads", request.path)
        assertEquals("1.0.0", request.getHeader("Tus-Resumable"))
        assertEquals("0", request.getHeader("Upload-Length"))
        assertEquals("Bearer syd_test", request.getHeader("Authorization"))
    }

    @Test fun createReturnsTheResolvedLocation() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/api/sync/v1/uploads/u1"))
        val created = tus.create(10, TusTarget.Create("a.txt", "root"), null) as TusCreated.Created
        assertEquals(api.origin.resolve("/api/sync/v1/uploads/u1"), created.url)
    }

    @Test fun completionWithoutBodyFetchesItem() = runBlocking {
        val file = tmp.newFile().apply { writeText("ab") }
        server.enqueue(MockResponse().setResponseCode(200).setHeader("X-Synclet-Item", F1))
        server.json(itemJson(F1, "a.txt"))
        val result = tus.patch(server.url("/api/sync/v1/uploads/u1"), 0, file, 2)
        assertEquals(F1, (result as TusPatchResult.Completed).item.id)
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("0", patch.getHeader("Upload-Offset"))
        assertEquals("application/offset+octet-stream", patch.getHeader("Content-Type"))
        assertEquals("ab", patch.body.readUtf8())
        assertEquals("/api/sync/v1/items/$F1", server.takeRequest().path)
    }

    @Test fun headReadsTheOffset() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", "42"))
        assertEquals(42L, tus.head(server.url("/api/sync/v1/uploads/u1")))
        assertEquals("HEAD", server.takeRequest().method)
    }

    @Test fun brokenCompletionBodyIsATransportError() = runBlocking {
        val file = tmp.newFile().apply { writeText("ab") }
        server.enqueue(MockResponse().setResponseCode(200).setBody(itemJson(F1, "a.txt"))
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        try {
            tus.patch(server.url("/api/sync/v1/uploads/u1"), 0, file, 2)
            fail()
        } catch (e: SyncError.Transport) { }
    }
}
