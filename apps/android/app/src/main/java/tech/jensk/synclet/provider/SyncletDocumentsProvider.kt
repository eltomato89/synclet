package tech.jensk.synclet.provider

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import java.io.FileNotFoundException

class SyncletDocumentsProvider : DocumentsProvider() {
    override fun onCreate(): Boolean = true
    override fun queryRoots(projection: Array<out String>?): Cursor =
        MatrixCursor(projection ?: arrayOf(Root.COLUMN_ROOT_ID))
    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
        throw FileNotFoundException(documentId)
    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor =
        throw FileNotFoundException(parentDocumentId)
    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor =
        throw FileNotFoundException(documentId)
}
