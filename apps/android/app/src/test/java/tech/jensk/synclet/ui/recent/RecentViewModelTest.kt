package tech.jensk.synclet.ui.recent

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.F2
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

class RecentViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private fun RecentViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.loading } } }

    @Test fun loadsAndRefreshes() {
        server.json("[${itemJson(fileItem(F1, "a.txt"))}]")
        server.json("[${itemJson(fileItem(F1, "a.txt"))},${itemJson(fileItem(F2, "b.txt"))}]")
        val vm = RecentViewModel(AccountSession("org", server.api(), AccountTokens("org", "t") { _, _ -> }) { null })
        assertEquals(listOf("a.txt"), vm.settle().items.map { it.name })
        assertEquals("/api/sync/v1/recent?limit=100", server.takeRequest().path)
        vm.refresh()
        assertEquals(listOf("a.txt", "b.txt"), vm.settle().items.map { it.name })
        assertEquals(2, server.requestCount)
    }
}
