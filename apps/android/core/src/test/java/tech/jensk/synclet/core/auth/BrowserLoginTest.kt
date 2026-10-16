package tech.jensk.synclet.core.auth

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.testing.error
import tech.jensk.synclet.core.testing.json

class BrowserLoginTest {
    private val server = MockWebServer()
    @Before fun setUp() = server.start()
    @After fun tearDown() { runCatching { server.shutdown() } }
    private fun origin() = server.url("/")

    @Test fun authorizeUrlCarriesAllParameters() {
        val url = BrowserLogin(OkHttpClient()).authorizeUrl("https://files.example.com/".toHttpUrl(), "ch", "st", "jens@example.com")
        assertEquals("/app-login", url.encodedPath)
        assertEquals("android", url.queryParameter("client_id"))
        assertEquals("synclet://oauth", url.queryParameter("redirect_uri"))
        assertEquals("ch", url.queryParameter("code_challenge"))
        assertEquals("S256", url.queryParameter("code_challenge_method"))
        assertEquals("st", url.queryParameter("state"))
        assertEquals("jens@example.com", url.queryParameter("login_hint"))
    }
    @Test fun redirectIsCheckedForStateFirst() {
        assertEquals("abc", BrowserLogin.codeFromRedirect("synclet://oauth?code=abc&state=s1", "s1"))
        assertThrows(LoginError.StateMismatch::class.java) { BrowserLogin.codeFromRedirect("synclet://oauth?code=abc&state=evil", "s1") }
        assertThrows(LoginError.StateMismatch::class.java) { BrowserLogin.codeFromRedirect("synclet://oauth?error=access_denied", "s1") }
        val denied = assertThrows(LoginError.Denied::class.java) { BrowserLogin.codeFromRedirect("synclet://oauth?error=access_denied&state=s1", "s1") }
        assertEquals("access_denied", denied.reason)
        assertThrows(LoginError.MissingCode::class.java) { BrowserLogin.codeFromRedirect("synclet://oauth?state=s1", "s1") }
        assertThrows(LoginError.MissingCode::class.java) { BrowserLogin.codeFromRedirect("https://evil.example/?code=a&state=s1", "s1") }
    }
    @Test fun exchangeCodePostsContractBody() = runBlocking {
        server.json("""{"accessToken":"jwt","refreshToken":"syr_${"a".repeat(43)}","user":{"id":"u1","username":"jens","displayName":"Jens","email":null,"role":"admin"}}""")
        val tokens = BrowserLogin(OkHttpClient()).exchangeCode(origin(), "c0de", "v".repeat(43))
        val request = server.takeRequest()
        assertEquals("/api/auth/app/token", request.path)
        assertEquals("""{"code":"c0de","codeVerifier":"${"v".repeat(43)}","clientId":"android","redirectUri":"synclet://oauth"}""", request.body.readUtf8())
        assertEquals("jwt", tokens.accessToken)
        assertEquals("jens", tokens.user.username)
    }
    @Test fun exchangeCodeRejectionIsAnHttpError() = runBlocking {
        server.error(400, "invalid_request")
        val e = assertThrows(SyncError.Http::class.java) { runBlocking { BrowserLogin(OkHttpClient()).exchangeCode(origin(), "c", "v".repeat(43)) } }
        assertEquals(400, e.status)
    }
    @Test fun endSessionSendsCookieAndNeverThrows() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500))
        BrowserLogin(OkHttpClient()).endSession(origin(), "syr_x")
        val request = server.takeRequest()
        assertEquals("/api/auth/logout", request.path)
        assertEquals("synclet_refresh=syr_x", request.getHeader("Cookie"))
        val url = origin()
        server.shutdown()
        BrowserLogin(OkHttpClient()).endSession(url, "syr_x")   // unreachable: still no exception
    }

    @Test fun malformedOrOddRedirectsAreMissingCode() {
        for (bad in listOf("synclet://oauth?state=%zz", "synclet://oauth?state=s1&code=%", "synclet://oauth/x?code=a&state=s1",
            "synclet://user@oauth?code=a&state=s1", "synclet://oauth:1?code=a&state=s1")) {
            assertThrows(bad, LoginError.MissingCode::class.java) { BrowserLogin.codeFromRedirect(bad, "s1") }
        }
    }
    @Test fun exchangeCodeNeverFollowsRedirects() = runBlocking {
        val other = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/steal").toString()))
            val e = assertThrows(SyncError.Http::class.java) { runBlocking { BrowserLogin(OkHttpClient()).exchangeCode(origin(), "c", "v".repeat(43)) } }
            assertEquals(307, e.status)
            assertEquals(0, other.requestCount)
        } finally { other.shutdown() }
    }
    @Test fun endSessionNeverFollowsRedirects() = runBlocking {
        val other = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(308).setHeader("Location", other.url("/steal").toString()))
            BrowserLogin(OkHttpClient()).endSession(origin(), "syr_x")
            assertEquals(1, server.requestCount)
            assertEquals(0, other.requestCount)
        } finally { other.shutdown() }
    }
}
