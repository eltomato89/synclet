package tech.jensk.synclet.provider

import android.Manifest
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.provider.DocumentsContract.Document
import android.webkit.MimeTypeMap
import java.io.File
import java.util.Collections
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.upload.UploadQueue

const val TEAM_ID = "55555555-5555-5555-5555-555555555555"
const val NAS_ID = "66666666-6666-6666-6666-666666666666"

class RecordingNotifier : ProviderNotifier {
    val roots: MutableList<Unit> = Collections.synchronizedList(ArrayList())
    val children: MutableList<Pair<String, String>> = Collections.synchronizedList(ArrayList())
    val tops: MutableList<String> = Collections.synchronizedList(ArrayList())
    val documents: MutableList<Pair<String, String>> = Collections.synchronizedList(ArrayList())

    override fun rootsChanged() { roots += Unit }
    override fun childrenChanged(accountKey: String, folderId: String) { children += accountKey to folderId }
    override fun topChanged(accountKey: String) { tops += accountKey }
    override fun documentChanged(accountKey: String, syncId: String) { documents += accountKey to syncId }
}

/** A ProviderEnvironment with real caches and queue in [dir] and one account talking to [server]. */
class FakeProviderEnvironment(server: MockWebServer, dir: File) : ProviderEnvironment {
    @Volatile var now: Long = 1_000_000L
    val account = Account(
        key = "srv:u1", serverUrl = server.url("/").toString().trimEnd('/'), userId = "u1", username = "jens", displayName = "Jens",
        spaces = listOf(
            SyncSpace("personal", "personal", "Meine Dateien", "root", true),
            SyncSpace(TEAM_ID, "shared", "Team", "r_$TEAM_ID", true),
            SyncSpace(NAS_ID, "external", "NAS", "r_$NAS_ID", false, "missing"),
        ),
    )
    val tokens = AccountTokens("srv:u1", "syd_test") { _, _ -> }
    val api = SyncApi(server.url("/").newBuilder().encodedPath("/").build(), okhttp3.OkHttpClient(), tokens)
    val accountSession = AccountSession("srv:u1", api, tokens) { key -> account.takeIf { it.key == key } }
    val scheduled: MutableList<String> = Collections.synchronizedList(ArrayList())

    override val listingCache = ListingCache(clock = { now })
    override val fileCache = FileCache(File(dir, "files"))
    override val uploadQueue = UploadQueue(File(dir, "uploads"))
    override val notifier = RecordingNotifier()
    override val deviceName: String = "Test Pixel"

    override suspend fun awaitReady() {}
    override fun accounts(): List<Account> = listOf(account)
    override fun session(accountKey: String): AccountSession? = accountSession.takeIf { accountKey == it.key }
    override fun scheduleUploads(accountKey: String) { scheduled += accountKey }
    override suspend fun thumbnailFile(accountKey: String, item: SyncItem, size: Int): File? = null
    override fun personalSpaceName(): String = "My Files"
    override fun signInRequiredSummary(): String = "Sign In Again"
}

fun ids(c: Cursor): List<String> = column(c, Document.COLUMN_DOCUMENT_ID)
fun names(c: Cursor): List<String> = column(c, Document.COLUMN_DISPLAY_NAME)

fun flagsOf(c: Cursor, id: String): Int {
    c.moveToPosition(-1)
    while (c.moveToNext()) {
        if (c.getString(c.getColumnIndexOrThrow(Document.COLUMN_DOCUMENT_ID)) == id) return c.getInt(c.getColumnIndexOrThrow(Document.COLUMN_FLAGS))
    }
    error("no row $id")
}

private fun column(c: Cursor, name: String): List<String> {
    val result = ArrayList<String>()
    c.moveToPosition(-1)
    while (c.moveToNext()) result += c.getString(c.getColumnIndexOrThrow(name))
    return result
}

/** Setup shared by the provider test classes. */
abstract class ProviderTestBase {
    @get:Rule val tmp = TemporaryFolder()
    val server = MockWebServer()
    lateinit var env: FakeProviderEnvironment
    lateinit var provider: SyncletDocumentsProvider

    @Before fun setUpProvider() {
        server.start()
        env = FakeProviderEnvironment(server, tmp.newFolder("env"))
        val info = ProviderInfo().apply {
            authority = ProviderContract.AUTHORITY; exported = true; grantUriPermissions = true
            readPermission = Manifest.permission.MANAGE_DOCUMENTS; writePermission = Manifest.permission.MANAGE_DOCUMENTS
        }
        provider = Robolectric.buildContentProvider(SyncletDocumentsProvider::class.java).create(info).get()
        provider.environmentOverride = env
        shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("txt", "text/plain")
    }

    @After fun tearDownProvider() { server.shutdown() }

    fun waitUntil(ms: Long = 5_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!cond()) { check(System.currentTimeMillis() < end) { "timeout" }; Thread.sleep(10) }
    }
}
