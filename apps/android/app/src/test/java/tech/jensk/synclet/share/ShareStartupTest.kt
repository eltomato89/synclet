package tech.jensk.synclet.share

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShareStartupTest {
    @Test fun readyStartupShowsTheShareScreen() = runBlocking {
        assertTrue(awaitStartup { })
    }

    @Test fun failedStartupIsReportedInsteadOfThrown() = runBlocking {
        assertFalse(awaitStartup { throw IOException("accounts.json unreadable") })
    }
}
