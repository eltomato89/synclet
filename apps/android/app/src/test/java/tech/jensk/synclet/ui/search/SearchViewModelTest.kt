package tech.jensk.synclet.ui.search

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

class SearchViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private fun session() = AccountSession("org", server.api(), AccountTokens("org", "t") { _, _ -> }) { null }
    private fun vm(folderId: String? = null) = SearchViewModel(session(), folderId, folderId?.let { "Docs" }, debounceMs = 0, pageSize = 50)
    private fun SearchViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.loading } } }

    private fun hits(count: Int, total: Int, offset: Int = 0) = buildString {
        append("""{"hits":[""")
        append((0 until count).joinToString(",") {
            val item = fileItem("f_%08d-0000-0000-0000-000000000000".format(offset + it), "r${offset + it}.txt")
            """{"item":${itemJson(item)},"path":"Docs/r${offset + it}.txt","snippet":"a «rep» b","matched":"content"}"""
        })
        append("""],"total":$total}""")
    }

    @Test fun typingSearchesOnce() {
        server.json(hits(1, 1))
        val vm = vm()
        vm.onQueryChange("rep")
        val s = vm.settle()
        assertEquals("/api/sync/v1/search?q=rep&limit=50&offset=0", server.takeRequest().path)
        assertEquals(1, server.requestCount)
        assertEquals("Docs/r0.txt", s.hits.single().path)
        assertEquals("a «rep» b", s.hits.single().snippet)
    }

    @Test fun folderScopeAddsTheFolder() {
        server.json(hits(1, 1)); server.json(hits(1, 1))
        val vm = vm(D1)
        vm.onQueryChange("rep"); vm.settle()
        assertEquals("/api/sync/v1/search?q=rep&limit=50&offset=0&folder=$D1", server.takeRequest().path)
        vm.setScopeToFolder(false); vm.settle()
        assertEquals("/api/sync/v1/search?q=rep&limit=50&offset=0", server.takeRequest().path)
    }

    @Test fun loadMoreUsesOffset() {
        server.json(hits(50, 120)); server.json(hits(50, 120, offset = 50)); server.json(hits(20, 120, offset = 100))
        val vm = vm()
        vm.onQueryChange("rep"); vm.settle(); server.takeRequest()
        vm.loadMore(); vm.settle()
        assertEquals("/api/sync/v1/search?q=rep&limit=50&offset=50", server.takeRequest().path)
        vm.loadMore(); vm.settle()
        assertEquals(120, vm.state.value.hits.size)
        server.takeRequest()
        vm.loadMore(); vm.settle()
        assertEquals(3, server.requestCount)
    }

    @Test fun blankQueryClearsWithoutRequest() {
        server.json(hits(1, 1))
        val vm = vm()
        vm.onQueryChange("rep"); vm.settle()
        vm.onQueryChange("  ")
        assertTrue(vm.state.value.hits.isEmpty())
        assertEquals(1, server.requestCount)
    }

    @Test fun offlineErrorIsKept() {
        server.shutdown()
        val vm = vm()
        vm.onQueryChange("rep")
        val s = runBlocking { withTimeout(5_000) { vm.state.first { it.error != null } } }
        assertTrue(s.error is SyncError.Transport)
    }
}
