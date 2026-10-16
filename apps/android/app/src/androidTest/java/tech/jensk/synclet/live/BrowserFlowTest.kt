package tech.jensk.synclet.live

import android.Manifest
import android.app.Activity
import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import tech.jensk.synclet.login.DebugLoginActivity
import tech.jensk.synclet.ui.TestTags

/** The Compose browser flow against the live stack, signed in through the debug-only activity. */
@RunWith(AndroidJUnit4::class)
class BrowserFlowTest {
    val rule = createEmptyComposeRule()
    // The app asks for POST_NOTIFICATIONS on start (API 33+); the system dialog would cover the UI.
    @get:Rule val rules: TestRule = RuleChain.outerRule(GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)).around(rule)

    private fun waitTag(tag: String) = rule.waitUntil(30_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun signInThroughDebugActivity(): String {
        LiveTestSupport.requireServer()
        ActivityScenario.launch<Activity>(Intent(LiveTestSupport.context, DebugLoginActivity::class.java)
            .putExtra("server", LiveTestSupport.server).putExtra("token", LiveTestSupport.token)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        LiveTestSupport.waitUntil { LiveTestSupport.graph.accounts.accounts.value.any { !it.needsSignIn } }
        return LiveTestSupport.graph.accounts.accounts.value.first { !it.needsSignIn }.key
    }

    /** False while another activity (the system share sheet) covers ours. */
    private fun composeInFront() = runCatching { rule.onAllNodesWithTag(TestTags.NAV_FILES).fetchSemanticsNodes() }.isSuccess

    private fun present(tag: String) = rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    /**
     * Files tab, then wherever it comes back (the folder itself, the space list or the space root) on to the folder,
     * until [expect]'s menu is on screen. Search hits use the same row (and tag), so the Files tab always comes first.
     */
    private fun showFolder(spaceId: String, folderName: String, expect: String) {
        rule.onNodeWithTag(TestTags.NAV_FILES).performClick()
        rule.waitUntil(30_000) { present(TestTags.itemMenu(expect)) || present(TestTags.item(folderName)) || present(TestTags.space(spaceId)) }
        if (!present(TestTags.itemMenu(expect))) {
            if (!present(TestTags.item(folderName))) rule.onNodeWithTag(TestTags.space(spaceId)).performClick()
            waitTag(TestTags.item(folderName)); rule.onNodeWithTag(TestTags.item(folderName)).performClick()
        }
        waitTag(TestTags.itemMenu(expect))
    }

    @Test fun folderUploadRenameDeleteRestoreSearchShare() = runBlocking<Unit> {
        val key = signInThroughDebugActivity()
        val graph = LiveTestSupport.graph
        val session = graph.session(key)!!
        val folderName = "UITest-${UUID.randomUUID().toString().take(6)}"
        var folderId: String? = null
        val source = LiveTestSupport.mediaStoreFile("hello-${UUID.randomUUID().toString().take(6)}.txt", "text/plain", "hello android".toByteArray())
        try {
            waitTag(TestTags.space("personal")); rule.onNodeWithTag(TestTags.space("personal")).performClick()
            waitTag(TestTags.ADD_MENU); rule.onNodeWithTag(TestTags.ADD_MENU).performClick()
            waitTag(TestTags.NEW_FOLDER); rule.onNodeWithTag(TestTags.NEW_FOLDER).performClick()
            waitTag(TestTags.NAME_FIELD); rule.onNodeWithTag(TestTags.NAME_FIELD).performTextInput(folderName)
            rule.onNodeWithTag(TestTags.CONFIRM).performClick()
            waitTag(TestTags.item(folderName)); rule.onNodeWithTag(TestTags.item(folderName)).performClick()

            // Upload: the system pickers cannot be driven reliably – enqueue a file through the same path the "+" menu uses.
            folderId = session.api.allChildren("root").first { it.name == folderName }.id
            val uploadName = graph.uploadQueue.let { q ->
                graph.enqueueUploads(key, folderId, folderName, listOf(source))
                q.entries.value.last { it.parentId == folderId }.name
            }
            waitTag(TestTags.item(uploadName))

            rule.onNodeWithTag(TestTags.item(uploadName)).performClick()               // open (text preview)
            rule.waitUntil(30_000) { rule.onAllNodesWithText("hello android").fetchSemanticsNodes().isNotEmpty() }
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
            showFolder("personal", folderName, uploadName)

            rule.onNodeWithTag(TestTags.itemMenu(uploadName)).performClick()
            waitTag(TestTags.RENAME); rule.onNodeWithTag(TestTags.RENAME).performClick()
            waitTag(TestTags.NAME_FIELD); rule.onNodeWithTag(TestTags.NAME_FIELD).performTextReplacement("renamed.txt")
            rule.onNodeWithTag(TestTags.CONFIRM).performClick()
            waitTag(TestTags.item("renamed.txt"))

            rule.onNodeWithTag(TestTags.itemMenu("renamed.txt")).performClick()
            waitTag(TestTags.DELETE); rule.onNodeWithTag(TestTags.DELETE).performClick()
            waitTag(TestTags.CONFIRM); rule.onNodeWithTag(TestTags.CONFIRM).performClick()
            rule.waitUntil(30_000) { rule.onAllNodesWithTag(TestTags.item("renamed.txt")).fetchSemanticsNodes().isEmpty() }

            rule.onNodeWithTag(TestTags.NAV_MORE).performClick()
            waitTag(TestTags.MORE_TRASH); rule.onNodeWithTag(TestTags.MORE_TRASH).performClick()
            waitTag(TestTags.trashRestore("renamed.txt")); rule.onNodeWithTag(TestTags.trashRestore("renamed.txt")).performClick()
            LiveTestSupport.waitUntil { runBlocking { session.api.allChildren(folderId).any { it.name == "renamed.txt" } } }

            rule.onNodeWithTag(TestTags.NAV_SEARCH).performClick()
            waitTag(TestTags.SEARCH_FIELD); rule.onNodeWithTag(TestTags.SEARCH_FIELD).performTextInput("renamed")
            waitTag(TestTags.searchHit("renamed.txt"))

            showFolder("personal", folderName, "renamed.txt")
            rule.onNodeWithTag(TestTags.itemMenu("renamed.txt")).performClick()
            waitTag(TestTags.SHARE_LINK); rule.onNodeWithTag(TestTags.SHARE_LINK).performClick()
            waitTag(TestTags.SHARE_CREATE)
            rule.waitUntil(30_000) { rule.onNodeWithTag(TestTags.SHARE_CREATE).fetchSemanticsNode().config.contains(SemanticsProperties.Disabled).not() }
            // Creating the link opens the system share sheet on top: our activity pauses (no resumed Compose
            // hierarchy). Close the sheet with Back until the app is in front again, then read the URL.
            val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
            rule.onNodeWithTag(TestTags.SHARE_CREATE).performClick()
            LiveTestSupport.waitUntil { !composeInFront() }
            for (attempt in 1..3) {                                          // Back only while covered, never on our sheet
                device.pressBack()
                if (runCatching { LiveTestSupport.waitUntil(10_000) { composeInFront() } }.isSuccess) break
            }
            waitTag(TestTags.SHARE_URL)
            val url = rule.onNodeWithTag(TestTags.SHARE_URL).fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("")
            assertTrue(url, url.startsWith(LiveTestSupport.server!!) && url.contains("/s/"))    // relative URL resolved against the server
        } finally {
            LiveTestSupport.deleteMediaStoreFile(source)
            folderId?.let { id -> runCatching { session.api.deleteItem(id) } }
        }
    }

    @Test fun uploadIntoTeamFolder() = runBlocking<Unit> {
        LiveTestSupport.requireServer()
        val teamName = LiveTestSupport.team
        assumeTrue("no team folder (instrumentation arg syncletTeam)", teamName != null)
        val key = signInThroughDebugActivity()
        val graph = LiveTestSupport.graph
        val session = graph.session(key)!!
        val space = graph.accounts.refreshAccount(key)!!.spaces.first { it.name == teamName }
        val name = "team-${UUID.randomUUID().toString().take(6)}.txt"
        val source = LiveTestSupport.mediaStoreFile(name, "text/plain", "hello team".toByteArray())
        try {
            waitTag(TestTags.space(space.id)); rule.onNodeWithTag(TestTags.space(space.id)).performClick()
            graph.enqueueUploads(key, space.rootId, space.name, listOf(source))
            waitTag(TestTags.item(name))
        } finally {
            LiveTestSupport.deleteMediaStoreFile(source)
            runCatching { session.api.allChildren(space.rootId).filter { it.name == name }.forEach { session.api.deleteItem(it.id) } }
        }
    }
}
