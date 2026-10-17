package tech.jensk.synclet.core.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** PKCE values for the browser login (SYNC_API §2.1, RFC 7636 S256). */
object Pkce {
    data class Values(val verifier: String, val challenge: String, val state: String)

    fun create(random: SecureRandom = SecureRandom()): Values {
        val verifier = base64Url(ByteArray(32).also(random::nextBytes))
        return Values(verifier, challenge(verifier), base64Url(ByteArray(16).also(random::nextBytes)))
    }

    fun challenge(verifier: String): String =
        base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    private fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
