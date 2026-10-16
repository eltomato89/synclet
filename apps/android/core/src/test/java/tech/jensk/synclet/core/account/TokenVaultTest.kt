package tech.jensk.synclet.core.account

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TokenVaultTest {
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    @After fun tearDown() { scope.cancel() }

    private fun store(name: String = "tokens") =
        PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "$name.preferences_pb") })
    private fun key() = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test fun roundTripAndDelete() = runBlocking {
        val vault = TokenVault(store(), SoftwareTokenCrypto(key()))
        vault.save("srv:u1", "syd_secret")
        assertEquals("syd_secret", vault.load("srv:u1"))
        assertNull(vault.load("srv:u2"))
        vault.delete("srv:u1")
        assertNull(vault.load("srv:u1"))
    }

    @Test fun undecryptableTokenReadsAsMissing() = runBlocking {
        val dataStore = store()
        TokenVault(dataStore, SoftwareTokenCrypto(key())).save("srv:u1", "syd_secret")
        val other = TokenVault(dataStore, SoftwareTokenCrypto(key()))   // the Keystore key is gone
        assertNull(other.load("srv:u1"))
        assertNull(other.load("srv:u1"))                                  // entry was dropped, no second failure
    }

    @Test fun ciphertextIsBoundToItsAccount() {
        val crypto = SoftwareTokenCrypto(key())
        val blob = crypto.encrypt("syd_a".toByteArray(), "srv:u1".toByteArray())
        assertThrows(GeneralSecurityException::class.java) { crypto.decrypt(blob, "srv:u2".toByteArray()) }
    }
}
