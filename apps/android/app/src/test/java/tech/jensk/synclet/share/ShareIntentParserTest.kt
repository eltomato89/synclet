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
    private val a = Uri.parse("content://media.provider/a")
    private val b = Uri.parse("content://media.provider/b")

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

    @Test fun fileSchemeIsDropped() {
        val i = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/data/tech.jensk.synclet/files/accounts.json"))
        assertEquals(SharePayload.Empty, ShareIntentParser.parse(i))
    }

    @Test fun ownAuthorityIsDropped() {
        val own = Uri.parse("content://tech.jensk.synclet.documents/document/x")
        val i = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(own, a))
        assertEquals(SharePayload.Files(listOf(a)), ShareIntentParser.parse(i))
        val clip = Intent(Intent.ACTION_SEND).apply { clipData = ClipData.newRawUri("x", own) }
        assertEquals(SharePayload.Empty, ShareIntentParser.parse(clip))
    }

    @Test fun otherActionsAreEmpty() {
        val i = Intent(Intent.ACTION_VIEW).putExtra(Intent.EXTRA_STREAM, a).putExtra(Intent.EXTRA_TEXT, "t")
        assertEquals(SharePayload.Empty, ShareIntentParser.parse(i))
    }
}
