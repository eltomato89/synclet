package tech.jensk.synclet.core.upload

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.itemJson

class UploadQueueTest {
    @get:Rule val tmp = TemporaryFolder()
    private var now = 1_000_000L
    private fun queue() = UploadQueue(File(tmp.root, "uploads")) { now }
    private fun source(text: String) = UploadSource { text.byteInputStream() }

    @Test fun enqueueCopiesTheSourceSoItsLossIsHarmless() = runBlocking {
        val src = tmp.newFile("photo.jpg").apply { writeText("pixels") }
        val q = queue()
        val e = q.enqueueCreate("k", "root", "My Files", "photo.jpg", { src.inputStream() })
        src.delete()
        assertEquals("pixels", q.copyFile(e.id).readText())
        assertEquals(6L, e.size)
        assertEquals(UploadStatus.WAITING, e.status)
    }

    @Test fun failingSourceLeavesNoEntryAndNoFile() = runBlocking {
        val q = queue()
        try {
            q.enqueueCreate("k", "root", "", "a", { throw java.io.IOException("gone") })
            org.junit.Assert.fail()
        } catch (e: java.io.IOException) { }
        assertTrue(q.entries.value.isEmpty())
        assertTrue(File(tmp.root, "uploads").list()!!.none { it != "queue.json" })
    }

    @Test fun persistsVersionedJsonAndReloads() = runBlocking {
        queue().enqueueCreate("k", "root", "", "a.txt", source("a"))
        val text = File(tmp.root, "uploads/queue.json").readText()
        assertTrue(text.contains("\"v\":1"))
        assertTrue(text.contains("\"status\":\"waiting\""))
        val again = queue(); again.load()
        assertEquals(listOf("a.txt"), again.entries.value.map { it.name })
    }

    @Test fun corruptOrFutureFileIsMovedAside() = runBlocking {
        File(tmp.root, "uploads").mkdirs()
        File(tmp.root, "uploads/queue.json").writeText("{\"v\":2,\"entries\":[]}")
        val q = queue(); q.load()
        assertTrue(q.entries.value.isEmpty())
        assertTrue(File(tmp.root, "uploads").list()!!.any { it.startsWith("queue.json.corrupt-") })
    }

    @Test fun brokenJsonIsMovedAside() = runBlocking {
        File(tmp.root, "uploads").mkdirs()
        File(tmp.root, "uploads/queue.json").writeText("{\"v\":1,\"entries\":[{")
        val q = queue(); q.load()
        assertTrue(q.entries.value.isEmpty())
        assertTrue(File(tmp.root, "uploads").list()!!.any { it.startsWith("queue.json.corrupt-") })
    }

    @Test fun unknownFailureOfANewerClientDecodesAsNull() = runBlocking {
        File(tmp.root, "uploads").mkdirs()
        File(tmp.root, "uploads/queue.json").writeText(
            """{"v":1,"entries":[{"id":"x","accountKey":"k","parentId":"root","name":"a","size":1,""" +
                """"status":"failed","failure":"quota_dance","createdAt":1,"future":true}]}""")
        val q = queue(); q.load()
        val e = q.entries.value.single()
        assertEquals(UploadStatus.FAILED, e.status)
        assertNull(e.failure)
    }

    @Test fun claimNextIsFifoPerAccountAndResumesInterruptedFirst() = runBlocking {
        val q = queue()
        val a = q.enqueueCreate("k", "root", "", "a", source("a")); now++
        q.enqueueCreate("k", "root", "", "b", source("b")); now++
        q.enqueueCreate("other", "root", "", "c", source("c"))
        assertEquals(a.id, q.claimNext("k")!!.id)
        assertEquals(a.id, q.claimNext("k")!!.id)          // still UPLOADING (worker died) → claimed again
        q.markDone(a.id, item(F1), null)
        assertEquals("b", q.claimNext("k")!!.name)
    }

    @Test fun waitingReplaceIsCoalesced() = runBlocking {
        val q = queue()
        val first = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("one") }, null)
        val second = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("two!") }, first.id)
        assertEquals(first.id, second.id)
        assertEquals(1, q.entries.value.size)
        assertEquals("two!", q.copyFile(first.id).readText())
        assertEquals("v3", second.ifMatch)
        assertEquals(4L, second.size)
    }

    @Test fun replaceWhileUploadingIsChained() = runBlocking {
        val q = queue()
        val first = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("one") }, null)
        q.claimNext("k")
        val pending = q.pendingReplace("k", F1)!!
        assertEquals(first.id, pending.id)
        val second = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("two") }, pending.id)
        assertNotEquals(first.id, second.id)
        assertEquals(first.id, second.chainAfter)
        assertEquals("one", q.copyFile(first.id).readText())
        assertEquals("two", q.copyFile(second.id).readText())
    }

    @Test fun markDoneRecordsResultAndDeletesTheCopy() = runBlocking {
        val q = queue()
        val e = q.enqueueCreate("k", "root", "", "a", source("a"))
        q.markDone(e.id, item(F1, version = 4), null)
        val done = q.entry(e.id)!!
        assertEquals(UploadStatus.DONE, done.status)
        assertEquals("v4", done.resultEtag)
        assertEquals(F1, done.resultItemId)
        assertFalse(q.copyFile(e.id).exists())
    }

    @Test fun pruneDropsDoneAfterADayAndOrphanCopies() = runBlocking {
        val q = queue()
        val e = q.enqueueCreate("k", "root", "", "a", source("a"))
        q.markDone(e.id, item(F1), null)
        File(tmp.root, "uploads/orphan").writeText("x")
        now += 24 * 3_600_000L + 1
        q.prune()
        assertNull(q.entry(e.id))
        assertFalse(File(tmp.root, "uploads/orphan").exists())
    }

    @Test fun pruneKeepsRecentDoneAndWaitingCopies() = runBlocking {
        val q = queue()
        val done = q.enqueueCreate("k", "root", "", "a", source("a"))
        val waiting = q.enqueueCreate("k", "root", "", "b", source("b"))
        q.markDone(done.id, item(F1), null)
        now += 3_600_000L
        q.prune()
        assertEquals(UploadStatus.DONE, q.entry(done.id)!!.status)
        assertEquals("b", q.copyFile(waiting.id).readText())
    }

    @Test fun removeAccountDropsEntriesAndCopies() = runBlocking {
        val q = queue()
        val e = q.enqueueCreate("k", "root", "", "a", source("a"))
        q.enqueueCreate("other", "root", "", "b", source("b"))
        q.removeAccount("k")
        assertEquals(listOf("b"), q.entries.value.map { it.name })
        assertFalse(q.copyFile(e.id).exists())
    }

    @Test fun retryResetsAFailedEntry() = runBlocking {
        val q = queue()
        val e = q.enqueueCreate("k", "root", "", "a", source("a"))
        q.markRetry(e.id, "net"); q.markFailed(e.id, UploadFailure.INSUFFICIENT_STORAGE, "full")
        q.retry(e.id)
        val r = q.entry(e.id)!!
        assertEquals(UploadStatus.WAITING, r.status); assertEquals(0, r.attempts); assertNull(r.failure)
    }

    @Test fun hasWorkSeesWaitingAndUploadingOnly() = runBlocking {
        val q = queue()
        val e = q.enqueueCreate("k", "root", "", "a", source("a"))
        assertTrue(q.hasWork("k")); assertFalse(q.hasWork("other"))
        q.markFailed(e.id, UploadFailure.OTHER, null)
        assertFalse(q.hasWork("k"))
    }

    @Test fun coalescedEntryStartsWithFreshAttempts() = runBlocking {
        val q = queue()
        val first = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("one") }, null)
        q.claimNext("k"); q.markRetry(first.id, "net"); q.claimNext("k"); q.markRetry(first.id, "net")
        val merged = q.enqueueReplace("k", F1, "root", "", "a.txt", "v3", tmp.newFile().apply { writeText("two") }, null)
        assertEquals(first.id, merged.id)
        assertEquals(0, merged.attempts)
        assertNull(merged.message)
        assertEquals(0, q.entry(first.id)!!.attempts)
    }

    private fun item(id: String, version: Long = 1) = SyncJson.decodeFromString(SyncItem.serializer(), itemJson(id, "a", version = version))
}
