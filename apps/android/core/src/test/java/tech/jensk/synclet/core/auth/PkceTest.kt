package tech.jensk.synclet.core.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PkceTest {
    @Test fun challengeMatchesRfc7636AppendixB() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }
    @Test fun valuesHaveContractLengthsAndAlphabet() {
        val v = Pkce.create()
        assertEquals(43, v.verifier.length)
        assertEquals(43, v.challenge.length)
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(v.verifier))
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(v.state))
        assertNotEquals(Pkce.create().state, v.state)
    }
}
