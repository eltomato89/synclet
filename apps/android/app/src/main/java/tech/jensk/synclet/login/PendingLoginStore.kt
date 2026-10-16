package tech.jensk.synclet.login

import java.io.File
import kotlinx.serialization.Serializable
import tech.jensk.synclet.core.api.SyncJson

@Serializable
data class PendingLogin(val origin: String, val verifier: String, val state: String, val loginHint: String? = null, val createdAt: Long)

/** PKCE values of a running browser login, kept in `noBackupFilesDir` so a redirect into a new process still completes. */
class PendingLoginStore(private val file: File, private val clock: () -> Long = System::currentTimeMillis) {
    fun save(login: PendingLogin) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(SyncJson.encodeToString(PendingLogin.serializer(), login))
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    /** The pending login, once; null when none, expired (10 min) or unreadable. */
    fun consume(): PendingLogin? {
        val login = runCatching { SyncJson.decodeFromString(PendingLogin.serializer(), file.readText()) }.getOrNull()
        file.delete()
        return login?.takeIf { clock() - it.createdAt in 0..TTL_MS }
    }

    companion object { const val TTL_MS = 10 * 60_000L }
}
