package tech.jensk.synclet.core.account

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import tech.jensk.synclet.core.api.shortKey

/** Device tokens, encrypted ([TokenCrypto]) and bound to their account (AAD = account key). Create once per process. */
class TokenVault(private val store: DataStore<Preferences>, private val crypto: TokenCrypto) {
    private fun prefKey(accountKey: String) = stringPreferencesKey("t.${shortKey(accountKey)}")

    suspend fun save(accountKey: String, token: String) {
        val blob = crypto.encrypt(token.toByteArray(Charsets.UTF_8), accountKey.toByteArray(Charsets.UTF_8))
        store.edit { it[prefKey(accountKey)] = Base64.getEncoder().encodeToString(blob) }
    }

    /** The token, or null when none is stored or it cannot be decrypted any more (the entry is then dropped). */
    suspend fun load(accountKey: String): String? {
        val encoded = store.data.first()[prefKey(accountKey)] ?: return null
        return try {
            String(crypto.decrypt(Base64.getDecoder().decode(encoded), accountKey.toByteArray(Charsets.UTF_8)), Charsets.UTF_8)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("SyncletVault", "token of an account cannot be decrypted (${e.javaClass.simpleName}); sign-in required")
            dropIfUnchanged(accountKey, encoded)
            null
        }
    }

    /**
     * Compare-and-delete: removes the entry only while it still holds [failed] – a token saved meanwhile (re-sign-in)
     * survives. Best effort: a failing write leaves the entry, which then simply fails again on the next load.
     */
    private suspend fun dropIfUnchanged(accountKey: String, failed: String) {
        try {
            store.edit { if (it[prefKey(accountKey)] == failed) it.remove(prefKey(accountKey)) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("SyncletVault", "could not drop an undecryptable token (${e.javaClass.simpleName})")
        }
    }

    suspend fun delete(accountKey: String) {
        store.edit { it.remove(prefKey(accountKey)) }
    }

    companion object {
        fun create(context: Context): TokenVault = TokenVault(
            PreferenceDataStoreFactory.create(produceFile = { context.preferencesDataStoreFile("tokens") }),
            KeystoreTokenCrypto(),
        )
    }
}
