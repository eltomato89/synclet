package tech.jensk.synclet.core.auth

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.testing.json

class ServerCheckTest {
    private val server = MockWebServer()
    @Before fun setUp() = server.start()
    @After fun tearDown() { runCatching { server.shutdown() } }
    private fun origin(): HttpUrl = server.url("/")
    private fun check(): HttpUrl = runBlocking { ServerCheck(OkHttpClient()).check(origin()) }

    private val capabilities = """{"versions":false,"office":{"enabled":false,"url":null}}"""

    @Test fun acceptsHealthAndCapabilities200() {
        server.json("""{"status":"ok"}""")
        server.json(capabilities)
        assertEquals(origin(), check())
        assertEquals("/api/health", server.takeRequest().path)
        assertEquals("/api/sync/v1/capabilities", server.takeRequest().path)
    }
    @Test fun acceptsCapabilities401WithSyncErrorBody() {
        server.json("""{"status":"ok"}""")
        server.json("""{"statusCode":401,"message":"x","code":"unauthorized"}""", 401)
        assertEquals(origin(), check())
    }
    @Test fun acceptsCapabilities404OfOlderServer() {
        server.json("""{"status":"ok"}""")
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(origin(), check())
    }
    @Test fun rejectsHtmlHealth() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html></html>"))
        assertThrows(LoginError.NotSynclet::class.java) { check() }
    }
    @Test fun rejects401WithoutCode() {
        server.json("""{"status":"ok"}""")
        server.json("""{"message":"x"}""", 401)
        assertThrows(LoginError.NotSynclet::class.java) { check() }
    }
    @Test fun rejectsRedirectToAnotherOrigin() {
        val other = MockWebServer().apply { start() }
        try {
            other.json("{}")
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", other.url("/api/health").toString()))
            assertThrows(LoginError.NotSynclet::class.java) { check() }
        } finally {
            other.shutdown()
        }
    }
    @Test fun unreachableHost() {
        val url = origin()
        server.shutdown()
        assertThrows(LoginError.Unreachable::class.java) { runBlocking { ServerCheck(OkHttpClient()).check(url) } }
    }
}
