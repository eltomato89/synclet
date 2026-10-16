package tech.jensk.synclet.provider

import android.content.Context
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.FileNotFoundException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import tech.jensk.synclet.core.upload.UploadStatus
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.F2
import tech.jensk.synclet.testing.error
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProviderWriteTest : ProviderTestBase() {

    @Test fun readDownloadsOnceIntoTheFileCache() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        server.enqueue(MockResponse().setBody("hello"))
        assertEquals("hello", read("srv:u1/$F1"))
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        assertEquals("hello", read("srv:u1/$F1"))
        assertEquals(3, server.requestCount)            // item, content, item – no second download
    }

    @Test fun writeIsUploadedOnCloseAsReplaceWithTheEtagSeenAtOpen() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        write("srv:u1/$F1", "w", "new")
        val entry = runBlocking { env.uploadQueue.pendingReplace("srv:u1", F1) }!!
        assertEquals("v3", entry.ifMatch)
        assertEquals(3L, entry.size)
        assertEquals(listOf("srv:u1"), env.scheduled)
        // The working copy lived outside the queue directory and is gone after the hand-over.
        assertTrue(workFiles().isEmpty())
        assertTrue(env.uploadQueue.copyFile(entry.id).isFile)
    }

    @Test fun readAfterWriteServesThePendingCopy() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        write("srv:u1/$F1", "w", "new")
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        assertEquals("new", read("srv:u1/$F1"))
        assertEquals(2, server.requestCount)            // no content download
    }

    @Test fun readRightAfterCloseWaitsForTheHandOver() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument("srv:u1/$F1", "w", null)).use { it.write("fresh".toByteArray()) }
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        assertEquals("fresh", read("srv:u1/$F1"))       // no waitUntil: the provider waits for its own close listener
        assertEquals(2, server.requestCount)
    }

    @Test fun secondWriteWhileTheFirstWaitsIsCoalesced() {
        repeat(2) { n -> server.json(itemJson(fileItem(F1, "a.txt", version = 3))); write("srv:u1/$F1", "w", "v$n") }
        assertEquals(1, env.uploadQueue.entries.value.size)
        assertEquals("v1", env.uploadQueue.copyFile(env.uploadQueue.entries.value.single().id).readText())
    }

    @Test fun readWriteWithoutChangesUploadsNothing() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        server.enqueue(MockResponse().setBody("same"))
        provider.openDocument("srv:u1/$F1", "rw", null).close()
        waitUntil { workFiles().isEmpty() }                 // the close listener (provider's close thread) dropped the copy
        assertTrue(env.uploadQueue.entries.value.isEmpty())
    }

    // crashedWriterIsNotUploaded runs on a device (androidTest ProviderWriteDeviceTest): Robolectric 4.17's
    // ShadowParcelFileDescriptor calls the close listener only from close(), never from closeWithError().

    @Test fun writingAReadOnlyFileIsRefused() {
        server.json(itemJson(fileItem(F1, "a.txt", canWrite = false)))
        assertThrows(FileNotFoundException::class.java) { provider.openDocument("srv:u1/$F1", "w", null) }
    }

    @Test fun createFileUploadsAnEmptyFileAndReturnsItsId() {
        server.json(itemJson(folderItem("root", "Meine Dateien", parentId = null)))
        server.json(itemJson(fileItem(F2, "note.txt", size = 0)))
        assertEquals("srv:u1/$F2", provider.createDocument("srv:u1/root", "text/plain", "note"))
        server.takeRequest()
        val upload = server.takeRequest()
        assertEquals("POST", upload.method)
        assertEquals("/api/sync/v1/items/upload?parentId=root&name=note.txt&onConflict=rename", upload.path)
        assertEquals(0L, upload.bodySize)
        assertTrue(env.notifier.children.contains("srv:u1" to "root"))
    }

    @Test fun createFolderUsesCreateFolder() {
        server.json(itemJson(folderItem("root", "Meine Dateien", parentId = null)))
        server.json(itemJson(folderItem(D1, "New")), code = 201)
        assertEquals("srv:u1/$D1", provider.createDocument("srv:u1/root", Document.MIME_TYPE_DIR, "New"))
        server.takeRequest()
        val create = server.takeRequest()
        assertEquals("POST", create.method)
        assertEquals("/api/sync/v1/items", create.path)
        val body = create.body.readUtf8()
        assertTrue(body, body.contains("\"type\":\"folder\""))
        assertTrue(body, body.contains("\"name\":\"New\""))
    }

    @Test fun createInTopLevelIsRefused() {
        assertThrows(UnsupportedOperationException::class.java) { provider.createDocument("srv:u1/top", "text/plain", "x") }
        assertEquals(0, server.requestCount)
    }

    @Test fun renameSendsIfMatchAndMapsConflict() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "a.txt", version = 3)))
        server.error(412, "conflict", item = fileItem(F1, "a.txt", version = 4))
        val e = assertThrows(IllegalStateException::class.java) { provider.renameDocument("srv:u1/$F1", "b.txt") }
        assertEquals("Changed in the meantime", e.message)
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("\"v3\"", request.getHeader("If-Match"))
        assertEquals(0L, env.listingCache.get("srv:u1", "root")!!.loadedAt)        // invalidated
        assertTrue(env.notifier.children.contains("srv:u1" to "root"))
        // The 412 carried the current item: a retry (e.g. from search, where no listing reload happens) uses its etag.
        server.json(itemJson(fileItem(F1, "b.txt", version = 4)))
        provider.renameDocument("srv:u1/$F1", "b.txt")
        assertEquals("\"v4\"", server.takeRequest().getHeader("If-Match"))
        assertEquals(2, server.requestCount)
    }

    @Test fun conflictWithoutItemForgetsTheCachedItem() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "a.txt", version = 3)))
        server.error(412, "conflict")
        assertThrows(IllegalStateException::class.java) { provider.renameDocument("srv:u1/$F1", "b.txt") }
        server.takeRequest()
        server.json(itemJson(fileItem(F1, "a.txt", version = 5)))
        server.json(itemJson(fileItem(F1, "b.txt", version = 5)))
        provider.renameDocument("srv:u1/$F1", "b.txt")
        assertEquals("GET", server.takeRequest().method)                           // fetched again
        assertEquals("\"v5\"", server.takeRequest().getHeader("If-Match"))
    }

    @Test fun renameUpdatesTheCache() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "a.txt", version = 3)))
        server.json(itemJson(fileItem(F1, "b.txt", version = 3)))
        assertNull(provider.renameDocument("srv:u1/$F1", "b.txt"))
        assertEquals("b.txt", env.listingCache.item("srv:u1", F1)!!.name)
        assertTrue(env.notifier.documents.contains("srv:u1" to F1))
    }

    @Test fun deleteSendsIfMatchAndTreats404AsDone() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "a.txt", version = 3)))
        server.error(404, "not_found")
        provider.deleteDocument("srv:u1/$F1")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("\"v3\"", request.getHeader("If-Match"))
        assertNull(env.listingCache.item("srv:u1", F1))
        assertEquals(listOf("srv:u1" to "root"), env.notifier.children.toList())   // notified once
    }

    @Test fun deleteDropsAWaitingReplaceSoTheFileDoesNotReappear() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        write("srv:u1/$F1", "w", "edit")
        assertEquals(1, env.uploadQueue.entries.value.size)
        server.enqueue(MockResponse().setResponseCode(204))
        provider.deleteDocument("srv:u1/$F1")
        assertTrue(env.uploadQueue.entries.value.isEmpty())
        assertNull(runBlocking { env.uploadQueue.pendingReplace("srv:u1", F1) })
    }

    @Test fun deleteDropsARunningReplaceAndTerminatesItsTusUpload() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        write("srv:u1/$F1", "w", "edit")
        val tus = server.url("/api/sync/v1/tus/abc").toString()
        val running = runBlocking { env.uploadQueue.claimNext("srv:u1")!!.let { e -> env.uploadQueue.update(e.id) { it.copy(tusUrl = tus) } } }!!
        assertEquals(UploadStatus.UPLOADING, running.status)
        server.enqueue(MockResponse().setResponseCode(204))      // DELETE item
        server.enqueue(MockResponse().setResponseCode(204))      // DELETE tus
        provider.deleteDocument("srv:u1/$F1")
        assertTrue(env.uploadQueue.entries.value.isEmpty())
        server.takeRequest(); server.takeRequest()                // GET item (write), DELETE item
        val terminate = server.takeRequest()
        assertEquals("DELETE", terminate.method)
        assertEquals("/api/sync/v1/tus/abc", terminate.path)
    }

    @Test fun failedDeleteKeepsTheQueuedEdit() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        write("srv:u1/$F1", "w", "edit")
        server.error(412, "conflict", item = fileItem(F1, "a.txt", version = 4))
        assertThrows(IllegalStateException::class.java) { provider.deleteDocument("srv:u1/$F1") }
        assertEquals(1, env.uploadQueue.entries.value.size)
    }

    @Test fun queuedWriteNamesTheParentAndRefreshesItsListing() {
        env.listingCache.put("srv:u1", "root", listOf(folderItem(D1, "Docs")))
        env.listingCache.put("srv:u1", D1, listOf(fileItem(F1, "a.txt", parentId = D1, version = 3)))
        server.json(itemJson(fileItem(F1, "a.txt", parentId = D1, version = 3)))
        write("srv:u1/$F1", "w", "edit")
        val entry = runBlocking { env.uploadQueue.pendingReplace("srv:u1", F1) }!!
        assertEquals("Docs", entry.parentName)
        assertEquals(D1, entry.parentId)
        waitUntil { env.notifier.children.contains("srv:u1" to D1) }
        assertEquals(0L, env.listingCache.get("srv:u1", D1)!!.loadedAt)
    }

    @Test fun waitForAnOpenWriterIsCappedAndCancellable() {
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        val writer = provider.openDocument("srv:u1/$F1", "w", null)          // stays open
        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        server.enqueue(MockResponse().setBody("old"))
        val start = System.currentTimeMillis()
        assertEquals("old", read("srv:u1/$F1"))
        assertTrue(System.currentTimeMillis() - start < 2_000)               // capped at about 1 s

        server.json(itemJson(fileItem(F1, "a.txt", version = 3)))
        val signal = CancellationSignal()
        Thread { Thread.sleep(150); signal.cancel() }.start()
        val cancelStart = System.currentTimeMillis()
        assertThrows(OperationCanceledException::class.java) { provider.openDocument("srv:u1/$F1", "r", signal) }
        assertTrue(System.currentTimeMillis() - cancelStart < 800)
        writer.close()
    }

    @Test fun moveSendsTheNewParent() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "a.txt", version = 3), folderItem(D1, "Docs")))
        server.json(itemJson(fileItem(F1, "a.txt", parentId = D1, version = 3)))
        assertEquals("srv:u1/$F1", provider.moveDocument("srv:u1/$F1", "srv:u1/root", "srv:u1/$D1"))
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertTrue(request.body.readUtf8().contains("\"parentId\":\"$D1\""))
        assertTrue(env.notifier.children.containsAll(listOf("srv:u1" to "root", "srv:u1" to D1)))
    }

    @Test fun moveAcrossAccountsIsRefused() {
        assertThrows(UnsupportedOperationException::class.java) {
            provider.moveDocument("srv:u1/$F1", "srv:u1/root", "other:u2/root")
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun invalidNameIsRefusedBeforeTheServer() {
        assertThrows(IllegalArgumentException::class.java) { provider.renameDocument("srv:u1/$F1", "a/b") }
        assertEquals(0, server.requestCount)
    }

    private fun workFiles(): List<File> =
        File(ApplicationProvider.getApplicationContext<Context>().cacheDir, "provider-work").listFiles().orEmpty().toList()

    private fun read(id: String) =
        ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument(id, "r", null)).use { it.readBytes().decodeToString() }

    private fun write(id: String, mode: String, text: String) {
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(id, mode, null)).use { it.write(text.toByteArray()) }
        waitUntil {
            runBlocking { env.uploadQueue.pendingReplace("srv:u1", F1) }?.let { env.uploadQueue.copyFile(it.id).readText() == text } == true
        }
    }
}
