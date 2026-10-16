package tech.jensk.synclet.ui.browser

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.account.AppSettings
import tech.jensk.synclet.core.account.ViewMode
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.D2
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.F2
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.ui.components.UiMessage

class FolderViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    @get:Rule val tmp = TemporaryFolder()

    private val key = "srv:u1"
    private val server = MockWebServer()
    private val ioScope = CoroutineScope(Dispatchers.IO + Job())
    private val listingCache = ListingCache()
    private lateinit var settings: AppSettings
    private val changes = MutableSharedFlow<FolderChange>()
    private val published = CopyOnWriteArrayList<FolderChange>()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()

    private val folder = folderItem(D1, "Docs")
    private val sub = folderItem(D2, "Sub", parentId = D1)
    private val fileB = fileItem(F1, "b.txt", parentId = D1)
    private val fileA = fileItem(F2, "A.txt", parentId = D1)
    private val third = fileItem("f_55555555-5555-5555-5555-555555555555", "c.txt", parentId = D1)

    /** Answers by path, so the concurrent item and children requests can arrive in any order. */
    @Volatile private var mutationResponse: (RecordedRequest) -> MockResponse = { json("{}") }
    @Volatile private var firstPage: List<SyncItem> = listOf(fileB, sub, fileA)
    @Volatile private var firstPageToken: String? = "p2"

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun page(items: List<SyncItem>, next: String?) = buildString {
        append("""{"items":[${items.joinToString(",") { itemJson(it) }}]""")
        if (next != null) append(""","nextPageToken":"$next"""")
        append(""","cursor":"1"}""")
    }

    private fun errorBody(code: Int, errorCode: String) = json("""{"statusCode":$code,"message":"x","code":"$errorCode"}""", code)

    @Before fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val url = request.requestUrl!!
                return when {
                    request.method != "GET" -> mutationResponse(request)
                    url.encodedPath == "/api/sync/v1/items/$D1" -> json(itemJson(folder))
                    url.encodedPath == "/api/sync/v1/items/$D1/children" -> when (url.queryParameter("pageToken")) {
                        null -> json(page(firstPage, firstPageToken))
                        "p2" -> json(page(listOf(third), null))
                        else -> MockResponse().setResponseCode(404)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        settings = AppSettings(PreferenceDataStoreFactory.create(scope = ioScope, produceFile = { File(tmp.root, "s.preferences_pb") }))
    }

    @After fun tearDown() {
        ioScope.cancel()
        runCatching { server.shutdown() }
    }

    private fun session(): AccountSession {
        val tokens = AccountTokens(key, "syd_test") { _, _ -> }
        return AccountSession(key, SyncApi(server.url("/"), okhttp3.OkHttpClient(), tokens), tokens) { null }
    }

    private fun vm() = FolderViewModel(session(), D1, listingCache, settings, changes, { published += it })

    private fun FolderViewModel.await(predicate: (FolderViewModel.State) -> Boolean): FolderViewModel.State =
        runBlocking { withTimeout(5_000) { state.first(predicate) } }

    private fun FolderViewModel.loaded() = await { !it.loading && !it.refreshing && it.folder != null }

    private fun childrenRequests() = requests.filter { it.method == "GET" && it.requestUrl!!.encodedPath.endsWith("/children") }

    private fun eventually(condition: () -> Boolean) = runBlocking { withTimeout(5_000) { while (!condition()) delay(20) } }

    @Test fun loadsFolderAndFirstPageSortedFoldersFirst() {
        val vm = vm()
        val s = vm.loaded()
        assertEquals(listOf("Sub", "A.txt", "b.txt"), s.items.map { it.name })
        assertEquals("p2", s.nextPageToken)
        assertEquals(folder, s.folder)
        assertFalse(listingCache.get(key, D1)!!.complete)
        val children = childrenRequests().single().requestUrl!!
        assertEquals("200", children.queryParameter("limit"))
        assertNull(children.queryParameter("folderThumbnails"))
        assertTrue(requests.any { it.requestUrl!!.encodedPath == "/api/sync/v1/items/$D1" })
    }

    @Test fun loadMoreAppendsTheNextPage() {
        val vm = vm()
        vm.loaded()
        vm.loadMore()
        val s = vm.await { it.items.size == 4 && !it.loadingMore }
        assertEquals(listOf("Sub", "A.txt", "b.txt", "c.txt"), s.items.map { it.name })
        assertTrue(s.endReached)
        assertTrue(listingCache.get(key, D1)!!.complete)
        assertEquals(4, listingCache.get(key, D1)!!.items.size)
        assertEquals("p2", childrenRequests().last().requestUrl!!.queryParameter("pageToken"))
    }

    @Test fun gridModeAsksForFolderThumbnails() {
        val vm = vm()
        vm.loaded()
        runBlocking { settings.setViewMode(ViewMode.GRID) }
        eventually { childrenRequests().size == 2 }
        assertEquals("1", childrenRequests().last().requestUrl!!.queryParameter("folderThumbnails"))
        assertEquals(ViewMode.GRID, vm.await { it.viewMode == ViewMode.GRID }.viewMode)
    }

    @Test fun renameConflictReloadsAndReportsChanged() {
        mutationResponse = { errorBody(412, "conflict") }
        val vm = vm()
        vm.loaded()
        val results = CopyOnWriteArrayList<Any>()
        vm.rename(fileB, "new.txt") { results += it ?: "null" }
        val s = vm.await { it.message != null }
        eventually { results.isNotEmpty() }
        assertEquals(listOf<Any>("null"), results.toList())
        val error = (s.message as UiMessage.Error).error
        assertEquals(412, (error as SyncError.Http).status)
        eventually { childrenRequests().size == 2 }
        val patch = requests.single { it.method == "PATCH" }
        assertEquals("\"v1\"", patch.getHeader("If-Match"))
        assertEquals("""{"name":"new.txt"}""", patch.body.readUtf8())
    }

    @Test fun renameNameConflictKeepsTheDialogOpen() {
        mutationResponse = { errorBody(409, "name_conflict") }
        val vm = vm()
        vm.loaded()
        val results = CopyOnWriteArrayList<Throwable?>()
        vm.rename(fileB, "A.txt") { results += it }
        eventually { results.isNotEmpty() }
        val e = results.single() as SyncError.Http
        assertEquals("name_conflict", e.code)
        Thread.sleep(200)
        assertEquals(1, childrenRequests().size)
        assertNull(vm.state.value.message)
    }

    @Test fun deleteSendsIfMatchForEachSelectedItemAndPublishes() {
        mutationResponse = { MockResponse().setResponseCode(204) }
        val vm = vm()
        vm.loaded()
        vm.toggleSelection(F1)
        vm.toggleSelection(D2)
        val selected = vm.state.value.selectedItems
        assertEquals(2, selected.size)
        vm.delete(selected)
        val s = vm.await { it.message != null }
        val deletes = requests.filter { it.method == "DELETE" }
        assertEquals(2, deletes.size)
        assertEquals(setOf("/api/sync/v1/items/$F1", "/api/sync/v1/items/$D2"), deletes.map { it.requestUrl!!.encodedPath }.toSet())
        assertEquals(setOf("\"v1\"", "\"t00000000000000a1\""), deletes.map { it.getHeader("If-Match") }.toSet())
        assertEquals(listOf("A.txt"), s.items.map { it.name })
        assertTrue(s.selection.isEmpty())
        assertTrue(FolderChange.Folders(key, setOf(D1)) in published)
        val text = s.message as UiMessage.Text
        assertTrue(text.plural)
        assertEquals(listOf<Any>(2), text.args)
    }

    @Test fun moveSendsParentAndIfMatch() {
        val target = "d_77777777-7777-7777-7777-777777777777"
        mutationResponse = { json(itemJson(fileB.copy(parentId = target))) }
        val vm = vm()
        vm.loaded()
        vm.toggleSelection(F1)
        vm.move(listOf(fileB), target)
        eventually { published.isNotEmpty() }
        val patch = requests.single { it.method == "PATCH" }
        assertEquals("/api/sync/v1/items/$F1", patch.requestUrl!!.encodedPath)
        assertEquals("""{"parentId":"$target"}""", patch.body.readUtf8())
        assertEquals("\"v1\"", patch.getHeader("If-Match"))
        assertEquals(listOf("Sub", "A.txt"), vm.state.value.items.map { it.name })
        assertTrue(vm.state.value.selection.isEmpty())
        assertEquals(listOf<FolderChange>(FolderChange.Folders(key, setOf(D1, target))), published.toList())
    }

    @Test fun moveToD2SendsThatParent() {
        mutationResponse = { json(itemJson(fileB.copy(parentId = D2))) }
        val vm = vm()
        vm.loaded()
        vm.move(listOf(fileB), D2)
        eventually { published.isNotEmpty() }
        assertEquals("""{"parentId":"$D2"}""", requests.single { it.method == "PATCH" }.body.readUtf8())
        assertEquals(FolderChange.Folders(key, setOf(D1, D2)), published.single())
    }

    @Test fun remoteChangeOfThisFolderReloads() {
        val vm = vm()
        vm.loaded()
        runBlocking { changes.emit(FolderChange.Folders(key, setOf(D2))) }
        Thread.sleep(200)
        assertEquals(1, childrenRequests().size)
        runBlocking { changes.emit(FolderChange.Folders("other:key", setOf(D1))) }
        Thread.sleep(200)
        assertEquals(1, childrenRequests().size)
        runBlocking { changes.emit(FolderChange.Folders(key, setOf(D1))) }
        eventually { childrenRequests().size == 2 }
        runBlocking { changes.emit(FolderChange.Everything(key)) }
        eventually { childrenRequests().size == 3 }
    }

    @Test fun offlineLoadShowsOfflineState() {
        server.shutdown()
        val vm = vm()
        val s = vm.await { !it.loading && it.error != null }
        assertTrue(s.error is SyncError.Transport)
        assertTrue(s.items.isEmpty())
    }
}
