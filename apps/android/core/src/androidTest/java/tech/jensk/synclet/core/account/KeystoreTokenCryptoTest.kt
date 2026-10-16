package tech.jensk.synclet.core.account

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KeystoreTokenCryptoTest {
    private val alias = "synclet.tokens.test-${UUID.randomUUID()}"
    private val crypto = KeystoreTokenCrypto(alias)

    @After fun cleanUp() {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    @Test fun roundTrip() {
        val blob = crypto.encrypt("syd_secret".toByteArray(), "srv:u1".toByteArray())
        assertArrayEquals("syd_secret".toByteArray(), crypto.decrypt(blob, "srv:u1".toByteArray()))
    }

    @Test fun wrongAadThrows() {
        val blob = crypto.encrypt("syd_secret".toByteArray(), "srv:u1".toByteArray())
        assertThrows(GeneralSecurityException::class.java) { crypto.decrypt(blob, "srv:u2".toByteArray()) }
    }
}
