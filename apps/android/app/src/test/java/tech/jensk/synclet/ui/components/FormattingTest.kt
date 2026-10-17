package tech.jensk.synclet.ui.components

import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FormattingTest {
    @Test fun bytes() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("1,5 KB", formatBytes(1536, Locale.GERMANY))
        assertEquals("5.0 MB", formatBytes(5L shl 20, Locale.US))
    }

    @Test fun date() {
        val text = formatDate("2026-10-16T08:00:00.000Z", Locale.GERMANY, ZoneId.of("Europe/Berlin"))
        assertTrue(text, text.contains("16.10.2026"))
        assertTrue(text, text.contains("10:00"))
    }

    @Test fun invalidDateIsReturnedAsIs() {
        assertEquals("nope", formatDate("nope"))
    }
}
