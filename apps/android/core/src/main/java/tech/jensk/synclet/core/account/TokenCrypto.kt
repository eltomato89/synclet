package tech.jensk.synclet.core.account

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface TokenCrypto {
    fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray
}

/** AES-256-GCM with a non-exportable key in the Android Keystore; blob = 12-byte IV + ciphertext. */
class KeystoreTokenCrypto(private val alias: String = "synclet.tokens.v1") : TokenCrypto {
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
    override fun encrypt(plain: ByteArray, aad: ByteArray) = AesGcm.encrypt(key(), plain, aad)
    override fun decrypt(blob: ByteArray, aad: ByteArray) = AesGcm.decrypt(key(), blob, aad)
}

/** Same format with a software key – JVM tests. */
class SoftwareTokenCrypto(private val key: SecretKey) : TokenCrypto {
    override fun encrypt(plain: ByteArray, aad: ByteArray) = AesGcm.encrypt(key, plain, aad)
    override fun decrypt(blob: ByteArray, aad: ByteArray) = AesGcm.decrypt(key, blob, aad)
}

internal object AesGcm {
    private const val IV = 12
    fun encrypt(key: SecretKey, plain: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)               // random IV from the provider
        cipher.updateAAD(aad)
        return cipher.iv + cipher.doFinal(plain)
    }
    fun decrypt(key: SecretKey, blob: ByteArray, aad: ByteArray): ByteArray {
        require(blob.size > IV) { "blob too short" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob, 0, IV))
        cipher.updateAAD(aad)
        return cipher.doFinal(blob, IV, blob.size - IV)
    }
}
