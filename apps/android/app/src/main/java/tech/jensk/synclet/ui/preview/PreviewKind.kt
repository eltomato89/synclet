package tech.jensk.synclet.ui.preview

import tech.jensk.synclet.core.api.SyncItem

enum class PreviewKind {
    IMAGE, VIDEO, AUDIO, PDF, TEXT, OTHER;

    companion object {
        fun of(item: SyncItem): PreviewKind = when (item.preview?.kind) {
            "image" -> IMAGE
            "video" -> VIDEO
            "audio" -> AUDIO
            "pdf" -> PDF
            "text", "markdown", "code" -> TEXT
            else -> item.mime.orEmpty().let { m ->
                when {
                    m.startsWith("image/") -> IMAGE
                    m.startsWith("video/") -> VIDEO
                    m.startsWith("audio/") -> AUDIO
                    m == "application/pdf" -> PDF
                    m.startsWith("text/") -> TEXT
                    else -> OTHER
                }
            }
        }
    }
}
