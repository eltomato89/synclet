package tech.jensk.synclet.ui.trash

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.error
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json
import tech.jensk.synclet.ui.components.UiMessage

class TrashViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer
    private val published = mutableListOf<FolderChange>()

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private val account = Account(
        key = "org", serverUrl = "http://localhost", userId = "u", username = "u", displayName = "U",
        spaces = listOf(
            SyncSpace("personal", "personal", "x", "root", canWrite = true),
            SyncSpace("s1", "shared", "Team", "r_s1", canWrite = true),
            SyncSpace("s2", "shared", "Other", "r_s2", canWrite = true),
        ))

    private fun vm() = TrashViewModel(AccountSession("org", server.api(), AccountTokens("org", "t") { _, _ -> }) { account }) { published += it }
    private fun TrashViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.loading } } }

    private fun TrashViewModel.await(cond: (TrashViewModel.State) -> Boolean) = runBlocking { withTimeout(5_000) { state.first(cond) } }

    private fun entry(id: String, name: String, space: String?) =
        """{"id":"$id","itemId":"i_$id","type":"file","name":"$name","originalPath":"Docs/$name","deletedAt":"2026-10-15T10:00:00Z"${
            space?.let { ""","spaceId":"$it"""" } ?: ""}}"""

    @Test fun listsEntriesGroupedBySpace() {
        server.json("[${entry("t1", "b.txt", "s2")},${entry("t2", "a.txt", null)},${entry("t3", "c.txt", "s1")},${entry("t4", "z.txt", "gone")}]")
        val s = vm().settle()
        assertEquals(listOf("personal", "s1", "s2", null), s.groups.map { it.first?.id })
        assertEquals(listOf("a.txt"), s.groups[0].second.map { it.name })
        assertEquals(listOf("z.txt"), s.groups[3].second.map { it.name })
    }

    @Test fun restoreRemovesTheEntryAndPublishes() {
        server.json("[${entry("t1", "a.txt", null)}]")
        server.json("""{"item":${itemJson(fileItem(F1, "a (1).txt"))},"restoredTo":"Docs/a.txt","renamed":true}""")
        val vm = vm(); val e = vm.settle().entries.single()
        vm.restore(e)
        vm.await { it.message != null }
        server.takeRequest()
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/api/trash/t1/restore", req.path)
        assertTrue(vm.state.value.entries.isEmpty())
        assertEquals(UiMessage.Text(R.string.trash_restored_renamed, listOf("a (1).txt")), vm.state.value.message)
        assertTrue(FolderChange.Everything("org") in published)
    }

    @Test fun restoreConflictShowsTheServerText() {
        server.json("[${entry("t1", "a.txt", null)}]")
        server.error(409, "conflict", "Entry is being processed")
        val vm = vm(); val e = vm.settle().entries.single()
        vm.restore(e)
        vm.await { it.message != null }
        val m = vm.state.value.message as UiMessage.Error
        assertEquals("Entry is being processed", (m.error as SyncError.Http).serverMessage)
        assertEquals(1, vm.state.value.entries.size)
        assertTrue(published.isEmpty())
    }

    @Test fun emptyCallsDeletePerSpace() {
        server.json("[${entry("t1", "a.txt", null)},${entry("t2", "b.txt", "s1")},${entry("t3", "c.txt", "s1")}]")
        server.json("""{"removed":1}"""); server.json("""{"removed":2}""")
        server.json("[]")
        val vm = vm(); vm.settle()
        vm.emptyAll()
        vm.await { it.groups.isEmpty() && !it.loading }
        server.takeRequest()
        val a = server.takeRequest(); val b = server.takeRequest()
        assertEquals("DELETE", a.method)
        assertEquals("/api/trash?space=personal", a.path)
        assertEquals("/api/trash?space=s1", b.path)
        assertEquals("/api/trash", server.takeRequest().path)
        assertTrue(vm.state.value.groups.isEmpty())
        assertNull(vm.state.value.error)
    }

    @Test fun deleteForeverRemovesTheEntry() {
        server.json("[${entry("t1", "a.txt", null)}]")
        server.json("""{}""")
        val vm = vm(); val e = vm.settle().entries.single()
        vm.deleteForever(e)
        vm.await { it.entries.isEmpty() }
        server.takeRequest()
        val req = server.takeRequest()
        assertEquals("DELETE", req.method); assertEquals("/api/trash/t1", req.path)
        assertTrue(vm.state.value.entries.isEmpty())
    }

    @Test fun doubleTapRestoresOnce() {
        server.json("[${entry("t1", "a.txt", null)}]")
        server.json("""{"item":${itemJson(fileItem(F1, "a.txt"))},"restoredTo":"Docs/a.txt","renamed":false}""")
        val vm = vm(); val e = vm.settle().entries.single()
        vm.restore(e); vm.restore(e)
        vm.await { it.entries.isEmpty() }
        assertEquals(2, server.requestCount)
    }
}
