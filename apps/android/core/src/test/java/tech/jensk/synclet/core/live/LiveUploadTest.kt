package tech.jensk.synclet.core.live

import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.FixedTokenSource
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.sha256Hex
import tech.jensk.synclet.core.upload.UploadOutcome
import tech.jensk.synclet.core.upload.UploadQueue
import tech.jensk.synclet.core.upload.Uploader

/**
 * Against a real server (scripts/android-live-tests.sh passes -PsyncletLiveUrl/-PsyncletLiveToken);
 * skipped without one. Exercises the same Uploader/UploadQueue path the WorkManager worker uses.
 */
class LiveUploadTest {
    @get:Rule val tmp = TemporaryFolder()
    private val url = System.getProperty("synclet.live.url").orEmpty()
    private val token = System.getProperty("synclet.live.token").orEmpty()
    private val sizeMb = System.getProperty("synclet.live.sizeMb", "48").toInt()
    private lateinit var api: SyncApi

    @Before fun setUp() {
        assumeTrue("no live server (-PsyncletLiveUrl/-PsyncletLiveToken)", url.isNotEmpty() && token.isNotEmpty())
        api = SyncApi(url.toHttpUrl(), OkHttpClient.Builder().readTimeout(2, TimeUnit.MINUTES).writeTimeout(2, TimeUnit.MINUTES).build(),
            FixedTokenSource(token))
    }

    @Test fun interruptedTusUploadResumesWithoutDuplicate() = runBlocking {
        val folder = api.createFolder("root", "android-live-${UUID.randomUUID().toString().take(8)}")
        try {
            val source = tmp.newFile("big.bin")
            source.outputStream().use { out -> val rnd = Random(42); val buf = ByteArray(1 shl 20); repeat(sizeMb) { rnd.nextBytes(buf); out.write(buf) } }
            val expected = sha256Hex(source)
            val dir = File(tmp.root, "queue")
            val queue = UploadQueue(dir)
            val entry = queue.enqueueCreate("live", folder.id, folder.name, "big.bin", { source.inputStream() })
            val claimed = queue.claimNext("live")!!
            val job = launch(Dispatchers.IO) { Uploader(api, queue, "android-live", "Conflict").upload(claimed) }
            withTimeout(120_000) { while ((queue.entry(entry.id)?.tusOffset ?: 0) < (16L shl 20)) delay(100) }
            job.cancelAndJoin()                                     // "the app was killed"
            val interrupted = queue.entry(entry.id)!!
            assertNotNull(interrupted.tusUrl)

            val queue2 = UploadQueue(dir).also { it.load() }        // new process, same files
            val resumed = queue2.claimNext("live")!!
            assertEquals(interrupted.tusUrl, resumed.tusUrl)
            assertTrue(Uploader(api, queue2, "android-live", "Conflict").upload(resumed) is UploadOutcome.Done)

            val children = api.allChildren(folder.id)
            assertEquals(listOf("big.bin"), children.map { it.name })          // no duplicate
            assertEquals(sizeMb.toLong() shl 20, children.single().size)
            val hashed = withTimeout(60_000) {
                var item = api.item(children.single().id)
                while (item.sha256 == null) { delay(500); item = api.item(item.id) }
                item
            }
            assertEquals(expected, hashed.sha256)
        } finally {
            runCatching { api.deleteItem(folder.id) }
        }
    }

    @Test fun staleReplaceBecomesAConflictCopy() = runBlocking {
        val folder = api.createFolder("root", "android-live-${UUID.randomUUID().toString().take(8)}")
        try {
            val original = api.uploadNew(folder.id, "a.txt", tmp.newFile().apply { writeText("one") })
            api.replaceContent(original.id, tmp.newFile().apply { writeText("two") }, original.contentEtag!!)   // someone else edits
            val queue = UploadQueue(File(tmp.root, "q2"))
            queue.enqueueReplace("live", original.id, folder.id, folder.name, "a.txt", original.contentEtag!!,
                tmp.newFile().apply { writeText("mine") }, chainAfter = null)
            val outcome = Uploader(api, queue, "Pixel", "Conflict").upload(queue.claimNext("live")!!) as UploadOutcome.Done
            assertTrue(outcome.conflictCopyName!!.startsWith("a (Conflict Pixel "))
            assertEquals(setOf("a.txt", outcome.conflictCopyName), api.allChildren(folder.id).map { it.name }.toSet())
            assertEquals("two", File(tmp.root, "check").also { api.download(original.id, it) }.readText())   // server version untouched
        } finally {
            runCatching { api.deleteItem(folder.id) }
        }
    }
}
