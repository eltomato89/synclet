package tech.jensk.synclet.live

import android.content.ContentResolver
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Point
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.jensk.synclet.core.api.httpStatus
import tech.jensk.synclet.core.layout.DocumentIds
import tech.jensk.synclet.provider.ProviderContract

/** The DocumentsProvider through the real ContentResolver, against the live stack (Provider → queue → worker). */
@RunWith(AndroidJUnit4::class)
class ProviderLiveTest {
    private val auth = ProviderContract.AUTHORITY

    @Test fun providerRoundTrip() = runBlocking<Unit> {
        val session = LiveTestSupport.signIn()
        val key = session.key
        val folder = LiveTestSupport.scratchFolder(session, "provider")
        val cr = LiveTestSupport.context.contentResolver
        try {
            cr.query(DocumentsContract.buildRootsUri(auth), null, null, null, null)!!.use { assertTrue(column(it, Root.COLUMN_ROOT_ID).contains(key)) }
            cr.query(DocumentsContract.buildChildDocumentsUri(auth, DocumentIds.top(key)), null, null, null, null)!!.use { c ->
                val ids = column(c, Document.COLUMN_DOCUMENT_ID)
                assertTrue(ids.toString(), ids.contains("$key/root"))
            }
            LiveTestSupport.team?.let { team ->
                cr.query(DocumentsContract.buildChildDocumentsUri(auth, DocumentIds.top(key)), null, null, null, null)!!.use { c ->
                    val names = column(c, Document.COLUMN_DISPLAY_NAME)
                    assertTrue(names.toString(), names.contains(team))
                }
            }
            // The folder was made behind the provider's back: a listing other tests left in the cache may be
            // served for up to 30 s (provider freshness); after that the provider reloads and sees it.
            listUntilLoaded(cr, DocumentsContract.buildChildDocumentsUri(auth, DocumentIds.of(key, "root")), timeoutMs = 60_000) { folder.name in it }

            val parent = DocumentsContract.buildDocumentUri(auth, DocumentIds.of(key, folder.id))
            val file = DocumentsContract.createDocument(cr, parent, "text/plain", "note")!!
            val id = DocumentIds.parse(DocumentsContract.getDocumentId(file))!!.syncId
            assertEquals("note.txt", session.api.item(id).name)
            cr.openOutputStream(file, "wt")!!.use { it.write("hello android".toByteArray()) }
            LiveTestSupport.waitUntil { runBlocking { session.api.item(id).size } == 13L }    // upload-on-close via the worker
            assertEquals("hello android", cr.openInputStream(file)!!.use { it.readBytes().decodeToString() })

            val renamed = DocumentsContract.renameDocument(cr, file, "note2.txt")!!
            assertEquals("note2.txt", session.api.item(id).name)
            // As the system picker asks: the search term in queryArgs (API 29+ DocumentsProvider requires queryArgs).
            val search = Bundle().apply { putString(DocumentsContract.QUERY_ARG_DISPLAY_NAME, "note2") }
            cr.query(DocumentsContract.buildSearchDocumentsUri(auth, key, "note2"), null, search, null)!!.use {
                assertTrue(column(it, Document.COLUMN_DISPLAY_NAME).contains("note2.txt"))
            }
            assertTrue(DocumentsContract.isChildDocument(cr, parent, renamed))
            assertTrue(DocumentsContract.deleteDocument(cr, renamed))
            assertEquals(404, runCatching { session.api.item(id) }.exceptionOrNull()?.httpStatus())
        } finally {
            runCatching { session.api.deleteItem(folder.id) }
        }
    }

    @Test fun thumbnailOfAnImage() = runBlocking<Unit> {
        val session = LiveTestSupport.signIn()
        val key = session.key
        val folder = LiveTestSupport.scratchFolder(session, "thumb")
        val cr = LiveTestSupport.context.contentResolver
        try {
            val png = File(LiveTestSupport.context.cacheDir, "thumb-test.png")
            png.writeBytes(pngBytes(64, 48, Color.rgb(30, 120, 200)))
            val uploaded = session.api.uploadNew(folder.id, "pixel.png", png)
            png.delete()
            LiveTestSupport.waitUntil(60_000) { runBlocking { session.api.item(uploaded.id).preview?.thumbnail == true } }   // server worker
            val uri = DocumentsContract.buildDocumentUri(auth, DocumentIds.of(key, uploaded.id))
            val thumb = DocumentsContract.getDocumentThumbnail(cr, uri, Point(256, 256), null)
            assertNotNull(thumb)
            assertTrue(thumb!!.width > 0 && thumb.height > 0)
        } finally {
            runCatching { session.api.deleteItem(folder.id) }
        }
    }

    private fun pngBytes(w: Int, h: Int, color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun column(c: Cursor, name: String): List<String> {
        val i = c.getColumnIndexOrThrow(name)
        return generateSequence { if (c.moveToNext()) c.getString(i) else null }.toList()
    }

    /** Queries until the provider reports a finished load whose names satisfy [accept]. */
    private fun listUntilLoaded(cr: ContentResolver, uri: Uri, timeoutMs: Long = 30_000, accept: (List<String>) -> Boolean = { true }): List<String> {
        var names = emptyList<String>()
        LiveTestSupport.waitUntil(timeoutMs) {
            cr.query(uri, null, null, null, null)!!.use { c ->
                names = column(c, Document.COLUMN_DISPLAY_NAME)
                !c.extras.getBoolean(DocumentsContract.EXTRA_LOADING) && accept(names)
            }
        }
        return names
    }
}
