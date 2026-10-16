package tech.jensk.synclet.provider

import android.content.ContentResolver
import android.provider.DocumentsContract
import tech.jensk.synclet.core.layout.DocumentIds

object ProviderContract { const val AUTHORITY = "tech.jensk.synclet.documents" }

/** Tells the system file picker (and other observers of the provider) that something changed. */
interface ProviderNotifier {
    fun rootsChanged()
    fun childrenChanged(accountKey: String, folderId: String)
    fun topChanged(accountKey: String)
    fun documentChanged(accountKey: String, syncId: String)
}

class ContentResolverNotifier(private val resolver: ContentResolver) : ProviderNotifier {
    private val authority = ProviderContract.AUTHORITY
    override fun rootsChanged() = resolver.notifyChange(DocumentsContract.buildRootsUri(authority), null)
    override fun childrenChanged(accountKey: String, folderId: String) =
        resolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, DocumentIds.of(accountKey, folderId)), null)
    override fun topChanged(accountKey: String) =
        resolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, DocumentIds.top(accountKey)), null)
    override fun documentChanged(accountKey: String, syncId: String) =
        resolver.notifyChange(DocumentsContract.buildDocumentUri(authority, DocumentIds.of(accountKey, syncId)), null)
}
