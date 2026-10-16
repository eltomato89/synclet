package tech.jensk.synclet.core.upload

import java.io.File
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.F2
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.error
import tech.jensk.synclet.core.testing.itemJson
import tech.jensk.synclet.core.testing.json

class UploaderTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private lateinit var api: SyncApi
    private lateinit var queue: UploadQueue
    private lateinit var uploader: Uploader

    @Before fun setUp() {
        server.start()
        api = server.api()
        queue = UploadQueue(File(tmp.root, "uploads"))
        uploader = uploader(api)
    }
    @After fun tearDown() { server.shutdown() }

    private fun uploader(api: SyncApi) = Uploader(api, queue, "Pixel 9", "Konflikt", chunkSize = 4, threshold = 8,
        now = { ZonedDateTime.of(2026, 10, 16, 9, 5, 0, 0, ZoneOffset.UTC) })

    private suspend fun create(text: String, name: String = "a.txt") =
        queue.enqueueCreate("k", "root", "", name, { text.byteInputStream() })

    private suspend fun replace(text: String, ifMatch: String = "v1", chainAfter: String? = null) =
        queue.enqueueReplace("k", F1, "root", "", "a.txt", ifMatch, tmp.newFile().apply { writeText(text) }, chainAfter)

    private fun tusCreated(path: String = "/api/sync/v1/uploads/u1") =
        server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", path).setHeader("Tus-Resumable", "1.0.0"))
    private fun tusOffset(offset: Long) =
        server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", offset.toString()))
    private fun tusHead(offset: Long) =
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Upload-Offset", offset.toString()))

    private fun item(id: String = F1, version: Long = 1) =
        SyncJson.decodeFromString(SyncItem.serializer(), itemJson(id, "a.txt", version = version))

    @Test fun smallFileUsesSinglePostWithRename() = runBlocking {
        val e = create("hello")
        server.json(itemJson(F1, "a.txt"), 201)
        val progress = CopyOnWriteArrayList<Long>()
        val outcome = uploader.upload(queue.claimNext("k")!!) { progress += it }
        assertEquals(UploadOutcome.Done(item(), null), outcome)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sync/v1/items/upload?parentId=root&name=a.txt&onConflict=rename", request.path)
        assertEquals("hello", request.body.readUtf8())
        assertEquals(5L, progress.last())               // live progress also for the single request
        assertEquals(UploadStatus.UPLOADING, queue.entry(e.id)!!.status)
    }

    @Test fun largeFileUsesTusChunksAndPersistsOffset() = runBlocking {
        val e = create("0123456789")
        tusCreated(); tusOffset(4); tusOffset(8); server.json(itemJson(F1, "a.txt", size = 10))
        var persisted: UploadEntry? = null
        val outcome = uploader.upload(queue.claimNext("k")!!) { sent ->
            if (sent == 10L && persisted == null) persisted = runBlocking { queue.entry(e.id) }
        }
        assertTrue(outcome is UploadOutcome.Done)
        assertEquals(8L, persisted!!.tusOffset)
        assertTrue(persisted!!.tusUrl!!.endsWith("/api/sync/v1/uploads/u1"))

        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/sync/v1/uploads", post.path)
        assertEquals("1.0.0", post.getHeader("Tus-Resumable"))
        assertEquals("10", post.getHeader("Upload-Length"))
        val bodies = (0 until 3).map {
            val patch = server.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("/api/sync/v1/uploads/u1", patch.path)
            assertEquals("1.0.0", patch.getHeader("Tus-Resumable"))
            assertEquals("application/offset+octet-stream", patch.getHeader("Content-Type"))
            patch.getHeader("Upload-Offset") to patch.body.readUtf8()
        }
        assertEquals(listOf("0" to "0123", "4" to "4567", "8" to "89"), bodies)
    }

    @Test fun resumeUsesHeadOffset() = runBlocking {
        val e = create("0123456789")
        queue.update(e.id) { it.copy(tusUrl = server.url("/api/sync/v1/uploads/u1").toString(), tusOffset = 4) }
        tusHead(8); server.json(itemJson(F1, "a.txt", size = 10))
        assertTrue(uploader.upload(queue.claimNext("k")!!) is UploadOutcome.Done)
        assertEquals("HEAD", server.takeRequest().method)
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("8", patch.getHeader("Upload-Offset"))
        assertEquals("89", patch.body.readUtf8())
        assertEquals(2, server.requestCount)
    }

    @Test fun expiredTusUrlRestarts() = runBlocking {
        val e = create("0123456789")
        queue.update(e.id) { it.copy(tusUrl = server.url("/api/sync/v1/uploads/old").toString(), tusOffset = 8) }
        server.enqueue(MockResponse().setResponseCode(404))
        tusCreated("/api/sync/v1/uploads/new"); tusOffset(4); tusOffset(8); server.json(itemJson(F1, "a.txt", size = 10))
        assertTrue(uploader.upload(queue.claimNext("k")!!) is UploadOutcome.Done)
        assertEquals("HEAD", server.takeRequest().method)
        assertEquals("POST", server.takeRequest().method)
        val first = server.takeRequest()
        assertEquals("/api/sync/v1/uploads/new", first.path)
        assertEquals("0", first.getHeader("Upload-Offset"))
    }

    @Test fun storedTusUrlOnOtherOriginIsIgnored() = runBlocking {
        val e = create("0123456789")
        queue.update(e.id) { it.copy(tusUrl = "https://evil.example/api/sync/v1/uploads/u1", tusOffset = 8) }
        tusCreated(); tusOffset(4); tusOffset(8); server.json(itemJson(F1, "a.txt", size = 10))
        assertTrue(uploader.upload(queue.claimNext("k")!!) is UploadOutcome.Done)
        assertEquals("POST", server.takeRequest().method)
    }

    @Test fun tusLocationOnOtherOriginFails() = runBlocking {
        create("0123456789")
        tusCreated("https://evil.example/u1")
        val outcome = uploader.upload(queue.claimNext("k")!!)
        assertTrue(outcome is UploadOutcome.Failed)
        assertEquals(UploadFailure.OTHER, (outcome as UploadOutcome.Failed).failure)
        assertEquals(1, server.requestCount)
    }

    @Test fun replaceUsesPutWithIfMatch() = runBlocking {
        replace("hello", ifMatch = "v1")
        server.json(itemJson(F1, "a.txt", version = 2))
        assertEquals(UploadOutcome.Done(item(version = 2), null), uploader.upload(queue.claimNext("k")!!))
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/sync/v1/items/$F1/content", put.path)
        assertEquals("\"v1\"", put.getHeader("If-Match"))
    }

    @Test fun replaceConflictBecomesConflictCopy() = runBlocking {
        replace("hello", ifMatch = "v1")
        server.error(412, "conflict", itemJson = itemJson(F1, "a.txt", parentId = D1, version = 2))
        server.json(itemJson(F2, "a (Konflikt Pixel 9 2026-10-16 09-05).txt", parentId = D1), 201)
        val outcome = uploader.upload(queue.claimNext("k")!!)
        val copyName = "a (Konflikt Pixel 9 2026-10-16 09-05).txt"
        assertTrue(outcome is UploadOutcome.Done)
        assertEquals(copyName, (outcome as UploadOutcome.Done).conflictCopyName)
        assertEquals(F2, outcome.item.id)
        assertEquals("PUT", server.takeRequest().method)
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("/api/sync/v1/items/upload", post.requestUrl!!.encodedPath)
        assertEquals(D1, post.requestUrl!!.queryParameter("parentId"))
        assertEquals(copyName, post.requestUrl!!.queryParameter("name"))
        assertEquals("rename", post.requestUrl!!.queryParameter("onConflict"))
        assertEquals("hello", post.body.readUtf8())
    }

    @Test fun chainedReplaceUsesResultEtagOfPrevious() = runBlocking {
        val previous = replace("one", ifMatch = "v5")
        queue.claimNext("k")
        queue.markDone(previous.id, item(version = 7), null)
        val next = replace("two", ifMatch = "v5", chainAfter = previous.id)
        assertEquals("v7", queue.entry(previous.id)!!.resultEtag)
        server.json(itemJson(F1, "a.txt", version = 8))
        assertTrue(uploader.upload(queue.claimNext("k")!!.also { assertEquals(next.id, it.id) }) is UploadOutcome.Done)
        assertEquals("\"v7\"", server.takeRequest().getHeader("If-Match"))
    }

    @Test fun chainedReplaceAfterAConflictCopyKeepsItsOwnBase() = runBlocking {
        val previous = replace("one", ifMatch = "v5")
        queue.claimNext("k")
        queue.markDone(previous.id, item(F2, version = 1), "a (Konflikt …).txt")
        replace("two", ifMatch = "v5", chainAfter = previous.id)
        server.json(itemJson(F1, "a.txt", version = 8))
        uploader.upload(queue.claimNext("k")!!)
        assertEquals("\"v5\"", server.takeRequest().getHeader("If-Match"))
    }

    @Test fun chainedReplaceWaitsForRunningPrevious() = runBlocking {
        val previous = replace("one", ifMatch = "v5")
        queue.claimNext("k")
        val next = replace("two", ifMatch = "v5", chainAfter = previous.id)
        val outcome = uploader.upload(queue.entry(next.id)!!)
        assertTrue(outcome is UploadOutcome.Retry)
        assertEquals(0, server.requestCount)
    }

    @Test fun replaceOfDeletedFileIsRecreated() = runBlocking {
        replace("hello")
        server.error(404, "not_found")
        server.json(itemJson(F2, "a.txt"), 201)
        assertEquals(UploadOutcome.Done(item(F2), null), uploader.upload(queue.claimNext("k")!!))
        assertEquals("PUT", server.takeRequest().method)
        val post = server.takeRequest()
        assertEquals("/api/sync/v1/items/upload?parentId=root&name=a.txt&onConflict=rename", post.path)
    }

    @Test fun replaceOfDeletedFileInDeletedFolderFailsAsTargetGone() = runBlocking {
        replace("hello")
        server.error(404, "not_found"); server.error(404, "not_found")
        assertEquals(UploadFailure.TARGET_GONE, (uploader.upload(queue.claimNext("k")!!) as UploadOutcome.Failed).failure)
    }

    @Test fun errorMapping() = runBlocking {
        suspend fun run(code: Int, errorCode: String?): UploadOutcome {
            val e = create("hello")
            server.error(code, errorCode)
            val outcome = uploader.upload(queue.entry(e.id)!!)
            queue.remove(e.id)
            return outcome
        }
        assertEquals(UploadFailure.INSUFFICIENT_STORAGE, (run(507, "insufficient_storage") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.TARGET_GONE, (run(404, "not_found") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.SIGNED_OUT, (run(401, "unauthorized") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.READ_ONLY, (run(403, "forbidden") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.SPACE_UNAVAILABLE, (run(503, "space_unavailable") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.TOO_LARGE, (run(413, "too_large") as UploadOutcome.Failed).failure)
        assertEquals(UploadFailure.INVALID_NAME, (run(400, "invalid_name") as UploadOutcome.Failed).failure)
        assertTrue(run(500, null) is UploadOutcome.Retry)
        assertTrue(run(429, "rate_limited") is UploadOutcome.Retry)

        val closed = MockWebServer().apply { start() }
        val closedApi = closed.api()
        closed.shutdown()
        val e = create("hello")
        assertTrue(uploader(closedApi).upload(queue.entry(e.id)!!) is UploadOutcome.Retry)
    }

    @Test fun missingCopyFailsAsSourceMissing() = runBlocking {
        val e = create("hello")
        queue.copyFile(e.id).delete()
        assertEquals(UploadFailure.SOURCE_MISSING, (uploader.upload(queue.entry(e.id)!!) as UploadOutcome.Failed).failure)
        assertEquals(0, server.requestCount)
    }

    @Test fun tus507AtCompletionKeepsUploadForRetry() = runBlocking {
        val e = create("0123456789")
        tusCreated(); tusOffset(4); tusOffset(8); server.error(507, "insufficient_storage")
        val first = uploader.upload(queue.claimNext("k")!!)
        assertEquals(UploadFailure.INSUFFICIENT_STORAGE, (first as UploadOutcome.Failed).failure)
        queue.markFailed(e.id, first.failure, first.message)
        val kept = queue.entry(e.id)!!
        assertTrue(kept.tusUrl!!.endsWith("/api/sync/v1/uploads/u1"))
        assertEquals(8L, kept.tusOffset)
        repeat(4) { server.takeRequest() }

        queue.retry(e.id)
        tusHead(10); server.json(itemJson(F1, "a.txt", size = 10))
        assertTrue(uploader.upload(queue.claimNext("k")!!) is UploadOutcome.Done)
        assertEquals("HEAD", server.takeRequest().method)
        val publish = server.takeRequest()
        assertEquals("PATCH", publish.method)
        assertEquals("10", publish.getHeader("Upload-Offset"))
        assertEquals(0L, publish.bodySize)
    }

    @Test fun removedEntryStopsBetweenChunks() = runBlocking {
        val e = create("0123456789")
        tusCreated(); tusOffset(4); tusOffset(8); server.json(itemJson(F1, "a.txt", size = 10))
        var removed = false
        val outcome = uploader.upload(queue.claimNext("k")!!) { sent ->
            if (sent == 4L && !removed) { removed = true; runBlocking { queue.remove(e.id) } }
        }
        assertEquals(UploadOutcome.Removed, outcome)
        assertNull(queue.entry(e.id))
        assertEquals(2, server.requestCount)
    }
}
