package tech.jensk.synclet.ui.preview

import android.content.Context
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaStoreSaverTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun savesIntoDownloadsAndClearsPending() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val src = tmp.newFile("src.txt").apply { writeText("hello") }
        val uri = MediaStoreSaver.saveToDownloads(context, src, "a.txt", "text/plain")
        assertTrue(uri.toString().startsWith(MediaStore.Downloads.EXTERNAL_CONTENT_URI.toString()))
        assertEquals("hello", context.contentResolver.openInputStream(uri)!!.use { it.readBytes().decodeToString() })
        context.contentResolver.query(uri, arrayOf(MediaStore.Downloads.IS_PENDING), null, null, null)!!.use {
            assertTrue(it.moveToFirst()); assertEquals(0, it.getInt(0))
        }
    }
}
