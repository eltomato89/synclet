package tech.jensk.synclet.sync

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
import org.junit.Assert.assertTrue
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
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.api.SyncAccount
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.provider.ProviderNotifier

private const val D1 = "d_33333333-3333-3333-3333-333333333333"
private const val F1 = "f_11111111-1111-1111-1111-111111111111"

class ForegroundSyncTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val listingCache = ListingCache()
    private val notifier = RecordingNotifier()
    private val requests = CopyOnWriteArrayList<String>()
    private val accountRequests = AtomicInteger()
    @Volatile private var eventsBody: () -> MockResponse = { MockResponse().setResponseCode(503) }
    private val eventTokens = CopyOnWriteArrayList<String>()
    private lateinit var accounts: AccountRepository
    private lateinit var vault: TokenVault

    private class RecordingNotifier : ProviderNotifier {
        val children = CopyOnWriteArrayList<Pair<String, String>>()
        val documents = CopyOnWriteArrayList<Pair<String, String>>()
        val tops = CopyOnWriteArrayList<String>()
        val roots = AtomicInteger()
        override fun rootsChanged() { roots.incrementAndGet() }
        override fun childrenChanged(accountKey: String, folderId: String) { children += accountKey to folderId }
        override fun topChanged(accountKey: String) { tops += accountKey }
        override fun documentChanged(accountKey: String, syncId: String) { documents += accountKey to syncId }
    }

    private val accountJson = """{"userId":"u1","displayName":"Jens","organizationId":"srv:u1","slug":"jens","spaces":[{"id":"personal","kind":"personal","name":"Meine Dateien","rootId":"root","canWrite":true}],"cursor":"1"}"""
    private fun itemJson(id: String, parentId: String) =
        """{"id":"$id","parentId":"$parentId","type":"file","kind":"file","name":"a.txt","size":5,"etag":"v1","createdAt":"2026-10-16T08:00:00.000Z","modifiedAt":"2026-10-16T08:00:00.000Z"}"""

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun sse(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                requests += url.encodedPath
                return when (url.encodedPath) {
                    "/api/sync/v1/account" -> { accountRequests.incrementAndGet(); json(accountJson) }
                    "/api/sync/v1/events" -> { eventTokens += request.getHeader("Authorization").orEmpty(); eventsBody() }
                    "/api/sync/v1/changes" -> when (url.queryParameter("cursor")) {
                        "5" -> json("""{"changes":[{"op":"upsert","item":${itemJson(F1, D1)}}],"cursor":"6","hasMore":false}""")
                        else -> json("""{"changes":[],"cursor":"${url.queryParameter("cursor")}","hasMore":false}""")
                    }
                    "/api/sync/v1/cursor" -> json("""{"cursor":"6"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        vault = TokenVault(PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "t.preferences_pb") }),
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

    private fun sync(ready: suspend () -> Unit = {}) =
        ForegroundSync(scope, accounts, OkHttpClient(), listingCache, notifier, pollIntervalMs = 50, ready = ready)

    private suspend fun eventually(condition: () -> Boolean) = withTimeout(5_000) { while (!condition()) delay(20) }

    @Test fun changesEventInvalidatesFoldersAndNotifies() = runBlocking {
        listingCache.put("srv:u1", D1, emptyList())
        eventsBody = { sse("event: hello\ndata: {\"cursor\":\"5\",\"cursors\":{\"personal\":\"5\"}}\n\nevent: changes\ndata: {\"space\":\"personal\",\"cursor\":\"6\"}\n\n") }
        val sync = sync()
        val change = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(5_000) { sync.changes.first { it is FolderChange.Folders } } }
        sync.onForeground()
        eventually { ("srv:u1" to D1) in notifier.children }
        assertTrue(!listingCache.isFresh(listingCache.get("srv:u1", D1)!!, 30_000))
        assertEquals(FolderChange.Folders("srv:u1", setOf(D1)), change.await())
        assertTrue(("srv:u1" to F1) in notifier.documents)
        sync.onBackground()
    }

    @Test fun accountEventReloadsTheAccount() = runBlocking {
        eventsBody = { sse("event: hello\ndata: {\"cursor\":\"5\",\"cursors\":{\"personal\":\"5\"}}\n\nevent: account\ndata: {}\n\n") }
        val before = accountRequests.get()
        val sync = sync()
        val change = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(5_000) { sync.changes.first { it is FolderChange.Everything } } }
        sync.onForeground()
        assertEquals(FolderChange.Everything("srv:u1"), change.await())
        eventually { accountRequests.get() > before }
        eventually { notifier.roots.get() > 0 }
        sync.onBackground()
    }

    @Test fun backgroundStopsTheStream() = runBlocking {
        // An open stream that only ever sends a ping: CONNECTED, so the poller stays quiet.
        eventsBody = { sse(": ping\n\n" + " ".repeat(4096)).throttleBody(8, 10, TimeUnit.SECONDS) }
        val sync = sync()
        sync.onForeground()
        eventually { "/api/sync/v1/events" in requests }
        sync.onBackground()
        delay(50)
        val count = requests.size
        delay(300)
        assertEquals(count, requests.size)
    }

    /** Cold start: the account file is already published, but the repository has not created the sessions yet. */
    @Test fun foregroundBeforeTheAccountsAreLoadedStartsTheStreamOnceReady() = runBlocking {
        eventsBody = { sse(": ping\n\n" + " ".repeat(4096)).throttleBody(8, 10, TimeUnit.SECONDS) }
        val store = AccountStore(File(tmp.root, "cold.json"))
        store.upsert(Account.from(server.url("/"), SyncJson.decodeFromString(SyncAccount.serializer(), accountJson), 1))
        vault.save("srv:u1", "syd_a")
        accounts = AccountRepository(store, vault, OkHttpClient(), BrowserLogin(OkHttpClient()), DeviceRegistrar(OkHttpClient()),
            deviceName = "Pixel 9", installationId = null, appVersion = "0.1.5", scope = scope)
        val ready = CompletableDeferred<Unit>()
        val sync = sync(ready = { ready.await() })
        sync.onForeground()                                   // accounts visible, sessions not yet created
        sync.onAccountsChanged(store.accounts.value)
        delay(200)
        assertTrue(eventTokens.isEmpty())
        accounts.load()
        ready.complete(Unit)
        eventually { eventTokens.isNotEmpty() }
        assertEquals("Bearer syd_a", eventTokens.single())
        sync.onBackground()
    }

    @Test fun streamThatEndedWithSignInRequiredRestartsAfterSignInAgain() = runBlocking {
        eventsBody = {
            if (eventTokens.last() == "Bearer syd_a")
                MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json")
                    .setBody("""{"statusCode":401,"message":"x","code":"device_revoked"}""")
            else sse(": ping\n\n" + " ".repeat(4096)).throttleBody(8, 10, TimeUnit.SECONDS)
        }
        val sync = sync()
        sync.onForeground()
        eventually { accounts.accounts.value.single().needsSignIn }   // the stream ended with SIGN_IN_REQUIRED
        accounts.addWithDeviceToken(server.url("/"), "syd_b")
        sync.onAccountsChanged(accounts.accounts.value)                   // what AppGraph does after a sign-in
        eventually { "Bearer syd_b" in eventTokens }
        sync.onBackground()
    }
}
