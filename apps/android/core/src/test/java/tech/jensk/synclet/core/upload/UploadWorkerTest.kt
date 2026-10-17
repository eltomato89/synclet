package tech.jensk.synclet.core.upload

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import java.io.File
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.TokenSource
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.F2
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.error
import tech.jensk.synclet.core.testing.itemJson
import tech.jensk.synclet.core.testing.json

class FakeUploadEnvironment(override val uploadQueue: UploadQueue) : UploadEnvironment {
    var uploaders: (String) -> Uploader? = { null }
    /** The app's ready gate (accounts and sessions loaded); open by default. */
    var ready: suspend () -> Unit = {}
    val finished = CopyOnWriteArrayList<Pair<UploadEntry, SyncItem>>()
    override suspend fun awaitReady() = ready()
    override fun uploader(accountKey: String): Uploader? = uploaders(accountKey)
    override fun onUploadFinished(entry: UploadEntry, item: SyncItem) { finished += entry to item }
}

class TestUploadApp : Application(), UploadEnvironment.Owner {
    lateinit var environment: FakeUploadEnvironment
    override val uploadEnvironment: UploadEnvironment get() = environment
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestUploadApp::class)
class UploadWorkerTest {
    private val server = MockWebServer()
    private lateinit var context: Context
    private lateinit var env: FakeUploadEnvironment
    private val queue get() = env.uploadQueue

    @Before fun setUp() {
        server.start()
        val app = ApplicationProvider.getApplicationContext<TestUploadApp>()
        context = app
        env = FakeUploadEnvironment(UploadQueue(File(app.filesDir, "uploads-test-${System.nanoTime()}")))
        val api = server.api()
        env.uploaders = { key ->
            if (key == "k") Uploader(api, env.uploadQueue, "Pixel 9", "Konflikt",
                now = { ZonedDateTime.of(2026, 10, 16, 9, 5, 0, 0, ZoneOffset.UTC) }) else null
        }
        app.environment = env
    }
    @After fun tearDown() { server.shutdown() }

    private fun worker(account: String = "k") = TestListenableWorkerBuilder<UploadWorker>(context)
        .setInputData(workDataOf(UploadWorker.KEY_ACCOUNT to account)).build()

    private suspend fun enqueue(name: String, account: String = "k") =
        queue.enqueueCreate(account, "root", "", name, { "hello".byteInputStream() })

    @Test fun uploadsAllWaitingEntriesOfTheAccount() = runBlocking {
        val a = enqueue("a.txt"); val b = enqueue("b.txt"); val other = enqueue("c.txt", "other")
        server.json(itemJson(F1, "a.txt"), 201); server.json(itemJson(F2, "b.txt"), 201)
        assertEquals(ListenableWorker.Result.success(), worker().doWork())
        assertEquals(UploadStatus.DONE, queue.entry(a.id)!!.status)
        assertEquals(UploadStatus.DONE, queue.entry(b.id)!!.status)
        assertEquals(5L, queue.entry(a.id)!!.sent)
        assertEquals(UploadStatus.WAITING, queue.entry(other.id)!!.status)
        assertEquals(2, env.finished.size)
        assertEquals(listOf(F1, F2), env.finished.map { it.second.id })
        assertEquals(2, server.requestCount)
    }

    @Test fun transientErrorRetriesAndCountsAttempts() = runBlocking {
        val e = enqueue("a.txt")
        server.error(500, null)
        assertEquals(ListenableWorker.Result.retry(), worker().doWork())
        val r = queue.entry(e.id)!!
        assertEquals(1, r.attempts)
        assertEquals(UploadStatus.WAITING, r.status)
    }

    @Test fun tenthNetworkFailureMarksFailed() = runBlocking {
        val e = enqueue("a.txt")
        queue.update(e.id) { it.copy(attempts = 9) }
        server.error(500, null)
        assertEquals(ListenableWorker.Result.success(), worker().doWork())
        val r = queue.entry(e.id)!!
        assertEquals(UploadStatus.FAILED, r.status)
        assertEquals(UploadFailure.NETWORK, r.failure)
    }

    @Test fun permanentFailureMovesOnToTheNextEntry() = runBlocking {
        val a = enqueue("a.txt"); val b = enqueue("b.txt")
        server.error(507, "insufficient_storage"); server.json(itemJson(F2, "b.txt"), 201)
        assertEquals(ListenableWorker.Result.success(), worker().doWork())
        assertEquals(UploadFailure.INSUFFICIENT_STORAGE, queue.entry(a.id)!!.failure)
        assertEquals(UploadStatus.DONE, queue.entry(b.id)!!.status)
    }

    @Test fun missingUploaderAfterReadyKeepsTheQueue() = runBlocking {
        // Sign-out removes entries itself (AppGraph.forgetAccount); the worker never deletes anything.
        val e = enqueue("a.txt", "gone")
        val kept = enqueue("b.txt")
        assertEquals(ListenableWorker.Result.success(), worker("gone").doWork())
        assertEquals(UploadStatus.WAITING, queue.entry(e.id)!!.status)
        assertTrue(queue.copyFile(e.id).exists())
        assertTrue(queue.copyFile(kept.id).exists())
        assertEquals(0, server.requestCount)
    }

    @Test fun coldStartWaitsForTheReadyGateBeforeLookingUpTheUploader() = runBlocking {
        val e = enqueue("a.txt")
        val real = env.uploaders
        val gate = CompletableDeferred<Unit>()
        env.uploaders = { null }                       // sessions do not exist yet
        env.ready = { gate.await() }
        server.json(itemJson(F1, "a.txt"), 201)
        val result = async(Dispatchers.Default) { worker().doWork() }
        delay(100)
        assertFalse(result.isCompleted)
        env.uploaders = real                           // AccountRepository.load() finished
        gate.complete(Unit)
        assertEquals(ListenableWorker.Result.success(), result.await())
        assertEquals(UploadStatus.DONE, queue.entry(e.id)!!.status)
        assertEquals(1, server.requestCount)
    }

    @Test fun failedReadyGateRetriesAndKeepsTheQueue() = runBlocking {
        val e = enqueue("a.txt")
        env.ready = { throw java.io.IOException("accounts.json unreadable") }
        assertEquals(ListenableWorker.Result.retry(), worker().doWork())
        assertEquals(UploadStatus.WAITING, queue.entry(e.id)!!.status)
        assertTrue(queue.copyFile(e.id).exists())
        assertEquals(0, server.requestCount)
    }

    @Test fun unexpectedExceptionLeavesTheEntryWaiting() = runBlocking {
        val broken = object : TokenSource {
            override fun token(): String? = throw IllegalStateException("keystore exploded")
            override fun onUnauthorized(sentToken: String, error: SyncError.Http) {}
        }
        env.uploaders = { Uploader(server.api(broken), env.uploadQueue, "Pixel 9", "Konflikt") }
        val e = enqueue("a.txt")
        assertEquals(ListenableWorker.Result.retry(), worker().doWork())
        val r = queue.entry(e.id)!!
        assertEquals(UploadStatus.WAITING, r.status)
        assertEquals(1, r.attempts)
        assertEquals(0, server.requestCount)
    }
}
