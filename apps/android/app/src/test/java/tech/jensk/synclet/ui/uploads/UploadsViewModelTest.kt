package tech.jensk.synclet.ui.uploads

import java.io.File
import java.io.ByteArrayInputStream
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.upload.UploadEntry
import tech.jensk.synclet.core.upload.UploadFailure
import tech.jensk.synclet.core.upload.UploadQueue
import tech.jensk.synclet.core.upload.UploadStatus
import tech.jensk.synclet.testing.MainDispatcherRule

class UploadsViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun queue(clock: () -> Long = System::currentTimeMillis) = UploadQueue(tmp.newFolder(), clock)

    private suspend fun add(q: UploadQueue, name: String): UploadEntry =
        q.entry(q.enqueueCreate("acc", "root", "My Files", name, { ByteArrayInputStream(ByteArray(3)) }).id)!!

    @Test fun rowsAreOrderedUploadingWaitingFailedDone() = runBlocking {
        var now = 1_000L
        val q = queue { now++ }
        val done1 = add(q, "done1"); val failed = add(q, "failed"); val waiting = add(q, "waiting")
        val uploading = add(q, "uploading"); val done2 = add(q, "done2")
        q.update(done1.id) { it.copy(status = UploadStatus.DONE, finishedAt = 10) }
        q.update(done2.id) { it.copy(status = UploadStatus.DONE, finishedAt = 20) }
        q.update(failed.id) { it.copy(status = UploadStatus.FAILED, failure = UploadFailure.OTHER) }
        q.update(uploading.id) { it.copy(status = UploadStatus.UPLOADING) }
        val vm = UploadsViewModel(q, { _, _ -> }, { })
        assertEquals(listOf("uploading", "waiting", "failed", "done2", "done1"), vm.rows.first { it.size == 5 }.map { it.name })
    }

    @Test fun retryResetsAndRestartsTheWorker() = runBlocking {
        val q = queue()
        val e = add(q, "a.txt")
        q.update(e.id) { it.copy(status = UploadStatus.FAILED, failure = UploadFailure.OTHER, attempts = 4) }
        val calls = mutableListOf<Pair<String, Boolean>>()
        val vm = UploadsViewModel(q, { k, r -> calls += k to r }, { })
        vm.retry(q.entry(e.id)!!).join()
        val after = q.entry(e.id)!!
        assertEquals(UploadStatus.WAITING, after.status)
        assertEquals(0, after.attempts)
        assertEquals(listOf("acc" to true), calls)
    }

    @Test fun removeDropsTheEntryAndTerminatesTus() = runBlocking {
        val q = queue()
        val e = add(q, "big.bin")
        q.update(e.id) { it.copy(status = UploadStatus.UPLOADING, tusUrl = "http://x/tus/1") }
        val copy: File = q.copyFile(e.id)
        assertTrue(copy.exists())
        val terminated = mutableListOf<String>()
        val vm = UploadsViewModel(q, { _, _ -> }, { terminated += it.id })
        vm.remove(q.entry(e.id)!!).join()
        assertEquals(listOf(e.id), terminated)
        assertFalse(copy.exists())
        assertNull(q.entry(e.id))
    }

    @Test fun removeWithoutTusDoesNotTerminate() = runBlocking {
        val q = queue()
        val e = add(q, "a.txt")
        val terminated = mutableListOf<String>()
        UploadsViewModel(q, { _, _ -> }, { terminated += it.id }).remove(e).join()
        assertTrue(terminated.isEmpty())
        assertNull(q.entry(e.id))
    }

    @Test fun clearDoneRemovesFinishedEntries() = runBlocking {
        val q = queue()
        val d = add(q, "d"); val w = add(q, "w")
        q.update(d.id) { it.copy(status = UploadStatus.DONE, finishedAt = 5) }
        val vm = UploadsViewModel(q, { _, _ -> }, { })
        vm.rows.first { it.size == 2 }
        vm.clearDone().join()
        assertEquals(listOf("w"), q.entries.value.map { it.name })
    }
}
