package tech.jensk.synclet.core.api

import java.io.File
import java.security.MessageDigest

fun sha256Hex(text: String): String = hex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))

fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
    }
    return hex(digest.digest())
}

/** Short, file-system safe account key (directory names, work names, preference keys). */
fun shortKey(accountKey: String): String = sha256Hex(accountKey).take(16)

private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
