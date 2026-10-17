package tech.jensk.synclet.ui.browser

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.account.AccountStore
import tech.jensk.synclet.core.account.SoftwareTokenCrypto
import tech.jensk.synclet.core.account.TokenVault
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.DeviceRegistrar
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.testing.MainDispatcherRule

class SpacesViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    @get:Rule val tmp = TemporaryFolder()

    private val key = "srv:u1"
    private val server = MockWebServer()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val accountRequests = AtomicInteger()
    private val changes = MutableSharedFlow<FolderChange>()
    private lateinit var accounts: AccountRepository

    private val personal = """{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}"""
    private val team = """{"id":"t1","kind":"shared","name":"Team","rootId":"r_11111111-1111-1111-1111-111111111111","canWrite":true}"""
    private val nas = """{"id":"e1","kind":"external","name":"NAS","rootId":"r_22222222-2222-2222-2222-222222222222","canWrite":false}"""
    private val gone = """{"id":"e2","kind":"external","name":"Old","rootId":"r_33333333-3333-3333-3333-333333333333","canWrite":true,"status":"missing"}"""
    @Volatile private var spaces = listOf(personal, team)

    private fun accountJson() =
        """{"userId":"u1","displayName":"Jens","organizationId":"$key","slug":"jens","spaces":[${spaces.joinToString(",")}],"cursor":"1"}"""

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/sync/v1/account" -> {
                    accountRequests.incrementAndGet()
                    MockResponse().setHeader("Content-Type", "application/json").setBody(accountJson())
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        val vault = TokenVault(PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "t.preferences_pb") }),
            SoftwareTokenCrypto(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()))
        accounts = AccountRepository(AccountStore(File(tmp.root, "accounts.json")), vault, OkHttpClient(),
            BrowserLogin(OkHttpClient()), DeviceRegistrar(OkHttpClient()), deviceName = "Pixel 9", installationId = null,
            appVersion = "0.1.5", scope = scope)
        runBlocking { accounts.load(); accounts.addWithDeviceToken(server.url("/"), "syd_a") }
    }

    @After fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private fun vm() = SpacesViewModel(accounts, key, changes, personalName = "My Files")

    private fun SpacesViewModel.await(predicate: (SpacesViewModel.State) -> Boolean) =
        runBlocking { withTimeout(5_000) { state.first(predicate) } }

    @Test fun spacesComeFromTheLayoutInServerOrder() {
        val s = vm().await { it.spaces.isNotEmpty() }
        assertEquals(listOf("personal", "t1"), s.spaces.map { it.space.id })
        assertEquals(listOf("My Files", "Team"), s.spaces.map { it.name })
        assertEquals(listOf(true, true), s.spaces.map { it.available })
        assertEquals(listOf(false, false), s.spaces.map { it.readOnly })
    }

    @Test fun refreshLoadsTheAccountAndTakesNewSpaces() {
        val vm = vm()
        vm.await { it.spaces.size == 2 }
        val before = accountRequests.get()
        spaces = listOf(personal, nas, team, gone)
        vm.refresh()
        val s = vm.await { it.spaces.size == 4 && !it.refreshing }
        assertEquals(before + 1, accountRequests.get())
        assertEquals(listOf("personal", "e1", "t1", "e2"), s.spaces.map { it.space.id })
        assertEquals(listOf(true, true, true, false), s.spaces.map { it.available })
        assertEquals(listOf(false, true, false, false), s.spaces.map { it.readOnly })
        assertNull(s.error)
    }

    @Test fun refreshFailureKeepsSpacesAndReportsTheError() {
        val vm = vm()
        vm.await { it.spaces.size == 2 }
        server.shutdown()
        vm.refresh()
        val s = vm.await { it.error != null && !it.refreshing }
        assertEquals(2, s.spaces.size)
    }
}
