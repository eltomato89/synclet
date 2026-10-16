package tech.jensk.synclet.core.api

import tech.jensk.synclet.core.api.NameRules.Problem.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NameRulesTest {
    @Test fun checks() {
        assertEquals(EMPTY, NameRules.check(""))
        assertEquals(DOT, NameRules.check(".."))
        assertEquals(FORBIDDEN_CHARACTER, NameRules.check("a/b"))
        assertEquals(FORBIDDEN_CHARACTER, NameRules.check("a\u0001"))
        assertEquals(TRAILING_SPACE_OR_DOT, NameRules.check("a."))
        assertEquals(TRAILING_SPACE_OR_DOT, NameRules.check("a "))
        assertEquals(RESERVED, NameRules.check("com1.txt"))
        assertEquals(TOO_LONG, NameRules.check("ü".repeat(128)))
        assertEquals(IGNORED, NameRules.check("Thumbs.db"))
        assertEquals(IGNORED, NameRules.check("._x"))
        assertEquals(IGNORED, NameRules.check("~\$doc.docx"))
        assertNull(NameRules.check("Bericht 2026.pdf"))
    }
    @Test fun sanitizes() = assertEquals("a_b", NameRules.sanitize("a:b"))
}
