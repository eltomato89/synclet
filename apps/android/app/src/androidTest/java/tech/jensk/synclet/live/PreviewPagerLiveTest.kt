package tech.jensk.synclet.live

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.TouchInjectionScope
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import tech.jensk.synclet.MainActivity
import tech.jensk.synclet.ui.TestTags

/** Preview pager gestures on a device (Task 13): swipe at 1x pages; zoomed (double tap or pinch) a swipe pans instead. */
@RunWith(AndroidJUnit4::class)
class PreviewPagerLiveTest {
    val rule = createEmptyComposeRule()
    @get:Rule val rules: TestRule = RuleChain.outerRule(GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)).around(rule)

    private fun waitTag(tag: String) = rule.waitUntil(30_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun waitTitle(name: String) = rule.waitUntil(30_000) { rule.onAllNodesWithText(name).fetchSemanticsNodes().isNotEmpty() }
    private fun shows(name: String) = rule.onAllNodesWithText(name).fetchSemanticsNodes().isNotEmpty()

    // Away from the screen edges, so the system back gesture never sees the swipe.
    private fun TouchInjectionScope.pageSwipeLeft() = swipeLeft(startX = left + width * 0.8f, endX = left + width * 0.2f)
    private fun TouchInjectionScope.pageSwipeRight() = swipeRight(startX = left + width * 0.2f, endX = left + width * 0.8f)

    @Test fun swipeAtOneXPagesAndZoomedSwipePans() = runBlocking<Unit> {
        val session = LiveTestSupport.signIn()
        val folder = LiveTestSupport.scratchFolder(session, "pager")
        try {
            for ((name, color) in listOf("a.png" to Color.RED, "b.png" to Color.BLUE)) {
                val file = File(LiveTestSupport.context.cacheDir, "pager-$name")
                file.outputStream().use { Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
                session.api.uploadNew(folder.id, name, file)
                file.delete()
            }
            ActivityScenario.launch(MainActivity::class.java)
            waitTag(TestTags.space("personal")); rule.onNodeWithTag(TestTags.space("personal")).performClick()
            waitTag(TestTags.item(folder.name)); rule.onNodeWithTag(TestTags.item(folder.name)).performClick()
            waitTag(TestTags.item("a.png")); rule.onNodeWithTag(TestTags.item("a.png")).performClick()
            waitTitle("a.png")

            // 1x: a swipe pages, both ways.
            rule.onRoot().performTouchInput { pageSwipeLeft() }
            waitTitle("b.png")
            rule.onRoot().performTouchInput { pageSwipeRight() }
            waitTitle("a.png")

            // Double tap zooms to 2.5x: the swipe pans the image, the pager stays.
            rule.onRoot().performTouchInput { doubleClick(center) }
            rule.waitForIdle()
            rule.onRoot().performTouchInput { pageSwipeLeft() }
            rule.waitForIdle()
            assertTrue("zoomed swipe must not page", shows("a.png") && !shows("b.png"))
            rule.onRoot().performTouchInput { doubleClick(center) }           // back to 1x
            rule.waitForIdle()

            // Pinch zoom, then swipe: still the same page.
            rule.onRoot().performTouchInput {
                pinch(center - Offset(20f, 0f), center - Offset(width * 0.35f, 0f), center + Offset(20f, 0f), center + Offset(width * 0.35f, 0f))
            }
            rule.waitForIdle()
            rule.onRoot().performTouchInput { pageSwipeLeft() }
            rule.waitForIdle()
            assertTrue("pinch-zoomed swipe must not page", shows("a.png") && !shows("b.png"))

            // Reset (double tap at >1x) and the pager swipes again.
            rule.onRoot().performTouchInput { doubleClick(center) }
            rule.waitForIdle()
            rule.onRoot().performTouchInput { pageSwipeLeft() }
            waitTitle("b.png")
        } finally {
            runCatching { session.api.deleteItem(folder.id) }
        }
    }
}
