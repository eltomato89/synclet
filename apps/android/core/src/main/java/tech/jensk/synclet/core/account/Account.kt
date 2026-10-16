package tech.jensk.synclet.core.account

import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import tech.jensk.synclet.core.api.SyncAccount
import tech.jensk.synclet.core.api.SyncSpace

@Serializable
data class Account(
    val key: String,                 // SyncAccount.organizationId
    val serverUrl: String,           // origin without trailing slash
    val userId: String,
    val username: String,
    val displayName: String,
    val email: String? = null,
    val spaces: List<SyncSpace> = emptyList(),
    val quotaBytes: Long = 0,
    val usedBytes: Long = 0,
    val maxUploadBytes: Long = 0,
    val needsSignIn: Boolean = false,
    val addedAt: Long = 0,
) {
    val origin: HttpUrl get() = serverUrl.toHttpUrl()
    val host: String get() = origin.let { if (it.port == HttpUrl.defaultPort(it.scheme)) it.host else "${it.host}:${it.port}" }
    val title: String get() = "$username@$host"

    companion object {
        fun from(origin: HttpUrl, account: SyncAccount, now: Long): Account = Account(
            key = account.organizationId,
            serverUrl = origin.toString().trimEnd('/'),
            userId = account.userId,
            username = account.slug,
            displayName = account.displayName,
            email = account.email,
            spaces = account.spaces,
            quotaBytes = account.quotaBytes,
            usedBytes = account.usedBytes,
            maxUploadBytes = account.maxUploadBytes,
            addedAt = now,
        )
    }
}
