package tech.jensk.synclet.share

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

sealed interface SharePayload {
    data class Files(val uris: List<Uri>) : SharePayload
    data class Text(val text: String, val subject: String?) : SharePayload
    data object Empty : SharePayload
}

object ShareIntentParser {
    private const val OWN_PACKAGE = "tech.jensk.synclet"

    /** Only `content://` URIs of other apps: `file://` and our own providers would expose private app data. */
    fun isAcceptable(uri: Uri, ownPackage: String = OWN_PACKAGE): Boolean {
        if (!"content".equals(uri.scheme, ignoreCase = true)) return false
        val authority = uri.authority?.lowercase() ?: return false
        val own = ownPackage.lowercase()
        return !(authority == own || authority.startsWith(own) || authority.substringAfterLast('@').let { it == own || it.startsWith(own) })
    }

    fun parse(intent: Intent, ownPackage: String = OWN_PACKAGE): SharePayload {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return SharePayload.Empty
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }.filter { isAcceptable(it, ownPackage) }.ifEmpty {
            intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty()
                .filter { isAcceptable(it, ownPackage) }
        }
        if (uris.isNotEmpty()) return SharePayload.Files(uris)
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!text.isNullOrBlank()) return SharePayload.Text(text, intent.getStringExtra(Intent.EXTRA_SUBJECT))
        return SharePayload.Empty
    }
}
