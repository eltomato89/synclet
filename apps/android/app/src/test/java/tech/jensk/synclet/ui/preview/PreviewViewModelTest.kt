package tech.jensk.synclet.ui.preview

import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.F2
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

class PreviewViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private val key = "acc-key"
    private val listing = ListingCache()
    private val F3 = "f_55555555-5555-5555-5555-555555555555"

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private fun vm(folderId: String?, itemId: String): PreviewViewModel {
        val session = AccountSession(key, server.api(), AccountTokens(key, "syd_test") { _, _ -> }) { null }
        return PreviewViewModel(session, key, folderId, itemId, listing, FileCache(File(tmp.root, "files")))
    }

    private fun PreviewViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.loading } } }

    @Test fun siblingsComeFromTheListingCacheWithoutRequests() {
        val folder = folderItem("d_66666666-6666-6666-6666-666666666666", "Sub", parentId = D1)
        val a = fileItem(F2, "a.jpg", parentId = D1)
        val b = fileItem(F1, "b.txt", parentId = D1)
        val c = fileItem(F3, "c.pdf", parentId = D1)
        listing.put(key, D1, listOf(folder, c, a, b))
        listing.putItem(key, b)
        val s = vm(D1, F1).settle()
        assertEquals(listOf(a, b, c), s.siblings)
        assertEquals(1, s.index)
        assertEquals(0, server.requestCount)
    }

    @Test fun siblingsAreLoadedWhenNotCached() {
        val a = fileItem(F2, "a.jpg", parentId = D1)
        val b = fileItem(F1, "b.txt", parentId = D1)
        server.json(itemJson(b))
        server.json("""{"items":[${itemJson(b)},${itemJson(a)}],"cursor":"1"}""")
        val s = vm(D1, F1).settle()
        assertEquals(listOf(a, b), s.siblings)
        assertEquals(1, s.index)
        assertEquals("/api/sync/v1/items/$F1", server.takeRequest().path)
        assertTrue(server.takeRequest().path!!.startsWith("/api/sync/v1/items/$D1/children?limit=1000"))
    }

    @Test fun withoutFolderOnlyTheItemIsShown() {
        val b = fileItem(F1, "b.txt", parentId = D1)
        listing.putItem(key, b)
        val s = vm(null, F1).settle()
        assertEquals(listOf(b), s.siblings)
        assertEquals(0, s.index)
    }

    @Test fun mediaUrlResolvesThePathOnlyTokenUrl() = runBlocking {
        val b = fileItem(F1, "b.mp4", parentId = D1)
        listing.putItem(key, b)
        val vm = vm(null, F1).also { it.settle() }
        server.json("""{"url":"/api/sync/v1/items/$F1/content?dt=abc","token":"abc","expiresAt":"2026-10-16T10:00:00.000Z"}""")
        val origin = server.url("/").toString().trimEnd('/')
        assertEquals("$origin/api/sync/v1/items/$F1/content?dt=abc", vm.mediaUrl(b))
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/sync/v1/items/$F1/download-token?purpose=preview", req.path)
    }

    @Test fun textPreviewIsLoaded() = runBlocking {
        val b = fileItem(F1, "b.txt", parentId = D1)
        listing.putItem(key, b)
        val vm = vm(null, F1).also { it.settle() }
        server.json("""{"text":"hi","truncated":true,"encoding":"utf-8"}""")
        val t = vm.text(b)
        assertEquals("hi", t.text)
        assertTrue(t.truncated)
        assertEquals("/api/sync/v1/items/$F1/preview-text", server.takeRequest().path)
    }

    @Test fun originalIsFetchedIntoTheFileCacheWithProgress() = runBlocking {
        val b: SyncItem = fileItem(F1, "b.txt", parentId = D1, size = 5)
        listing.putItem(key, b)
        val vm = vm(null, F1).also { it.settle() }
        server.enqueue(MockResponse().setBody("hello").setHeader("Content-Length", "5"))
        val file = vm.original(b)
        assertEquals("hello", file.readText())
        assertEquals(1f, vm.state.value.progress[F1])
        assertNotNull(vm.state.value.progress[F1])
    }
}
