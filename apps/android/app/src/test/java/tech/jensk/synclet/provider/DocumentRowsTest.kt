package tech.jensk.synclet.provider

import android.provider.DocumentsContract.Document
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.layout.SpaceLayout
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem

class DocumentRowsTest {
    private val layout = SpaceLayout(listOf(
        SyncSpace("personal", "personal", "Meine Dateien", "root", true),
        SyncSpace(NAS_ID, "external", "NAS", "r_$NAS_ID", true, "missing"),
    ))
    private val mimes = mapOf("txt" to "text/plain", "pdf" to "application/pdf")

    @Test fun readOnlyFileHasNoWriteFlags() {
        val flags = DocumentRows.flags(fileItem(F1, "a.txt", canWrite = false), layout)
        for (f in listOf(Document.FLAG_SUPPORTS_WRITE, Document.FLAG_SUPPORTS_DELETE, Document.FLAG_SUPPORTS_RENAME, Document.FLAG_SUPPORTS_MOVE))
            assertEquals(0, flags and f)
    }

    @Test fun writableFileHasWriteFlags() {
        val flags = DocumentRows.flags(fileItem(F1, "a.txt"), layout)
        for (f in listOf(Document.FLAG_SUPPORTS_WRITE, Document.FLAG_SUPPORTS_DELETE, Document.FLAG_SUPPORTS_RENAME, Document.FLAG_SUPPORTS_MOVE))
            assertTrue(flags and f != 0)
        assertEquals(0, flags and Document.FLAG_SUPPORTS_THUMBNAIL)
    }

    @Test fun fileWithThumbnailSupportsThumbnail() {
        assertTrue(DocumentRows.flags(fileItem(F1, "a.jpg", thumbnail = true), layout) and Document.FLAG_SUPPORTS_THUMBNAIL != 0)
    }

    @Test fun folderInWritableSpaceSupportsCreate() {
        val flags = DocumentRows.flags(folderItem(D1, "Docs"), layout)
        assertTrue(flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0)
        assertEquals(0, flags and Document.FLAG_SUPPORTS_WRITE)
    }

    @Test fun folderInMissingSpaceDoesNotSupportCreate() {
        assertEquals(0, DocumentRows.flags(folderItem(D1, "Docs", parentId = "r_$NAS_ID", spaceId = NAS_ID), layout) and Document.FLAG_DIR_SUPPORTS_CREATE)
    }

    @Test fun mimeFromExtensionElseServerElseOctetStream() {
        assertEquals("application/pdf", DocumentRows.mime(fileItem(F1, "Report.PDF"), mimes::get))
        assertEquals("text/plain", DocumentRows.mime(fileItem(F1, "noext"), mimes::get))          // server mime of the fixture
        assertEquals("application/octet-stream", DocumentRows.mime(fileItem(F1, "x.zzz").copy(mime = null), mimes::get))
        assertEquals(Document.MIME_TYPE_DIR, DocumentRows.mime(folderItem(D1, "Docs.txt"), mimes::get))
    }
}
