package tech.jensk.synclet.live

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import tech.jensk.synclet.MainActivity
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.ViewMode
import tech.jensk.synclet.login.DebugLoginActivity
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.ui.TestTags

/**
 * Google Play screenshots with the website's sample data (scripts/android-store-screenshots.sh): one PNG per
 * scene into the app's external files folder `store-shots/`, which the script pulls. Grid layout, the
 * account shown as alex@files.example.com. Skipped unless the instrumentation argument storeShots=1 is set.
 */
@RunWith(AndroidJUnit4::class)
class StoreScreenshotsTest {
    val rule = createEmptyComposeRule()
    @get:Rule val rules: TestRule = RuleChain.outerRule(GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)).around(rule)

    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private fun present(tag: String) = rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun waitTag(tag: String, timeoutMs: Long = 30_000) = rule.waitUntil(timeoutMs) { present(tag) }
    private fun tap(tag: String) { waitTag(tag); rule.onNodeWithTag(tag).performClick() }

    private lateinit var dir: File
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    /** The screen as it is (status bar included), after [settle] ms for thumbnails and animations. */
    private fun shot(name: String, settle: Long = 2_500) {
        rule.waitForIdle()
        Thread.sleep(settle)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /**
     * The app started afresh (it opens on the list of spaces), then the space [spaceId]. Back navigation
     * differs between phone and tablet; a new task always starts at the same place.
     */
    private fun openSpace(spaceId: String, expect: String) {
        ActivityScenario.launch<Activity>(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        tap(TestTags.space(spaceId))
        // The grid composes only what is on screen: scroll [expect] into view first.
        rule.waitUntil(30_000) { rule.onAllNodes(anyItem).fetchSemanticsNodes().isNotEmpty() }
        if (!present(TestTags.item(expect))) rule.onNode(hasScrollToNodeAction()).performScrollToNode(hasTestTag(TestTags.item(expect)))
        waitTag(TestTags.item(expect))
    }

    private val anyItem = SemanticsMatcher("a browser item") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(TestTags.item("")) == true }

    /** Back only while the soft keyboard shows (an emulator with a hardware keyboard shows none). */
    private fun hideKeyboard() {
        if (device.executeShellCommand("dumpsys input_method").contains("mInputShown=true")) device.pressBack()
    }

    @Test fun storeScreenshots() = runBlocking<Unit> {
        assumeTrue("only for scripts/android-store-screenshots.sh", InstrumentationRegistry.getArguments().getString("storeShots") == "1")
        LiveTestSupport.requireServer()
        dir = File(context.getExternalFilesDir(null), "store-shots").apply { deleteRecursively(); mkdirs() }
        val graph = LiveTestSupport.graph
        graph.awaitReady()
        graph.settings.setViewMode(ViewMode.GRID)
        Account.displayHostOverride = "files.example.com"

        ActivityScenario.launch<Activity>(Intent(context, DebugLoginActivity::class.java)
            .putExtra("server", LiveTestSupport.server).putExtra("token", LiveTestSupport.token)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        LiveTestSupport.waitUntil { graph.accounts.accounts.value.any { !it.needsSignIn } }
        val key = graph.accounts.accounts.value.first { !it.needsSignIn }.key
        val family = graph.accounts.refreshAccount(key)!!.spaces.first { it.name == "Family" }

        // 1. My Files
        openSpace("personal", "Photos")
        shot("01-files", settle = 4_000)

        // 2. Photos
        tap(TestTags.item("Photos"))
        waitTag(TestTags.item("Fjord morning.jpg"))
        shot("02-photos", settle = 4_000)

        // 3. Preview of a photo
        tap(TestTags.item("Fjord morning.jpg"))
        shot("03-preview", settle = 6_000)

        // 4. The team folder "Family"
        openSpace(family.id, "Holidays 2026")
        shot("04-spaces", settle = 3_000)

        // 5. Search (names and contents)
        tap(TestTags.NAV_SEARCH)
        waitTag(TestTags.SEARCH_FIELD)
        rule.onNodeWithTag(TestTags.SEARCH_FIELD).performTextInput("fjord")
        waitTag(TestTags.searchHit("Fjord morning.jpg"), 45_000)
        hideKeyboard()
        waitTag(TestTags.searchHit("Fjord morning.jpg"))
        shot("05-search", settle = 3_000)

        // 6. Share link for a document (the sheet before the link is created)
        openSpace("personal", "Itinerary.pdf")
        tap(TestTags.itemMenu("Itinerary.pdf"))
        tap(TestTags.SHARE_LINK)
        waitTag(TestTags.SHARE_CREATE)
        shot("06-share", settle = 2_000)

        // 7. Add an account: the address of your own server
        ActivityScenario.launch<Activity>(Intent(context, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitTag(TestTags.LOGIN_SERVER)
        rule.onNodeWithTag(TestTags.LOGIN_SERVER).performTextInput("files.example.com")
        shot("07-server", settle = 2_000)
    }
}
