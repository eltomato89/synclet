package tech.jensk.synclet.provider

import android.Manifest
import android.content.Context
import android.content.pm.ProviderInfo
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.FileOutputStream
import java.util.Collections
import java.util.UUID
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.api.Capabilities
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.upload.UploadQueue

/**
 * Write-on-close cases that need the real ParcelFileDescriptor close channel (Robolectric 4.17 never reports
 * closeWithError to the listener). Self-contained: the JVM-test fakes and fixtures are not on this classpath.
 */
@RunWith(AndroidJUnit4::class)
class ProviderWriteDeviceTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private lateinit var dir: File
    private lateinit var env: DeviceProviderEnvironment
    private lateinit var provider: SyncletDocumentsProvider

    @Before fun setUp() {
        server.start()
        dir = File(context.cacheDir, "provider-device-test-${UUID.randomUUID()}").apply { mkdirs() }
        env = DeviceProviderEnvironment(server, dir)
        val info = ProviderInfo().apply {
            authority = ProviderContract.AUTHORITY; exported = true; grantUriPermissions = true
            readPermission = Manifest.permission.MANAGE_DOCUMENTS; writePermission = Manifest.permission.MANAGE_DOCUMENTS
        }
        provider = SyncletDocumentsProvider()
        provider.attachInfo(context, info)
        provider.environmentOverride = env
    }

    @After fun tearDown() {
        server.shutdown()
        dir.deleteRecursively()
    }

    @Test fun crashedWriterIsNotUploaded() {
        enqueueItem()
        val pfd = provider.openDocument("srv:u1/$F1", "w", null)
        FileOutputStream(pfd.fileDescriptor).write("half".toByteArray())
        pfd.closeWithError("crash")
        waitUntil { workFiles().isEmpty() }                 // the listener ran and dropped the copy
        assertTrue(env.uploadQueue.entries.value.isEmpty())
        assertTrue(env.scheduled.isEmpty())
    }

    @Test fun writeIsUploadedOnCloseAndReadBack() {
        enqueueItem()
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument("srv:u1/$F1", "w", null)).use { it.write("new".toByteArray()) }
        enqueueItem()
        val text = ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument("srv:u1/$F1", "r", null)).use { it.readBytes().decodeToString() }
        assertEquals("new", text)
        val entry = runBlocking { env.uploadQueue.pendingReplace("srv:u1", F1) }!!
        assertEquals("v3", entry.ifMatch)
        assertEquals(listOf("srv:u1"), env.scheduled)
    }

    @Test fun readWriteWithoutChangesUploadsNothing() {
        enqueueItem()
        server.enqueue(MockResponse().setBody("same"))
        provider.openDocument("srv:u1/$F1", "rw", null).close()
        waitUntil { workFiles().isEmpty() }
        assertTrue(env.uploadQueue.entries.value.isEmpty())
    }

    private fun enqueueItem() {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody(SyncJson.encodeToString(SyncItem.serializer(), file())))
    }

    private fun file() = SyncItem(
        id = F1, parentId = "root", type = "file", kind = "text", name = "a.txt", size = 5, mime = "text/plain", version = 3,
        etag = "v3", contentEtag = "v3", createdAt = STAMP, modifiedAt = STAMP,
        capabilities = Capabilities(read = true, write = true, rename = true, move = true, delete = true),
    )

    private fun workFiles(): List<File> = File(context.cacheDir, "provider-work").listFiles().orEmpty().toList()

    private fun waitUntil(ms: Long = 5_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!cond()) { check(System.currentTimeMillis() < end) { "timeout" }; Thread.sleep(10) }
    }

    private companion object {
        const val F1 = "f_11111111-1111-1111-1111-111111111111"
        const val STAMP = "2026-10-16T08:00:00.000Z"
    }
}

private class DeviceProviderEnvironment(server: MockWebServer, dir: File) : ProviderEnvironment {
    val account = Account(key = "srv:u1", serverUrl = server.url("/").toString().trimEnd('/'), userId = "u1",
        username = "jens", displayName = "Jens", spaces = listOf(SyncSpace("personal", "personal", "Meine Dateien", "root", true)))
    private val tokens = AccountTokens("srv:u1", "syd_test") { _, _ -> }
    private val accountSession = AccountSession("srv:u1",
        SyncApi(server.url("/").newBuilder().encodedPath("/").build(), OkHttpClient(), tokens), tokens) { account }
    val scheduled: MutableList<String> = Collections.synchronizedList(ArrayList())

    override val listingCache = ListingCache()
    override val fileCache = FileCache(File(dir, "files"))
    override val uploadQueue = UploadQueue(File(dir, "uploads"))
    override val notifier = object : ProviderNotifier {
        override fun rootsChanged() {}
        override fun childrenChanged(accountKey: String, folderId: String) {}
        override fun topChanged(accountKey: String) {}
        override fun documentChanged(accountKey: String, syncId: String) {}
    }
    override val deviceName = "Test device"

    override suspend fun awaitReady() {}
    override fun accounts(): List<Account> = listOf(account)
    override fun session(accountKey: String): AccountSession? = accountSession.takeIf { accountKey == it.key }
    override fun scheduleUploads(accountKey: String) { scheduled += accountKey }
    override suspend fun thumbnailFile(accountKey: String, item: SyncItem, size: Int): File? = null
    override fun personalSpaceName(): String = "My Files"
    override fun signInRequiredSummary(): String = "Sign In Again"
}
