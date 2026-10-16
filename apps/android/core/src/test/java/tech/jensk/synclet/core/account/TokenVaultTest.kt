package tech.jensk.synclet.core.account

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import tech.jensk.synclet.core.api.shortKey
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

    @Test fun failedDecryptDoesNotDropATokenSavedMeanwhile() = runBlocking {
        val dataStore = store()
        val good = SoftwareTokenCrypto(key())
        TokenVault(dataStore, SoftwareTokenCrypto(key())).save("srv:u1", "syd_old")   // key since lost
        lateinit var vault: TokenVault
        val racing = object : TokenCrypto {
            override fun encrypt(plain: ByteArray, aad: ByteArray) = good.encrypt(plain, aad)
            override fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
                // A re-sign-in stores the new token while this load is still failing on the old one.
                runBlocking { vault.save("srv:u1", "syd_new") }
                return good.decrypt(blob, aad)                                        // old blob: fails
            }
        }
        vault = TokenVault(dataStore, racing)
        assertNull(vault.load("srv:u1"))
        assertEquals("syd_new", TokenVault(dataStore, good).load("srv:u1"))
    }

    @Test fun failingDeleteOfAnUndecryptableTokenDoesNotEscape() = runBlocking {
        val crypto = SoftwareTokenCrypto(key())
        val blob = java.util.Base64.getEncoder().encodeToString(
            SoftwareTokenCrypto(key()).encrypt("syd_old".toByteArray(), "srv:u1".toByteArray()))
        val prefs = mutablePreferencesOf(stringPreferencesKey("t.${shortKey("srv:u1")}") to blob)
        val broken = object : DataStore<Preferences> {
            override val data: Flow<Preferences> = flowOf(prefs)
            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences =
                throw IOException("disk full")
        }
        assertNull(TokenVault(broken, crypto).load("srv:u1"))
    }

    @Test fun ciphertextIsBoundToItsAccount() {
        val crypto = SoftwareTokenCrypto(key())
        val blob = crypto.encrypt("syd_a".toByteArray(), "srv:u1".toByteArray())
        assertThrows(GeneralSecurityException::class.java) { crypto.decrypt(blob, "srv:u2".toByteArray()) }
    }
}
