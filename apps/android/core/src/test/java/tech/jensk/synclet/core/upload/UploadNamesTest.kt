package tech.jensk.synclet.core.upload

import java.time.ZoneOffset
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadNamesTest {
    private val t = ZonedDateTime.of(2026, 10, 16, 12, 30, 0, 0, ZoneOffset.UTC)
    private val ext = { mime: String -> mapOf("image/jpeg" to "jpg", "application/pdf" to "pdf", "text/plain" to "txt")[mime] }
    private fun name(display: String?, mime: String?) = UploadNames.forShared(display, mime, t, "Upload", ext)

    @Test fun missingNameGetsTimestampAndExtension() = assertEquals("Upload 2026-10-16 12-30-00.jpg", name(null, "image/jpeg"))
    @Test fun forbiddenCharactersAreReplaced() = assertEquals("a_b_.txt", name("a:b?.txt", "text/plain"))
    @Test fun pathLikeNamesKeepTheLastSegment() = assertEquals("scan.pdf", name("content/docs/scan.pdf", null))
    @Test fun extensionIsAddedFromMime() = assertEquals("report.pdf", name("report", "application/pdf"))
    @Test fun existingNameIsKept() = assertEquals("photo.jpg", name("photo.jpg", "image/jpeg"))
    @Test fun trailingDotsAndSpacesAreTrimmed() = assertEquals("name.txt", name("name. ", "text/plain"))
    @Test fun reservedAndIgnoredNamesArePrefixed() {
        assertEquals("_CON.txt", name("CON.txt", null))
        assertEquals("_Thumbs.db", name("Thumbs.db", null))
        assertEquals("_.DS_Store", name(".DS_Store", null))
    }
    @Test fun longNamesAreCutTo255BytesKeepingTheExtension() {
        val n = name("x".repeat(300) + ".txt", null)
        assertEquals(255, n.toByteArray().size); assertTrue(n.endsWith(".txt"))
    }
    @Test fun controlCharactersAreReplaced() = assertEquals("a_b.txt", name("a\u0007b.txt", null))
    @Test fun dotOnlyNamesFallBack() = assertEquals("Upload 2026-10-16 12-30-00.pdf", name("..", "application/pdf"))
    @Test fun longMultibyteNamesAreNotSplitInsideASurrogatePair() {
        val n = name("😀".repeat(100) + ".txt", null)
        assertTrue(n.toByteArray().size <= 255); assertTrue(n.endsWith(".txt"))
        assertEquals(n, String(n.toByteArray(), Charsets.UTF_8))
        assertTrue(n.removeSuffix(".txt").chunked(2).all { it == "😀" })
    }
}
