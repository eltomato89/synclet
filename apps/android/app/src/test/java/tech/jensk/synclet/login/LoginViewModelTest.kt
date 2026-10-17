package tech.jensk.synclet.login

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.account.AccountStore
import tech.jensk.synclet.core.account.SoftwareTokenCrypto
import tech.jensk.synclet.core.account.TokenVault
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.DeviceRegistrar
import tech.jensk.synclet.core.auth.LoginError
import tech.jensk.synclet.core.auth.ServerCheck

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private lateinit var accounts: AccountRepository
    private val pendingFile get() = File(tmp.root, "pending-login.json")

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.start()
        val vault = TokenVault(PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "t.preferences_pb") }),
            SoftwareTokenCrypto(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()))
        accounts = AccountRepository(AccountStore(File(tmp.root, "accounts.json")), vault, OkHttpClient(),
            BrowserLogin(OkHttpClient()), DeviceRegistrar(OkHttpClient()), deviceName = "Pixel 9", installationId = null,
            appVersion = "0.1.5", scope = scope)
        runBlocking { accounts.load() }
    }

    @After fun tearDown() {
        scope.cancel()
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun viewModel(ready: suspend () -> Unit = {}) = LoginViewModel(ServerCheck(OkHttpClient()), BrowserLogin(OkHttpClient()),
        accounts, PendingLoginStore(pendingFile), allowHttp = true, ready = ready)

    private fun json(body: String, code: Int = 200) =
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body))

    private val accountJson = """{"userId":"u1","displayName":"Jens","organizationId":"srv:u1","slug":"jens","spaces":[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}],"cursor":"1"}"""
    private val deviceJson = """{"id":"d1","name":"Pixel 9","platform":"android","appVersion":"0.1.5","createdAt":"2026-10-16T08:00:00.000Z"}"""

    @Test fun prepareChecksTheServerAndStoresThePendingLogin() = runBlocking {
        json("{}")
        json("""{"statusCode":401,"message":"x","code":"unauthorized"}""", 401)
        val url = viewModel().prepare("http://${server.hostName}:${server.port}", null)
        assertNotNull(url)
        assertEquals("/app-login", url!!.encodedPath)
        val stored = SyncJson.decodeFromString(PendingLogin.serializer(), pendingFile.readText())
        assertEquals(stored.state, url.queryParameter("state"))
        assertEquals(43, stored.verifier.length)
    }

    /** Review focus: the Custom Tab was open, the process died, the redirect starts a fresh process. */
    @Test fun completeAfterProcessDeathFinishesTheLogin() = runBlocking {
        val verifier = "v".repeat(43)
        PendingLoginStore(pendingFile).save(PendingLogin(server.url("/").toString(), verifier, "st1", null, System.currentTimeMillis()))
        json("""{"accessToken":"jwt","refreshToken":"syr_x","user":{"id":"u1","username":"jens","displayName":"Jens","role":"admin"}}""")
        json("""{"device":$deviceJson,"token":"syd_new","account":$accountJson}""", 201)
        json(accountJson)
        server.enqueue(MockResponse().setResponseCode(204))

        val vm = viewModel()                                 // new instance = new process
        vm.complete("synclet://oauth?code=c1&state=st1")
        val state = withTimeout(5_000) { vm.state.first { it.done != null || it.error != null } }
        assertEquals("srv:u1", state.done?.key)

        val token = server.takeRequest()
        assertEquals("POST /api/auth/app/token", "${token.method} ${token.path}")
        assertTrue(token.body.readUtf8().contains("\"codeVerifier\":\"$verifier\""))
        server.takeRequest().let { assertEquals("POST /api/sync/v1/devices", "${it.method} ${it.path}") }
        server.takeRequest().let { assertEquals("GET /api/sync/v1/account", "${it.method} ${it.path}") }
        server.takeRequest().let { assertEquals("POST /api/auth/logout", "${it.method} ${it.path}") }
        assertTrue(!pendingFile.exists())
    }

    @Test fun foreignStateIsRejectedWithoutExchangingTheCode() = runBlocking {
        PendingLoginStore(pendingFile).save(PendingLogin(server.url("/").toString(), "v".repeat(43), "st1", null, System.currentTimeMillis()))
        val vm = viewModel()
        vm.complete("synclet://oauth?code=c1&state=evil")
        val state = withTimeout(5_000) { vm.state.first { it.error != null } }
        assertTrue(state.error is LoginError.StateMismatch)
        assertEquals(0, server.requestCount)
        assertTrue(!pendingFile.exists())                    // a forged redirect also burns the pending login
    }

    @Test fun withoutPendingLoginTheRedirectIsExpired() = runBlocking {
        val vm = viewModel()
        vm.complete("synclet://oauth?code=c1&state=st1")
        val state = withTimeout(5_000) { vm.state.first { it.error != null } }
        assertTrue(state.error is LoginError.Expired)
        assertEquals(0, server.requestCount)
    }

    @Test fun staleRedirectIsExpired() = runBlocking {
        val createdAt = System.currentTimeMillis() - PendingLoginStore.TTL_MS - 1
        PendingLoginStore(pendingFile).save(PendingLogin(server.url("/").toString(), "v".repeat(43), "st1", null, createdAt))
        val vm = viewModel()
        vm.complete("synclet://oauth?code=c1&state=st1")
        val state = withTimeout(5_000) { vm.state.first { it.error != null } }
        assertTrue(state.error is LoginError.Expired)
        assertEquals(0, server.requestCount)
    }

    @Test fun failedStartupStopsBeforeTheCodeIsExchanged() = runBlocking {
        PendingLoginStore(pendingFile).save(PendingLogin(server.url("/").toString(), "v".repeat(43), "st1", null, System.currentTimeMillis()))
        val vm = viewModel(ready = { throw java.io.IOException("accounts.json unreadable") })
        vm.complete("synclet://oauth?code=c1&state=st1")
        val state = withTimeout(5_000) { vm.state.first { it.error != null } }
        assertTrue(state.error is java.io.IOException)
        assertEquals(0, server.requestCount)                 // no login session was opened on the server
    }
}
