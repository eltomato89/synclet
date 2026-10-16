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
    fun parse(intent: Intent): SharePayload {
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }.ifEmpty { intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty() }
        if (uris.isNotEmpty()) return SharePayload.Files(uris)
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!text.isNullOrBlank()) return SharePayload.Text(text, intent.getStringExtra(Intent.EXTRA_SUBJECT))
        return SharePayload.Empty
    }
}
