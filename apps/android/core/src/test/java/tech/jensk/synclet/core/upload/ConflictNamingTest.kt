package tech.jensk.synclet.core.upload

import java.time.ZoneOffset
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConflictNamingTest {
    private val t = ZonedDateTime.of(2026, 10, 16, 9, 5, 0, 0, ZoneOffset.UTC)
    @Test fun formatsLikeTheContract() {
        assertEquals("Bericht (Konflikt Pixel 9 2026-10-16 09-05).docx", ConflictNaming.name("Bericht.docx", "Pixel 9", "Konflikt", t))
        assertEquals("a.tar (Conflict Pixel 2026-10-16 09-05).gz", ConflictNaming.name("a.tar.gz", "Pixel", "Conflict", t))
        assertEquals(".env (Konflikt X 2026-10-16 09-05)", ConflictNaming.name(".env", "X", "Konflikt", t))
        assertEquals("README (Konflikt X 2026-10-16 09-05)", ConflictNaming.name("README", "X", "Konflikt", t))
    }
    @Test fun deviceNameIsSanitised() {
        assertEquals("a-b-c", ConflictNaming.sanitizedDevice(" a/b:c "))
        assertEquals("Android", ConflictNaming.sanitizedDevice("  "))
    }
    @Test fun staysWithin255Bytes() {
        val name = ConflictNaming.name("ü".repeat(200) + ".txt", "Pixel", "Konflikt", t)
        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 255)
        assertTrue(name.endsWith(" (Konflikt Pixel 2026-10-16 09-05).txt"))
    }
}
