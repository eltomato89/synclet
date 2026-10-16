package tech.jensk.synclet.core.account

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.AppTokens
import tech.jensk.synclet.core.api.PublicUser
import tech.jensk.synclet.core.api.SyncAccount
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.DeviceRegistrar
import tech.jensk.synclet.core.testing.error
import tech.jensk.synclet.core.testing.json

class AccountRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val signedOut = CopyOnWriteArrayList<String>()
    private val signedIn = CopyOnWriteArrayList<String>()
    private lateinit var store: AccountStore
    private lateinit var vault: TokenVault
    private lateinit var dataStore: androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>

    @Before fun setUp() {
        server.start()
        store = AccountStore(File(tmp.root, "accounts.json"))
        dataStore = PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "t.preferences_pb") })
        vault = TokenVault(dataStore, SoftwareTokenCrypto(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()))
    }
    @After fun tearDown() { scope.cancel(); server.shutdown() }

    private fun repo() = AccountRepository(store, vault, OkHttpClient(), BrowserLogin(OkHttpClient()), DeviceRegistrar(OkHttpClient()),
        deviceName = "Pixel 9", installationId = "inst", appVersion = "0.1.5", scope = scope,
        onSignedIn = { signedIn += it }, onSignedOut = { signedOut += it })
    private val accountJson = """{"userId":"u1","email":null,"displayName":"Jens","organizationId":"srv:u1","organizationName":"Synclet","slug":"jens","canWrite":true,"spaces":[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}],"areas":{"personal":true,"shared":false,"customers":false,"projects":false},"quotaBytes":0,"usedBytes":0,"maxUploadBytes":1000,"cursor":"1"}"""
    private val deviceJson = """{"id":"d1","name":"Pixel 9","platform":"android","appVersion":"0.1.5","createdAt":"2026-10-16T08:00:00.000Z","lastSeenAt":null}"""
    private val tokens = AppTokens("jwt", "syr_x", PublicUser("u1", "jens", "Jens", null, "admin"))

    @Test fun completeBrowserLoginRegistersStoresAndEndsTheSession() = runBlocking {
        server.json("""{"device":$deviceJson,"token":"syd_new","account":$accountJson}""", 201)
        server.json(accountJson)
        server.enqueue(MockResponse().setResponseCode(204))
        val repo = repo(); repo.load()
        val account = repo.completeBrowserLogin(server.url("/"), tokens)
        assertEquals("srv:u1", account.key)
        assertEquals("Bearer jwt", server.takeRequest().getHeader("Authorization"))          // registration
        assertEquals("Bearer syd_new", server.takeRequest().getHeader("Authorization"))      // /account with the device token
        assertEquals("synclet_refresh=syr_x", server.takeRequest().getHeader("Cookie"))     // session ended
        assertEquals("syd_new", vault.load("srv:u1"))
        assertEquals("syd_new", repo.session("srv:u1")!!.api.currentToken())
        assertEquals(listOf("srv:u1"), signedIn)
    }

    @Test fun missingTokenMarksSignInRequired() = runBlocking {
        store.upsert(Account.from(server.url("/"), SyncJson.decodeFromString(SyncAccount.serializer(), accountJson), 1))
        val repo = repo(); repo.load()
        assertTrue(store.get("srv:u1")!!.needsSignIn)
        assertTrue(repo.session("srv:u1")!!.tokens.signInRequired)
    }

    /** Review focus: the Keystore key is gone (device migration) – no crash, the account asks for a new sign-in. */
    @Test fun undecryptableTokenMarksSignInRequired() = runBlocking {
        store.upsert(Account.from(server.url("/"), SyncJson.decodeFromString(SyncAccount.serializer(), accountJson), 1))
        TokenVault(dataStore, SoftwareTokenCrypto(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()))
            .save("srv:u1", "syd_old")
        val repo = repo(); repo.load()
        assertTrue(store.get("srv:u1")!!.needsSignIn)
        assertTrue(repo.session("srv:u1")!!.tokens.signInRequired)
        assertNull(repo.session("srv:u1")!!.api.currentToken())
    }

    @Test fun unauthorizedResponseMarksTheAccount() = runBlocking<Unit> {
        server.json("""{"device":$deviceJson,"token":"syd_a","account":$accountJson}""", 201)
        server.json(accountJson); server.enqueue(MockResponse().setResponseCode(204))
        val repo = repo(); repo.load(); repo.completeBrowserLogin(server.url("/"), tokens)
        server.error(401, "device_revoked")
        runCatching { repo.session("srv:u1")!!.api.item("root") }
        withTimeout(5_000) { store.accounts.first { it.single().needsSignIn } }
    }

    @Test fun reLoginReplacesTheTokenAndClearsSignInRequired() = runBlocking<Unit> {
        repeat(2) { n ->
            server.json("""{"device":$deviceJson,"token":"syd_$n","account":$accountJson}""", 201)
            server.json(accountJson); server.enqueue(MockResponse().setResponseCode(204))
        }
        val repo = repo(); repo.load()
        repo.completeBrowserLogin(server.url("/"), tokens)
        val session = repo.session("srv:u1")!!
        session.tokens.onUnauthorized("syd_0", SyncError.Http(401, "device_revoked", null))
        repo.completeBrowserLogin(server.url("/"), tokens)
        assertSame(session, repo.session("srv:u1"))
        assertEquals("syd_1", session.api.currentToken())
        withTimeout(5_000) { store.accounts.first { !it.single().needsSignIn } }
    }

    @Test fun signOutRevokesTheDeviceAndDropsEverything() = runBlocking {
        server.json("""{"device":$deviceJson,"token":"syd_a","account":$accountJson}""", 201)
        server.json(accountJson); server.enqueue(MockResponse().setResponseCode(204))
        val repo = repo(); repo.load(); repo.completeBrowserLogin(server.url("/"), tokens)
        server.enqueue(MockResponse().setResponseCode(204))
        repo.signOut("srv:u1")
        repeat(3) { server.takeRequest() }
        assertEquals("/api/sync/v1/devices/current", server.takeRequest().path)
        assertNull(vault.load("srv:u1")); assertNull(store.get("srv:u1")); assertNull(repo.session("srv:u1"))
        assertEquals(listOf("srv:u1"), signedOut)
    }
}
