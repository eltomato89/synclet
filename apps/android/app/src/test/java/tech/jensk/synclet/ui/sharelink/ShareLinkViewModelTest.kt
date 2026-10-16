package tech.jensk.synclet.ui.sharelink

import java.time.Instant
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.MainDispatcherRule
import tech.jensk.synclet.testing.api
import tech.jensk.synclet.testing.error
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.json

class ShareLinkViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer().apply { start() } }
    @After fun tearDown() { server.shutdown() }

    private val now = { Instant.parse("2026-10-16T10:00:00Z") }
    private fun vm(item: tech.jensk.synclet.core.api.SyncItem = fileItem(F1, "a.txt")): ShareLinkViewModel {
        val api = server.api()
        return ShareLinkViewModel(api, api.origin, item, now)
    }
    private fun ShareLinkViewModel.settle() = runBlocking { withTimeout(5_000) { state.first { !it.loading && !it.busy } } }

    private fun ShareLinkViewModel.settleAfterSave() = runBlocking { withTimeout(5_000) { state.first { it.shareEvent > 0 } } }

    private fun link(
        id: String, createdAt: String = "2026-10-10T08:00:00Z", url: String = "/s/$id", password: Boolean = false,
        expiresAt: String? = null, trashed: Boolean = false, download: Boolean = true, upload: Boolean = false,
    ) = """{"id":"$id","itemId":"$F1","itemName":"a.txt","itemType":"file","url":"$url","hasPassword":$password,${
        expiresAt?.let { """"expiresAt":"$it",""" } ?: ""}"allowDownload":$download,"allowUpload":$upload,"createdAt":"$createdAt","itemTrashed":$trashed}"""

    @Test fun adoptsTheNewestActiveLink() {
        server.json("[${link("old", expiresAt = "2026-10-01T00:00:00Z", createdAt = "2026-10-12T00:00:00Z")}," +
            "${link("trashed", trashed = true, createdAt = "2026-10-14T00:00:00Z")}," +
            "${link("live", password = true, expiresAt = "2026-10-30T00:00:00Z", download = false)}]")
        val s = vm().settle()
        assertEquals("live", s.active?.id)
        assertEquals(ShareLinkViewModel.Form(usePassword = true, expiresAt = Instant.parse("2026-10-30T00:00:00Z"), allowDownload = false), s.form)
    }

    @Test fun createSendsOnlyWhatIsSet() {
        server.json("[]")
        server.json(link("n"))
        val vm = vm(); vm.settle()
        vm.edit { it.copy(usePassword = true, password = "pw", expiresAt = Instant.parse("2026-10-20T00:00:00Z"), allowUpload = true) }
        vm.save()
        vm.settleAfterSave()
        server.takeRequest()
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/api/shares", req.path)
        assertEquals("""{"itemId":"$F1","password":"pw","expiresAt":"2026-10-20T00:00:00Z","allowDownload":true,"allowUpload":false}""",
            req.body.readUtf8())
        assertEquals(1, vm.state.value.shareEvent)
    }

    @Test fun folderMayAllowUpload() {
        server.json("[]"); server.json(link("n"))
        val vm = vm(folderItem(D1, "Docs")); vm.settle()
        vm.edit { it.copy(allowUpload = true) }
        vm.save()
        vm.settleAfterSave()
        server.takeRequest()
        assertEquals("""{"itemId":"$D1","allowDownload":true,"allowUpload":true}""", server.takeRequest().body.readUtf8())
    }

    @Test fun updateSendsOnlyChanges() {
        server.json("[${link("l1", password = true)}]")
        server.json(link("l1"))
        val vm = vm(); vm.settle()
        vm.edit { it.copy(usePassword = false) }
        vm.save()
        vm.settleAfterSave()
        server.takeRequest()
        val req = server.takeRequest()
        assertEquals("PATCH", req.method); assertEquals("/api/shares/l1", req.path)
        assertEquals("""{"password":null}""", req.body.readUtf8())
    }

    @Test fun relativeUrlIsResolvedAgainstTheServer() {
        server.json("[${link("tok", url = "/s/tok")}]")
        val vm = vm()
        assertEquals("${server.url("/")}s/tok", vm.settle().url)
    }

    @Test fun absoluteUrlStaysAbsolute() {
        server.json("[${link("tok", url = "https://pub.example/s/tok")}]")
        assertEquals("https://pub.example/s/tok", vm().settle().url)
    }

    @Test fun revokeDeletesTheLink() {
        server.json("[${link("l1")}]")
        server.json("{}")
        val vm = vm(); vm.settle()
        vm.revoke()
        runBlocking { withTimeout(5_000) { vm.state.first { it.active == null } } }
        server.takeRequest()
        val req = server.takeRequest()
        assertEquals("DELETE", req.method); assertEquals("/api/shares/l1", req.path)
        assertNull(vm.state.value.active)
    }

    @Test fun readOnlySpaceRefusesWith403() {
        server.json("[]")
        server.error(403, "forbidden")
        val vm = vm(); vm.settle()
        vm.save()
        runBlocking { withTimeout(5_000) { vm.state.first { it.error != null } } }
        assertNotNull(vm.state.value.error)
        assertEquals(0, vm.state.value.shareEvent)
    }

    @Test fun shareEventCanBeConsumed() {
        server.json("[]"); server.json(link("n"))
        val vm = vm(); vm.settle()
        vm.save(); vm.settleAfterSave()
        vm.shareConsumed()
        assertEquals(0, vm.state.value.shareEvent)
    }

    @Test fun saveIsRefusedWhileTheInitialLoadFailed() {
        server.error(500, null)
        val vm = vm()
        runBlocking { withTimeout(5_000) { vm.state.first { it.error != null } } }
        vm.save()
        assertEquals(1, server.requestCount)
        server.json("[]")
        vm.reload()
        runBlocking { withTimeout(5_000) { vm.state.first { it.loaded } } }
        assertNull(vm.state.value.error)
    }
}
