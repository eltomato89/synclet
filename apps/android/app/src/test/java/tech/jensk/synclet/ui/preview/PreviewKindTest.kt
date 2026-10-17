package tech.jensk.synclet.ui.preview

import org.junit.Assert.assertEquals
import org.junit.Test
import tech.jensk.synclet.core.api.PreviewInfo
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.fileItem

class PreviewKindTest {
    private fun item(kind: String?, mime: String?) = fileItem(F1, "x").copy(
        preview = kind?.let { PreviewInfo(kind = it) }, mime = mime,
    )

    @Test fun previewKindWins() {
        assertEquals(PreviewKind.IMAGE, PreviewKind.of(item("image", null)))
        assertEquals(PreviewKind.VIDEO, PreviewKind.of(item("video", null)))
        assertEquals(PreviewKind.AUDIO, PreviewKind.of(item("audio", null)))
        assertEquals(PreviewKind.PDF, PreviewKind.of(item("pdf", null)))
    }

    @Test fun textLikeKindsAreText() {
        for (k in listOf("text", "markdown", "code")) assertEquals(PreviewKind.TEXT, PreviewKind.of(item(k, "application/octet-stream")))
    }

    @Test fun noneOrMissingPreviewFallsBackToMime() {
        for (k in listOf("none", null)) {
            assertEquals(PreviewKind.IMAGE, PreviewKind.of(item(k, "image/heic")))
            assertEquals(PreviewKind.VIDEO, PreviewKind.of(item(k, "video/mp4")))
            assertEquals(PreviewKind.AUDIO, PreviewKind.of(item(k, "audio/mpeg")))
            assertEquals(PreviewKind.PDF, PreviewKind.of(item(k, "application/pdf")))
            assertEquals(PreviewKind.TEXT, PreviewKind.of(item(k, "text/csv")))
            assertEquals(PreviewKind.OTHER, PreviewKind.of(item(k, "application/zip")))
            assertEquals(PreviewKind.OTHER, PreviewKind.of(item(k, null)))
        }
    }
}
