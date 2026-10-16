package tech.jensk.synclet.ui.components

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.layout.SpaceLayout
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.D2
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.error
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

class FolderPickerViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer

    private val personal = SyncSpace("personal", "personal", "x", "root", canWrite = true)
    private val team = SyncSpace("t1", "shared", "Team", "r_t1", canWrite = true)
    private val gone = SyncSpace("e1", "external", "NAS", "r_e1", canWrite = false, status = "missing")
    private val layout = SpaceLayout(listOf(personal, team, gone))

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private fun vm(exclude: Set<String> = emptySet()) = FolderPickerViewModel(server.api(), layout, "My Files", exclude)
    private fun FolderPickerViewModel.settle() =
        runBlocking { withTimeout(5_000) { state.first { !it.loading } } }

    private fun page(vararg items: tech.jensk.synclet.core.api.SyncItem) =
        """{"items":[${items.joinToString(",") { itemJson(it) }}],"cursor":"1"}"""

    @Test fun startsWithSpaces() {
        val vm = vm()
        val s = vm.state.value
        assertEquals(listOf("My Files", "Team", "NAS"), s.entries.map { it.name })
        assertEquals(listOf(true, true, false), s.entries.map { it.enabled })
        assertFalse(vm.canPickHere)
    }

    @Test fun openSpaceListsOnlyFolders() {
        server.json(itemJson(folderItem("root", "root", parentId = null)))
        server.json(page(folderItem(D1, "Docs"), fileItem(F1, "a.txt")))
        val vm = vm()
        vm.openSpace(personal); vm.settle()
        val s = vm.state.value
        assertEquals(listOf("Docs"), s.entries.map { it.name })
        assertEquals(listOf("", "My Files"), s.path.map { it.name })
        assertTrue(vm.canPickHere)
        assertEquals("/api/sync/v1/items/root", server.takeRequest().path!!.substringBefore('?'))
        assertTrue(server.takeRequest().path!!.startsWith("/api/sync/v1/items/root/children"))
    }

    @Test fun excludedFoldersAreHiddenAndUp() {
        server.json(itemJson(folderItem("root", "root", parentId = null)))
        server.json(page(folderItem(D1, "Moving"), folderItem(D2, "Other")))
        val vm = vm(setOf(D1))
        vm.openSpace(personal); vm.settle()
        assertEquals(listOf("Other"), vm.state.value.entries.map { it.name })
        vm.up()
        assertEquals(3, vm.state.value.entries.size)
        assertNull(vm.state.value.current.folder)
    }

    @Test fun errorThenRetry() {
        server.json(itemJson(folderItem("root", "root", parentId = null)))
        server.error(500, null)
        val vm = vm()
        vm.openSpace(personal); vm.settle()
        assertNotNull(vm.state.value.error)
        server.json(page(folderItem(D1, "Docs")))
        vm.retry(); vm.settle()
        assertNull(vm.state.value.error)
        assertEquals(listOf("Docs"), vm.state.value.entries.map { it.name })
    }

    @Test fun retryAfterSpaceFailureRetriesTheSpace() {
        server.error(500, null)
        val vm = vm()
        vm.openSpace(personal); vm.settle()
        assertNotNull(vm.state.value.error)
        server.json(itemJson(folderItem("root", "root", parentId = null)))
        server.json(page(folderItem(D1, "Docs")))
        vm.retry(); vm.settle()
        assertNull(vm.state.value.error)
        assertEquals(listOf("Docs"), vm.state.value.entries.map { it.name })
        assertEquals(listOf("", "My Files"), vm.state.value.path.map { it.name })
    }

    @Test fun slowEarlierNavigationDoesNotOverwriteLaterOne() {
        val slow = folderItem(D1, "Slow")
        val fast = folderItem(D2, "Fast")
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): okhttp3.mockwebserver.MockResponse {
                val path = request.path!!
                val body = when {
                    path.startsWith("/api/sync/v1/items/root/children") -> page(slow, fast)
                    path.startsWith("/api/sync/v1/items/root") -> itemJson(folderItem("root", "root", parentId = null))
                    path.startsWith("/api/sync/v1/items/$D1/children") -> page(folderItem("d_55555555-5555-5555-5555-555555555555", "FromSlow"))
                    path.startsWith("/api/sync/v1/items/$D2/children") -> page(folderItem("d_66666666-6666-6666-6666-666666666666", "FromFast"))
                    else -> "{}"
                }
                val r = okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                if (path.contains("/$D1/")) r.setHeadersDelay(600, java.util.concurrent.TimeUnit.MILLISECONDS)
                return r
            }
        }
        val vm = vm()
        vm.openSpace(personal); vm.settle()
        vm.openFolder(slow)
        vm.openFolder(fast); vm.settle()
        Thread.sleep(900)
        assertEquals(listOf("FromFast"), vm.state.value.entries.map { it.name })
        assertEquals("Fast", vm.state.value.current.name)
    }
}
