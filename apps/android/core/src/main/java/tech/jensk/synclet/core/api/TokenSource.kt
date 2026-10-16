package tech.jensk.synclet.core.api

import okhttp3.Request

/** Supplies the device token of one account and learns about rejected tokens. */
interface TokenSource {
    fun token(): String?

    /** Called once per `401` with the token the failed request was sent with. */
    fun onUnauthorized(sentToken: String, error: SyncError.Http)
}

/** A token that never changes (tests, one-off calls); `401`s are ignored. */
class FixedTokenSource(private val value: String?) : TokenSource {
    override fun token(): String? = value
    override fun onUnauthorized(sentToken: String, error: SyncError.Http) {}
}

/** A request that already carries the bearer [token]. */
data class SignedRequest(val request: Request, val token: String)
