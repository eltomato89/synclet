package tech.jensk.synclet.core.api

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.testing.*

class SyncApiTest {
    private val server = MockWebServer()
    private val tokens = RecordingTokens()
    private lateinit var api: SyncApi

    @Before fun setUp() { server.start(); api = server.api(tokens) }
    @After fun tearDown() { server.shutdown() }

    @Test fun childrenSendsBearerQueryAndIgnoresUnknownFields() = runBlocking {
        server.json("""{"items":[${itemJson(D1, "Docs", extra = ",\"future\":42")}],"nextPageToken":"p2","cursor":"7","x":1}""")
        val page = api.children("root", pageToken = "abc", limit = 2, folderThumbnails = true)
        val request = server.takeRequest()
        assertEquals("/api/sync/v1/items/root/children?pageToken=abc&limit=2&folderThumbnails=1", request.path)
        assertEquals("Bearer syd_test", request.getHeader("Authorization"))
        assertEquals(listOf("Docs"), page.items.map { it.name })
        assertTrue(page.items.single().isFolder)
        assertEquals("p2", page.nextPageToken)
    }

    @Test fun allChildrenFollowsNextPageToken() = runBlocking {
        server.json("""{"items":[${itemJson(D1, "A")}],"nextPageToken":"n1","cursor":"1"}""")
        server.json("""{"items":[${itemJson(F1, "b.txt")}],"nextPageToken":null,"cursor":"1"}""")
        assertEquals(listOf("A", "b.txt"), api.allChildren("root").map { it.name })
        server.takeRequest()
        assertTrue(server.takeRequest().path!!.contains("pageToken=n1"))
    }

    @Test fun conflictMapsToHttpErrorWithCodeAndItem() = runBlocking {
        server.error(412, "conflict", itemJson = itemJson(F1, "a.txt", version = 2))
        try { api.patchItem(F1, name = "b.txt", ifMatch = "v1"); fail() } catch (e: SyncError.Http) {
            assertEquals(412, e.status); assertEquals(ErrorCodes.CONFLICT, e.code); assertEquals("v2", e.item?.etag)
        }
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("\"v1\"", request.getHeader("If-Match"))
        assertEquals("""{"name":"b.txt"}""", request.body.readUtf8())
    }

    @Test fun unauthorizedIsReportedWithTheSentToken() = runBlocking {
        server.error(401, "device_revoked")
        try { api.item(F1); fail() } catch (e: SyncError.Http) { assertEquals(401, e.status) }
        assertEquals("syd_test", tokens.failures.single().first)
        assertEquals("device_revoked", tokens.failures.single().second.code)
    }

    @Test fun missingTokenFailsWithoutRequest() = runBlocking {
        tokens.value = null
        try { api.account(); fail() } catch (e: SyncError.SignInRequired) { }
        assertEquals(0, server.requestCount)
    }

    @Test fun capabilitiesFallsBackOnPlain404() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"statusCode":404,"message":"Not Found","error":"Not Found"}"""))
        assertEquals(ServerCapabilities(), api.capabilities())
    }

    @Test fun uploadNewSendsRawBodyAndQuery() = runBlocking {
        val file = Files.createTempFile("up", ".txt").toFile().apply { writeText("hello") }
        server.json(itemJson(F1, "a b.txt"), 201)
        val item = api.uploadNew("root", "a b.txt", file)
        val request = server.takeRequest()
        assertEquals("/api/sync/v1/items/upload?parentId=root&name=a%20b.txt&onConflict=rename", request.path)
        assertEquals("application/octet-stream", request.getHeader("Content-Type"))
        assertEquals("hello", request.body.readUtf8())
        assertEquals(F1, item.id)
    }

    @Test fun downloadResumesWithRangeAndIfRange() = runBlocking {
        val target = Files.createTempFile("dl", ".part").toFile().apply { writeText("hel") }
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 3-4/5").setBody("lo"))
        assertEquals(5L, api.download(F1, target, ifRange = "v1"))
        val request = server.takeRequest()
        assertEquals("bytes=3-", request.getHeader("Range"))
        assertEquals("\"v1\"", request.getHeader("If-Range"))
        assertEquals("hello", target.readText())
    }

    @Test fun downloadStartsOverWhenServerSendsTheWholeFile() = runBlocking {
        val target = Files.createTempFile("dl", ".part").toFile().apply { writeText("old") }
        server.enqueue(MockResponse().setResponseCode(200).setBody("fresh"))
        assertEquals(5L, api.download(F1, target, ifRange = "v1"))
        assertEquals("fresh", target.readText())
    }

    @Test fun deleteSendsIfMatch() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        api.deleteItem(D1, ifMatch = "t00000000000000a1")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("\"t00000000000000a1\"", request.getHeader("If-Match"))
    }

    @Test fun transportErrorsAreWrapped() = runBlocking {
        val port = server.port
        server.shutdown()
        val dead = SyncApi(okhttp3.HttpUrl.Builder().scheme("http").host("127.0.0.1").port(port).build(), okhttp3.OkHttpClient(), tokens)
        try { dead.item(F1); fail() } catch (e: SyncError.Transport) { }
    }

    @Test fun relativeUrlsResolveAgainstTheOrigin() {
        val resolved = api.resolve("/api/sync/v1/items/x/content?dt=1")
        assertEquals(server.hostName, resolved.host)
        assertEquals(server.port, resolved.port)
        assertEquals("/api/sync/v1/items/x/content", resolved.encodedPath)
        assertEquals("https://other.example/s/abc", api.resolve("https://other.example/s/abc").toString())
    }

    @Test fun tokenIsNeverSentToAnotherOrigin() = runBlocking {
        val builder = okhttp3.Request.Builder().url("https://evil.example/api/sync/v1/account")
        try { api.send(builder); fail() } catch (e: SyncError.InvalidResponse) { }
        assertNull(server.takeRequest(100, java.util.concurrent.TimeUnit.MILLISECONDS))
    }
}
