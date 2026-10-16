package tech.jensk.synclet.share

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountTokens
import tech.jensk.synclet.core.account.ShareTarget
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

class ShareViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer
    private val key = "org:user"
    private val account = Account(key = key, serverUrl = "https://s", userId = "u", username = "u", displayName = "U")

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private fun session() = AccountSession(key, server.api(), AccountTokens(key, "syd_test") { _, _ -> }) { account }

    private fun vm(
        accounts: List<Account> = listOf(account), last: ShareTarget? = null,
        upload: suspend (ShareTarget) -> Int = { 1 }, remember: suspend (ShareTarget) -> Unit = { },
    ) = ShareViewModel(accounts, key.takeIf { accounts.isNotEmpty() }, last, { if (it == key) session() else null }, "My Files", upload, remember)

    private fun ShareViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.checking } } }

    @Test fun lastTargetIsPreselectedWhenItStillExists() {
        server.json(itemJson(folderItem(D1, "Docs")))
        val last = ShareTarget(key, D1, "Docs")
        assertEquals(last, vm(last = last).settle().target)
    }

    @Test fun deletedLastFolderFallsBackToMyFiles() {
        server.enqueue(MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
            .setBody("""{"statusCode":404,"message":"x","code":"not_found"}"""))
        assertEquals(ShareTarget(key, "root", "My Files"), vm(last = ShareTarget(key, D1, "Docs")).settle().target)
    }

    @Test fun uploadEnqueuesAndRemembersTheTarget() = runBlocking {
        val uploaded = mutableListOf<ShareTarget>(); val remembered = mutableListOf<ShareTarget>()
        val vm = vm(upload = { uploaded += it; 3 }, remember = { remembered += it })
        val target = vm.settle().target!!
        vm.upload().join()
        assertEquals(listOf(target), uploaded)
        assertEquals(listOf(target), remembered)
        assertEquals(3, vm.state.value.done)
    }

    @Test fun noAccountShowsSignInHint() {
        val vm = vm(accounts = emptyList())
        assertTrue(vm.state.value.needsAccount)
    }
}
