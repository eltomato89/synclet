package tech.jensk.synclet.core.account

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.TokenSource

/**
 * The device token of one account and its "sign in again" state. One lock per account serialises the
 * transition: concurrent 401s flag the account once, and a 401 of a request that still carried the
 * previous token never flags an account that was just signed in again.
 */
class AccountTokens(
    val accountKey: String,
    initial: String?,
    private val onSignInRequired: (accountKey: String, error: SyncError.Http?) -> Unit,
) : TokenSource {
    private val lock = ReentrantLock()
    @Volatile private var current: String? = initial
    @Volatile var signInRequired: Boolean = initial == null
        private set

    override fun token(): String? = if (signInRequired) null else current

    override fun onUnauthorized(sentToken: String, error: SyncError.Http) {
        val notify = lock.withLock {
            if (signInRequired || sentToken != current) false else { signInRequired = true; true }
        }
        if (notify) onSignInRequired(accountKey, error)
    }

    fun replace(newToken: String) = lock.withLock { current = newToken; signInRequired = false }

    fun clear() = lock.withLock { current = null; signInRequired = true }
}
