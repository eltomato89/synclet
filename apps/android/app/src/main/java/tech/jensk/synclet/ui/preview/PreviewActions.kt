package tech.jensk.synclet.ui.preview

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.layout.DocumentIds
import tech.jensk.synclet.provider.ProviderContract

fun providerUri(accountKey: String, itemId: String): Uri =
    DocumentsContract.buildDocumentUri(ProviderContract.AUTHORITY, DocumentIds.of(accountKey, itemId))

fun shareFile(context: Context, accountKey: String, item: SyncItem) {
    val uri = providerUri(accountKey, item.id)
    val send = Intent(Intent.ACTION_SEND).setType(item.mime ?: "application/octet-stream")
        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    send.clipData = ClipData.newRawUri(item.name, uri)
    context.startActivity(Intent.createChooser(send, item.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** "Open with…": the file is in the FileCache already, so the provider answers from it immediately. */
fun openWith(context: Context, accountKey: String, item: SyncItem): Boolean = try {
    context.startActivity(
        Intent(Intent.ACTION_VIEW).setDataAndType(providerUri(accountKey, item.id), item.mime ?: "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    true
} catch (e: ActivityNotFoundException) {
    false
}
