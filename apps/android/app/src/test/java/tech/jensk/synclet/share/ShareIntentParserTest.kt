package tech.jensk.synclet.share

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ShareIntentParserTest {
    private val a = Uri.parse("content://x/a")
    private val b = Uri.parse("content://x/b")

    @Test fun sendWithStream() {
        val i = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, a)
        assertEquals(SharePayload.Files(listOf(a)), ShareIntentParser.parse(i))
    }

    @Test fun sendMultiple() {
        val i = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(a, b))
        assertEquals(SharePayload.Files(listOf(a, b)), ShareIntentParser.parse(i))
    }

    @Test fun sendWithClipDataOnly() {
        val i = Intent(Intent.ACTION_SEND).apply { clipData = ClipData.newRawUri("x", a) }
        assertEquals(SharePayload.Files(listOf(a)), ShareIntentParser.parse(i))
    }

    @Test fun sendText() {
        val i = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "hello").putExtra(Intent.EXTRA_SUBJECT, "Note")
        assertEquals(SharePayload.Text("hello", "Note"), ShareIntentParser.parse(i))
    }

    @Test fun emptyIntent() {
        assertEquals(SharePayload.Empty, ShareIntentParser.parse(Intent()))
    }
}
