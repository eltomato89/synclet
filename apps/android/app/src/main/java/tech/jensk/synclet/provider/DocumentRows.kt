package tech.jensk.synclet.provider

import android.provider.DocumentsContract.Document
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.layout.SpaceLayout

/** Flags and MIME type of a provider row, from the server's capabilities and the space layout. */
object DocumentRows {
    fun flags(item: SyncItem, layout: SpaceLayout): Int {
        val caps = item.capabilities
        var flags = 0
        if (item.isFolder) {
            if (layout.canCreateIn(item)) flags = flags or Document.FLAG_DIR_SUPPORTS_CREATE
        } else {
            if (caps.write) flags = flags or Document.FLAG_SUPPORTS_WRITE
            if (item.hasThumbnail) flags = flags or Document.FLAG_SUPPORTS_THUMBNAIL
        }
        if (caps.delete) flags = flags or Document.FLAG_SUPPORTS_DELETE
        if (caps.rename) flags = flags or Document.FLAG_SUPPORTS_RENAME
        if (caps.move) flags = flags or Document.FLAG_SUPPORTS_MOVE
        return flags
    }

    fun mime(item: SyncItem, fromExtension: (String) -> String?): String {
        if (item.isFolder) return Document.MIME_TYPE_DIR
        val ext = item.name.substringAfterLast('.', "").lowercase()
        return ext.takeIf { it.isNotEmpty() }?.let(fromExtension) ?: item.mime ?: "application/octet-stream"
    }
}
